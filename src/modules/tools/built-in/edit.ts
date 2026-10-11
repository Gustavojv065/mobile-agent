import { tool } from "ai";
import { z } from "zod";

import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { applyTextEdits } from "@/modules/tools/built-in/edits";
import {
  createWorkspaceFileService,
  isDocumentWorkspaceFile,
  isTextWorkspaceFile,
} from "@/core/services/workspace-file-service";
import { getDocumentFormat } from "@/modules/documents";

export function createEditTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);

  return tool({
    description:
      "Apply targeted text edits to a workspace file. Each edit must be unique in the file; read the file first and include enough surrounding text. Set replaceAll to true to replace every occurrence of oldText. For documents (docx, pdf, pptx, xlsx) the edits apply to the document's stored source Markdown and the document is regenerated from it; read returns the editable source as sourceMarkdown when available.",
    inputSchema: z.object({
      edits: z
        .array(
          z.object({
            newText: z.string(),
            oldText: z.string(),
            replaceAll: z.boolean().optional(),
          }),
        )
        .min(1),
      fileId: z.string().min(1),
    }),
    execute: async ({ edits, fileId }) => {
      const inputSummary = summarizeValue({
        edits: edits.map((edit) => ({
          newTextLength: edit.newText.length,
          oldTextLength: edit.oldText.length,
          replaceAll: edit.replaceAll ?? false,
        })),
        fileId,
      });

      try {
        const file = await repository.getById(fileId);

        if (!file) {
          throw new Error(`No workspace file found for ${fileId}.`);
        }

        if (!isTextWorkspaceFile(file) && !isDocumentWorkspaceFile(file)) {
          throw new Error(`${file.displayName} is not an editable file.`);
        }

        if (isDocumentWorkspaceFile(file)) {
          if (!file.sourceMarkdown) {
            throw new Error(
              `${file.displayName} has no stored source to edit. Documents without editable source can still be replaced: read the file, then call updateDocument with the full new content.`,
            );
          }

          const result = applyTextEdits(file.sourceMarkdown, edits);
          const nextFile = await workspaceService.updateDocumentFile(
            file,
            result.content,
          );

          const output = {
            displayName: nextFile.displayName,
            editsApplied: result.appliedCount,
            fileId,
            format: getDocumentFormat(nextFile.displayName),
            regenerated: true,
            size: nextFile.size,
          };

          onRecord?.(
            createRecord({
              toolName: "edit",
              status: "completed",
              inputSummary,
              outputSummary: summarizeValue(output),
            }),
          );

          return output;
        }

        const current = await workspaceService.readTextFile(file);
        const result = applyTextEdits(current, edits);
        await workspaceService.writeTextFile(file, result.content);

        const output = {
          displayName: file.displayName,
          editsApplied: result.appliedCount,
          fileId,
        };

        onRecord?.(
          createRecord({
            toolName: "edit",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue(output),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "edit",
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
