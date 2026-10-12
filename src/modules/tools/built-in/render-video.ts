import { File } from "expo-file-system";
import { tool } from "ai";
import { z } from "zod";

import type { WorkspaceRepository } from "@/core/db/database";
import { createWorkspaceFileService } from "@/core/services/workspace-file-service";
import { requestVideoRender } from "@/modules/preview/video-render";
import {
  createRecord,
  summarizeValue,
} from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";

const MAX_HTML_CHARS = 2_000_000;

/**
 * Renders a self-contained HTML document (the `window.MOBILE_AGENT_VIDEO`
 * contract) into an MP4 and stores it in the workspace so the user gets the
 * finished file directly in the conversation.
 *
 * The actual recording happens in the app-level hidden WebView host; this tool
 * just hands the document over and waits for the encoded file.
 */
export function createRenderVideoTool({
  onProgress,
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);
  return tool({
    description:
      "Render a self-contained HTML document into an MP4 video and deliver the finished file to the user. The document must define window.MOBILE_AGENT_VIDEO = { duration, fps, width, height, canvasId?, render(t, canvas, ctx) } and draw its animation on a single <canvas>; see the html-video skill for the full contract. Pass the complete HTML either inline as `html` or point at an existing HTML workspace file with `fileId`. Rendering is real time: a 10 second video takes about 10 seconds, so do not call this repeatedly. Returns the saved MP4 as a workspace file for the user. After the tool returns, embed the video inline in your response exactly where you discuss it with ![displayName](workspace://fileId) using the returned fileId, so it renders as a playable in-chat video — do not paste a bare workspace:// link and do not rely on an end-of-message card.",
    inputSchema: z.object({
      html: z
        .string()
        .min(1)
        .max(MAX_HTML_CHARS)
        .optional()
        .describe(
          "The complete self-contained HTML document implementing the MOBILE_AGENT_VIDEO contract.",
        ),
      fileId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Alternatively, the id of an existing workspace .html file to render.",
        ),
      name: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("Output file name (a .mp4 extension is added if missing)."),
    }),
    execute: async ({ html, fileId, name }, { abortSignal }) => {
      const inputSummary = summarizeValue({
        hasHtml: Boolean(html),
        fileId: fileId ?? null,
        name: name ?? null,
      });

      try {
        const documentHtml = await resolveHtml({
          fileId,
          html,
          repository,
          workspaceService,
        });

        if (!documentHtml.includes("MOBILE_AGENT_VIDEO")) {
          throw new Error(
            "The HTML is missing the window.MOBILE_AGENT_VIDEO contract, so there is nothing to record.",
          );
        }

        const result = await requestVideoRender(documentHtml, {
          signal: abortSignal,
          onProgress: (progress) =>
            onProgress?.({
              bytesWritten: Math.round(Math.max(0, Math.min(1, progress)) * 100),
              totalBytes: 100,
            }),
        });

        const cacheFile = new File(result.uri);
        const bytes = await cacheFile.bytes();

        const file = await workspaceService.createDocumentFile({
          bytes,
          mimeType: "video/mp4",
          name: normalizeName(name),
        });

        try {
          cacheFile.delete();
        } catch {
          // The cache copy is best-effort; the OS reclaims cache anyway.
        }

        const output = {
          fileId: file.id,
          displayName: file.displayName,
          link: `workspace://${file.id}`,
          mimeType: "video/mp4",
          size: file.size,
        };

        onRecord?.(
          createRecord({
            toolName: "renderVideo",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue(output),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "renderVideo",
            status: "failed",
            inputSummary,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }
    },
  });
}

async function resolveHtml({
  fileId,
  html,
  repository,
  workspaceService,
}: {
  fileId: string | undefined;
  html: string | undefined;
  repository: WorkspaceRepository;
  workspaceService: ReturnType<typeof createWorkspaceFileService>;
}) {
  if (html && html.trim().length > 0) {
    return html;
  }

  if (!fileId) {
    throw new Error(
      "Provide the HTML document to render, either inline as `html` or as an existing `fileId`.",
    );
  }

  const file = await repository.getById(fileId);
  if (!file) {
    throw new Error(`No workspace file found with id ${fileId}.`);
  }

  return workspaceService.readTextFile(file);
}

function normalizeName(name: string | undefined) {
  const base = (name ?? `video-${Date.now()}`).trim() || `video-${Date.now()}`;
  return /\.mp4$/i.test(base) ? base : `${base}.mp4`;
}
