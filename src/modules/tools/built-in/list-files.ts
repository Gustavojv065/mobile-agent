import { tool } from "ai";
import { z } from "zod";

import { createRecord, summarizeValue, TOOL_PREVIEW_TEXT_LIMIT } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { isTextWorkspaceFile } from "@/core/services/workspace-file-service";

/**
 * Cap on what one call returns, mirroring glob's DEFAULT_MAX_RESULTS, so a
 * workspace with thousands of files cannot flood the model context. `total`
 * always reports the real count, which keeps "the workspace is empty" and
 * "this is a long list" distinguishable.
 */
const MAX_LISTED_FILES = 100;
/** Names kept in the persisted JSON trace summary (it is capped at 240 chars). */
const SUMMARY_NAME_COUNT = 6;

export function createListFilesTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  return tool({
    description:
      "List the files available in the shared workspace. It takes no input and never filters: it returns up to 100 files (id, displayName, mimeType, size, isText) plus total, the real number of workspace files, and truncated when there are more. An empty files array therefore means the workspace genuinely has no files. Use glob to narrow by name pattern and grep to search file contents. Read-only.",
    inputSchema: z.object({}),
    execute: async () => {
      const inputSummary = summarizeValue({});

      try {
        const files = await repository.list();
        const listed = files.slice(0, MAX_LISTED_FILES);
        const output = {
          total: files.length,
          returned: listed.length,
          truncated: listed.length < files.length,
          files: listed.map((file) => ({
            id: file.id,
            displayName: file.displayName,
            mimeType: file.mimeType,
            size: file.size,
            isText: isTextWorkspaceFile(file),
          })),
        };
        const names = output.files.map((file) => file.displayName);
        const previewText = names.join("\n");

        onRecord?.(
          createRecord({
            toolName: "listFiles",
            status: "completed",
            inputSummary,
            // Scalars first: when the 240-char cap cuts this JSON mid-object,
            // the renderer still recovers total/returned/truncated.
            outputSummary: summarizeValue({
              total: output.total,
              returned: output.returned,
              truncated: output.truncated,
              files: names.slice(0, SUMMARY_NAME_COUNT),
            }),
            preview: {
              title: `${output.total} ${output.total === 1 ? "file" : "files"}`,
              text: previewText.slice(0, TOOL_PREVIEW_TEXT_LIMIT),
              truncated:
                output.truncated || previewText.length > TOOL_PREVIEW_TEXT_LIMIT,
            },
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "listFiles",
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
