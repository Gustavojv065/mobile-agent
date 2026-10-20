import { tool } from "ai";
import { z } from "zod";

import { createExternalFolderService } from "@/core/services/external-folder/external-folder-service";
import { createRecord, summarizeValue, TOOL_PREVIEW_TEXT_LIMIT } from "@/modules/tools/built-in/shared";
import type { ExternalFolderToolFactoryParams } from "@/modules/tools/built-in/external-folder/types";

export function createListDirectoryTool({
  onRecord,
  session,
}: ExternalFolderToolFactoryParams) {
  const service = createExternalFolderService();

  return tool({
    description: "List files and folders inside the granted external folder.",
    inputSchema: z.object({
      path: z.string().trim().optional(),
    }),
    execute: async ({ path }) => {
      const inputSummary = summarizeValue({ path: path ?? "" });

      try {
        const entries = service.listEntries(session, path ?? "");
        const output = { entries };
        const previewText = entries.map((entry) => entry.path).join("\n");

        onRecord?.(
          createRecord({
            toolName: "listDirectory",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue(output),
            preview: {
              title: `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`,
              text: previewText.slice(0, TOOL_PREVIEW_TEXT_LIMIT),
              truncated: previewText.length > TOOL_PREVIEW_TEXT_LIMIT,
            },
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "listDirectory",
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
