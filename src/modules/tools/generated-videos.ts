import type { GeneratedVideoAttachment } from "@/core/types/app-state";

type ToolResultLike = {
  type?: string;
  toolName?: string;
  output?: unknown;
};

/**
 * Extracts the workspace MP4s produced by `renderVideo` tool calls so they can
 * be attached to the assistant message and shown as in-chat video cards.
 *
 * The tool already persisted the file, so this only reshapes the returned
 * metadata; it never touches the filesystem.
 */
export function collectGeneratedVideos(
  toolResults: readonly ToolResultLike[] | undefined,
): GeneratedVideoAttachment[] {
  if (!toolResults || toolResults.length === 0) {
    return [];
  }

  const videos: GeneratedVideoAttachment[] = [];
  const seen = new Set<string>();

  for (const result of toolResults) {
    if (result.type !== "tool-result" || result.toolName !== "renderVideo") {
      continue;
    }

    const output = result.output as
      | {
          fileId?: unknown;
          displayName?: unknown;
          link?: unknown;
          mimeType?: unknown;
          size?: unknown;
        }
      | null
      | undefined;

    if (!output || typeof output.fileId !== "string" || !output.fileId) {
      continue;
    }

    if (seen.has(output.fileId)) {
      continue;
    }

    seen.add(output.fileId);
    videos.push({
      fileId: output.fileId,
      displayName:
        typeof output.displayName === "string" && output.displayName
          ? output.displayName
          : `${output.fileId}.mp4`,
      mimeType:
        typeof output.mimeType === "string" && output.mimeType
          ? output.mimeType
          : "video/mp4",
      size: typeof output.size === "number" ? output.size : 0,
      uri:
        typeof output.link === "string" && output.link
          ? output.link
          : `workspace://${output.fileId}`,
    });
  }

  return videos;
}
