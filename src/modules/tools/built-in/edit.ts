import { tool } from "ai";
import { z } from "zod";

import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { applyTextEdits } from "@/modules/tools/built-in/edits";
import { buildLineDiff, type LineDiff } from "@/modules/files/line-diff";
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
      // Computed from args up front so the failure path always has it; the
      // display name is filled in once the file is actually loaded.
      let inputSummary = summarizeValue({
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

        inputSummary = summarizeValue({
          displayName: file.displayName,
          edits: edits.map((edit) => ({
            newTextLength: edit.newText.length,
            oldTextLength: edit.oldText.length,
            replaceAll: edit.replaceAll ?? false,
          })),
          fileId,
        });

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
              ...toRecordDiff(buildLineDiff(file.sourceMarkdown, result.content)),
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
            ...toRecordDiff(buildLineDiff(current, result.content)),
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

/** Splits a LineDiff into the record fields for the trace row. */
function toRecordDiff(diff: LineDiff | null) {
  if (!diff) {
    return { diff: null as string | null, diffStat: null as string | null };
  }

  return {
    diff: diff.hunkText,
    diffStat: `+${diff.added} −${diff.removed}`,
  };
}
