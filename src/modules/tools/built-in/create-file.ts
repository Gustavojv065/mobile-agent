import { tool } from "ai";
import { z } from "zod";

import { buildDocument, mergeSpecIntoSource } from "@/modules/documents";
import {
  createRecord,
  summarizeValue,
} from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import {
  createWorkspaceFileService,
  readWorkspaceImageBytes,
} from "@/core/services/workspace-file-service";

export function createCreateFileTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);

  return tool({
    description:
      "Create a user-visible file in the shared workspace. Use only when the user explicitly asks to create, save, or export a file. Set format to export a document: docx (Word), pdf, pptx (PowerPoint) or xlsx (Excel). Content is Markdown or plain text; Markdown headings become titles/slides, pipe tables become tables, and '---' starts a new page/slide. For text format the name should keep a normal extension; for document formats the matching extension is added automatically. Style docx documents with a YAML front-matter block at the top of content, for example: ---\\nformat:\\n  fonts:\\n    body: { family: Georgia, sizePt: 12, color: '#111111' }\\n  header: { text: 'My Report' }\\n  footer: { text: 'Page {PAGE}' }\\n  includeToc: true\\n---\\n Supported docx styling: page size, orientation, margins, fonts, colors, alignment, spacing, per-level heading styles, code and table styles, headers/footers with page numbers, a table of contents, and images via ![alt](workspace-path-or-data-uri) with an optional width: ![alt](images/logo.png). Style xlsx spreadsheets the same way: a format key with sheet options (freezeHeaderRow, freezeColumns, autoFilter, tabColor, orientation, paperSize, merges), header and body cell styles (fonts, fills, borders, alignment, numberFormat such as '#,##0.00' or '0%'), stripes for alternating rows, and columns (per-column width, numberFormat and style overrides). Style pptx presentations the same way: a format key with presentation (layout 16x9/16x10/4x3/wide/custom), theme fonts, background color, cover slide (enabled, title, subtitle), title/body box fonts, colors and positions (xIn/yIn/wIn/hIn), bulleting, code, table styles, footer text and slide numbers. Style pdf documents the same way: a format key with page size/orientation/margins, body/heading/code/table fonts and colors, paragraph spacing and alignment, per-level heading styles, code block colors, list indent, table header/border colors, header/footer text with {PAGE}, and page-number position (pdf uses the standard PDF fonts, approximating families). The spec parameter is an alternative to front-matter; it is merged on top of it and persisted into the stored source so updates keep the styling. Do not use for scratch work, internal notes, future context, or as a duplicate of a response that belongs in chat. To link the created file in your response, use the returned link as the markdown destination: [displayName](link).",
    inputSchema: z.object({
      name: z.string().min(1),
      content: z.string().default(""),
      format: z.enum(["text", "docx", "pdf", "pptx", "xlsx"]).default("text"),
      spec: z.record(z.string(), z.unknown()).optional(),
    }),
    execute: async ({ content, format, name, spec }) => {
      const inputSummary = summarizeValue({
        name,
        format,
        specProvided: spec !== undefined,
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
              preview: { title: file.displayName, text: content.slice(0, 20000), truncated: content.length > 20000 },
              outputSummary: summarizeValue(output),
            }),
          );

          return output;
        }

        const built = await buildDocument({
          format,
          content,
          fileName: name,
          spec,
          resolveImage: readWorkspaceImageBytes,
        });
        const file = await workspaceService.createDocumentFile({
          bytes: built.bytes,
          mimeType: built.mimeType,
          name: built.fileName,
          sourceMarkdown: mergeSpecIntoSource(content, spec),
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
            preview: { title: file.displayName, text: content.slice(0, 20000), truncated: content.length > 20000 },
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
