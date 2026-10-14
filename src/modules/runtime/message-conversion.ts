import type { ModelMessage } from "ai";

import {
  isDocumentWorkspaceFile,
  isTextWorkspaceFile,
  resolveWorkspaceFile,
} from "@/core/services/workspace-file-service";
import type { MessageRole, StoredMessage, WorkspaceFile } from "@/core/types/app-state";

const IMAGE_MIME_PREFIXES = ["image/"];
const AUDIO_MIME_PREFIXES = ["audio/"];
const VIDEO_MIME_PREFIXES = ["video/"];

function mimeStartsWith(
  mimeType: string | null | undefined,
  prefixes: string[],
) {
  if (!mimeType) {
    return false;
  }

  const lower = mimeType.trim().toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix));
}

export function isImageMimeType(mimeType: string | null | undefined): boolean {
  return mimeStartsWith(mimeType, IMAGE_MIME_PREFIXES);
}

export function isAudioMimeType(mimeType: string | null | undefined): boolean {
  return mimeStartsWith(mimeType, AUDIO_MIME_PREFIXES);
}

export function isVideoMimeType(mimeType: string | null | undefined): boolean {
  return mimeStartsWith(mimeType, VIDEO_MIME_PREFIXES);
}

function isTextFile(file: Pick<WorkspaceFile, "displayName" | "mimeType">) {
  return isTextWorkspaceFile(file) || isDocumentWorkspaceFile(file);
}

export type PartitionedFiles = {
  binaryFiles: WorkspaceFile[];
  imageFiles: WorkspaceFile[];
  textFiles: WorkspaceFile[];
};

export function partitionSelectedFiles(files: WorkspaceFile[]): PartitionedFiles {
  const textFiles: WorkspaceFile[] = [];
  const imageFiles: WorkspaceFile[] = [];
  const binaryFiles: WorkspaceFile[] = [];

  for (const file of files) {
    if (isTextFile(file)) {
      textFiles.push(file);
    } else if (isImageMimeType(file.mimeType)) {
      imageFiles.push(file);
    } else {
      binaryFiles.push(file);
    }
  }

  return { textFiles, imageFiles, binaryFiles };
}

async function buildWorkspaceMediaParts(
  files: WorkspaceFile[],
  fallbackMediaType = "application/octet-stream",
) {
  return Promise.all(
    files.map(async (file) => {
      const localFile = resolveWorkspaceFile(file.relativePath);

      if (!localFile.exists) {
        throw new Error(`${file.displayName} is no longer available locally.`);
      }

      return {
        type: "file" as const,
        filename: file.displayName,
        mediaType: file.mimeType ?? fallbackMediaType,
        data: {
          type: "data" as const,
          data: await localFile.bytes(),
        },
      };
    }),
  );
}

/**
 * Direct model input is capped: huge audio/video payloads blow up request
 * size and context. Larger files stay usable through the transcribeAudio,
 * analyzeAudio, and getVideoFrame tools instead.
 */
export const MAX_DIRECT_MEDIA_BYTES = 25 * 1024 * 1024;

function parseStoredContent(
  message: StoredMessage,
): string | Array<Record<string, unknown>> {
  if (message.content.startsWith("[")) {
    try {
      const parsed = JSON.parse(message.content);

      if (Array.isArray(parsed)) {
        return parsed as Array<Record<string, unknown>>;
      }
    } catch {}
  }

  return message.content;
}

function buildAssistantContent(
  message: StoredMessage,
  parsedContent: string | Record<string, unknown>[],
) {
  const reasoningParts = (message.metadata?.reasoning ?? [])
    .filter((block) => block.text.trim())
    .map((block) => ({
      type: "reasoning",
      text: block.text,
    }));

  if (reasoningParts.length === 0) {
    return parsedContent;
  }

  const content: Record<string, unknown>[] = [...reasoningParts];

  if (typeof parsedContent === "string") {
    if (parsedContent.trim()) {
      content.push({
        type: "text",
        text: parsedContent,
      });
    }
  } else {
    content.push(...parsedContent);
  }

  return content;
}

export async function convertStoredMessagesToModelMessages(input: {
  messages: StoredMessage[];
  supportsImageInput: boolean;
  supportsAudioInput: boolean;
  supportsVideoInput: boolean;
  workspaceFilesById: Map<string, WorkspaceFile>;
}) {
  const converted: ModelMessage[] = [];
  const unsupportedAttachments: WorkspaceFile[] = [];

  for (const message of input.messages.filter(
    (item): item is StoredMessage & { role: MessageRole } =>
      item.role === "assistant" ||
      item.role === "system" ||
      item.role === "user",
  )) {
    const parsedContent = parseStoredContent(message);

    if (message.role === "assistant") {
      converted.push({
        role: message.role,
        content: buildAssistantContent(message, parsedContent),
      } as ModelMessage);
      continue;
    }

    if (message.role === "system") {
      converted.push({
        role: message.role,
        content: parsedContent,
      } as ModelMessage);
      continue;
    }

    const selectedFiles = (message.metadata?.selectedFileIds ?? [])
      .map((fileId) => input.workspaceFilesById.get(fileId))
      .filter((file): file is WorkspaceFile => file !== undefined);
    const { binaryFiles, imageFiles } = partitionSelectedFiles(selectedFiles);
    const audioFiles = binaryFiles.filter((file) =>
      isAudioMimeType(file.mimeType),
    );
    const videoFiles = binaryFiles.filter((file) =>
      isVideoMimeType(file.mimeType),
    );

    if (
      imageFiles.length === 0 &&
      audioFiles.length === 0 &&
      videoFiles.length === 0
    ) {
      converted.push({
        role: message.role,
        content: parsedContent,
      } as ModelMessage);
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];

    if (typeof parsedContent === "string" && parsedContent.trim()) {
      parts.push({
        type: "text",
        text: parsedContent,
      });
    } else if (Array.isArray(parsedContent)) {
      parts.push(...parsedContent);
    }

    if (input.supportsImageInput) {
      parts.push(
        ...(await buildWorkspaceMediaParts(imageFiles, "image/png")),
      );
    } else {
      unsupportedAttachments.push(...imageFiles);
    }

    const sendable = (files: WorkspaceFile[]) =>
      files.filter((file) => (file.size ?? 0) <= MAX_DIRECT_MEDIA_BYTES);
    const oversized = (files: WorkspaceFile[]) =>
      files.filter((file) => (file.size ?? 0) > MAX_DIRECT_MEDIA_BYTES);

    if (input.supportsAudioInput) {
      parts.push(...(await buildWorkspaceMediaParts(sendable(audioFiles))));
      unsupportedAttachments.push(...oversized(audioFiles));
    } else {
      unsupportedAttachments.push(...audioFiles);
    }

    if (input.supportsVideoInput) {
      parts.push(...(await buildWorkspaceMediaParts(sendable(videoFiles))));
      unsupportedAttachments.push(...oversized(videoFiles));
    } else {
      unsupportedAttachments.push(...videoFiles);
    }

    converted.push({
      role: message.role,
      content:
        parts.length === 1 &&
        parts[0]?.type === "text" &&
        typeof parts[0].text === "string"
          ? parts[0].text
          : parts,
    } as ModelMessage);
  }

  return {
    messages: converted,
    unsupportedAttachments,
  };
}
