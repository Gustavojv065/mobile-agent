import { tool } from "ai";
import { z } from "zod";

import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { sectionPreview } from "@/modules/documents/sections";
import {
  createWorkspaceFileService,
  parseStoredSourceSpec,
} from "@/core/services/workspace-file-service";

/** Source Markdown is inlined in full only up to this size; larger documents use sections. */
const SOURCE_MARKDOWN_INLINE_LIMIT = 12_000;

export function createReadTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);

  return tool({
    description:
      "Read text content from a workspace file. Supports plain text files and documents (docx, xlsx, pptx, pdf); document text is extracted automatically. For documents with stored source, the editable source Markdown used to generate the file is also returned as sourceMarkdown (omitted for very large documents, which are returned as a list of sections instead). Pass section (a 0-based index from the sections list) to read one heading-delimited section of a large document, and pass section to updateDocument to rewrite just that section. For imported docx files, the captured original styling is returned as sourceSpec so you can keep the look when you update the document. Use offset to page through large files: set offset to a character position and the content is returned starting there. Read-only.",
    inputSchema: z.object({
      fileId: z.string().min(1),
      maxChars: z.number().int().min(100).max(20000).optional(),
      offset: z.number().int().min(0).optional(),
      section: z.number().int().min(0).optional(),
    }),
    execute: async ({ fileId, maxChars, offset, section }) => {
      const inputSummary = summarizeValue({ fileId, offset, section });

      try {
        const file = await repository.getById(fileId);

        if (!file) {
          throw new Error(`No workspace file found for ${fileId}.`);
        }

        const storedSections = await workspaceService.listDocumentSections(file);
        const sectionSummaries = storedSections.map((entry) => ({
          index: entry.position,
          level: entry.level,
          title: entry.title,
          chars: entry.charCount,
          preview: sectionPreview(entry.body),
        }));

        // Reading a single section: return only that section's Markdown.
        if (section !== undefined) {
          const target = await workspaceService.readDocumentSection(
            file,
            section,
          );
          const output = {
            fileId: file.id,
            displayName: file.displayName,
            content: target.body,
            truncated: false,
            totalChars: target.body.length,
            offset: 0,
            section: {
              index: target.position,
              level: target.level,
              title: target.title,
              chars: target.charCount,
            },
            sections: sectionSummaries,
            ...(file.sourceSpec
              ? { sourceSpec: parseStoredSourceSpec(file.sourceSpec) ?? {} }
              : {}),
          };

          onRecord?.(
            createRecord({
              toolName: "read",
              status: "completed",
              inputSummary,
              outputSummary: summarizeValue({
                fileId: output.fileId,
                displayName: output.displayName,
                section: output.section,
                totalChars: output.totalChars,
                truncated: output.truncated,
                hasSourceMarkdown: false,
                contentPreview: output.content.slice(0, 200),
              }),
            }),
          );

          return output;
        }

        const text = await workspaceService.readWorkspaceFileText(file);
        const start = offset ?? 0;
        const size = maxChars ?? 8000;
        const content = text.slice(start, start + size);
        const hasSourceMarkdown = Boolean(file.sourceMarkdown);
        const inlineSourceMarkdown =
          file.sourceMarkdown &&
          file.sourceMarkdown.length <= SOURCE_MARKDOWN_INLINE_LIMIT;

        const output = {
          fileId: file.id,
          displayName: file.displayName,
          content,
          truncated: text.length > start + size,
          totalChars: text.length,
          offset: start,
          ...(hasSourceMarkdown
            ? {
                hasSourceMarkdown: true,
                sourceChars: file.sourceMarkdown!.length,
                ...(inlineSourceMarkdown
                  ? { sourceMarkdown: file.sourceMarkdown! }
                  : { sourceMarkdownOmitted: true }),
              }
            : {}),
          ...(sectionSummaries.length > 0 ? { sections: sectionSummaries } : {}),
          ...(file.sourceSpec
            ? { sourceSpec: parseStoredSourceSpec(file.sourceSpec) ?? {} }
            : {}),
        };

        onRecord?.(
          createRecord({
            toolName: "read",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue({
              fileId: output.fileId,
              displayName: output.displayName,
              totalChars: output.totalChars,
              truncated: output.truncated,
              hasSourceMarkdown: Boolean(file.sourceMarkdown),
              sectionCount: sectionSummaries.length,
              contentPreview: output.content.slice(0, 200),
            }),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "read",
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
