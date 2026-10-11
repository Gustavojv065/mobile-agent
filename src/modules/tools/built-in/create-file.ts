import { tool } from "ai";
import { z } from "zod";

import { buildDocument } from "@/modules/documents";
import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { createWorkspaceFileService } from "@/core/services/workspace-file-service";

export function createCreateFileTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);

  return tool({
    description:
      "Create a user-visible file in the shared workspace. Use only when the user explicitly asks to create, save, or export a file. Set format to export a document: docx (Word), pdf, pptx (PowerPoint) or xlsx (Excel). Content is Markdown or plain text; Markdown headings become titles/slides, pipe tables become tables, and '---' starts a new page/slide. For text format the name should keep a normal extension; for document formats the matching extension is added automatically. Do not use for scratch work, internal notes, future context, or as a duplicate of a response that belongs in chat. To link the created file in your response, use the returned link as the markdown destination: [displayName](link).",
    inputSchema: z.object({
      name: z.string().min(1),
      content: z.string().default(""),
      format: z.enum(["text", "docx", "pdf", "pptx", "xlsx"]).default("text"),
    }),
    execute: async ({ content, format, name }) => {
      const inputSummary = summarizeValue({
        name,
        format,
        contentPreview: content.slice(0, 200),
      });

      try {
        if (format === "text") {
          const file = await workspaceService.createTextFile({
            name,
            content,
          });
          const output = {
            fileId: file.id,
            displayName: file.displayName,
            link: `workspace://${file.id}`,
            size: file.size,
          };

          onRecord?.(
            createRecord({
              toolName: "createFile",
              status: "completed",
              inputSummary,
              outputSummary: summarizeValue(output),
            }),
          );

          return output;
        }

        const built = await buildDocument({ format, content, fileName: name });
        const file = await workspaceService.createDocumentFile({
          bytes: built.bytes,
          mimeType: built.mimeType,
          name: built.fileName,
          sourceMarkdown: content,
        });
        const output = {
          fileId: file.id,
          displayName: file.displayName,
          link: `workspace://${file.id}`,
          size: file.size,
          format: built.format,
          mimeType: built.mimeType,
        };

        onRecord?.(
          createRecord({
            toolName: "createFile",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue(output),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "createFile",
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
