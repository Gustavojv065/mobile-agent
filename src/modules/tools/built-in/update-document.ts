import { tool } from "ai";
import { z } from "zod";

import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { createWorkspaceFileService } from "@/core/services/workspace-file-service";
import { getDocumentFormat } from "@/modules/documents";

export function createUpdateDocumentTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);

  return tool({
    description:
      "Update an existing document (docx, pdf, pptx, xlsx) in place by replacing its content with new Markdown or plain text. The document keeps its file name and format, and the new source Markdown is stored so the document can be updated again later. Read the document first: read returns its stored source as sourceMarkdown when available, so you can keep the content you intend to preserve. Content rules match createFile: Markdown headings become titles/slides, pipe tables become tables, and a horizontal rule (---) starts a new page or slide.",
    inputSchema: z.object({
      fileId: z.string().min(1),
      content: z.string().min(1),
    }),
    execute: async ({ content, fileId }) => {
      const inputSummary = summarizeValue({
        fileId,
        contentPreview: content.slice(0, 200),
      });

      try {
        const file = await repository.getById(fileId);

        if (!file) {
          throw new Error(`No workspace file found for ${fileId}.`);
        }

        const nextFile = await workspaceService.updateDocumentFile(
          file,
          content,
        );
        const output = {
          fileId: nextFile.id,
          displayName: nextFile.displayName,
          format: getDocumentFormat(nextFile.displayName),
          link: `workspace://${nextFile.id}`,
          size: nextFile.size,
        };

        onRecord?.(
          createRecord({
            toolName: "updateDocument",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue(output),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "updateDocument",
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