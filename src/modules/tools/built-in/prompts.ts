import type { WorkspaceRepository } from "@/core/db/database";
import {
  createWorkspaceFileService,
  isDocumentWorkspaceFile,
  isTextWorkspaceFile,
} from "@/core/services/workspace-file-service";

export function buildWorkspaceSystemPrompt() {
  return [
    "The shared workspace contains user-visible files.",
    "Answer in chat by default. Only create a workspace file when the user explicitly asks to create, save, or export a file.",
    "Only write to an existing workspace file when the user explicitly asks to modify that file.",
    "Do not create or modify workspace files merely to preserve a response, keep scratch notes, archive a conversation, or store context for your own future use.",
    "Internal runtime artifacts are stored separately, and durable user facts belong in memory rather than workspace files.",
    "If a file request is ambiguous, respond in chat and ask whether the user wants it saved as a file.",
    "To export a document, call createFile with format set to docx (Word), pdf, pptx (PowerPoint) or xlsx (Excel). Provide Markdown or plain text as content: Markdown headings (#, ##) become titles/slides, pipe tables become tables, and a horizontal rule (---) starts a new page or slide. The source content is stored with the document so it can be updated later.",
    "To update an existing document in place, call updateDocument with the fileId and the new full content (same rules as createFile; the document keeps its format and name). For targeted changes, use edit on a document — edits apply to its stored source Markdown (read returns it as sourceMarkdown) and the document is regenerated. Documents without stored source (for example imported files) can still be replaced via updateDocument with full new content.",
    "grep searches file contents including documents (docx, xlsx, pptx, pdf); document text is extracted automatically before matching.",
    "To split a pdf into page-range parts, call splitPdf with 1-based page ranges (for example \"1-3,5,7-9\"). To merge pdfs into one, call mergePdfs with the fileIds in the desired order; the sources are left untouched and new pdf files are created.",
    "To read text that is locked inside an image (screenshots, scanned pages, photos of text), call ocr with the image fileId. OCR requires a build with the native expo-text-extractor module; if it reports unavailable, tell the user.",
    "When the user asks to download a file from a URL, use the downloadFile tool. Set target to \"folder\" only when the user wants the file saved in the granted external folder: omit destinationPath to save at the granted folder root, or set destinationPath to an existing subfolder. Otherwise downloadFile saves into the workspace. downloadFile never creates folders.",
  ].join("\n");
}

export async function buildSelectedFilesInlineContext(input: {
  repository: WorkspaceRepository;
  selectedFileIds: string[];
}) {
  const workspaceService = createWorkspaceFileService(input.repository);
  const selectedFiles = await input.repository.getByIds(input.selectedFileIds);

  if (selectedFiles.length === 0) {
    return [
      "The user intended to share files, but no selected workspace files were found.",
      "Answer normally and mention that no file content was available.",
    ].join("\n\n");
  }

  const sections: string[] = [
    "Files attached by the user for this turn:",
    "Use the following file contents as user-provided context.",
    "If a file is binary or unreadable as text, do not invent its contents.",
  ];

  let remainingBudget = 12000;

  for (const file of selectedFiles) {
    if (remainingBudget <= 0) {
      sections.push(
        "Additional selected files were omitted because the inline context budget was reached.",
      );
      break;
    }

    if (!isTextWorkspaceFile(file) && !isDocumentWorkspaceFile(file)) {
      sections.push(
        `File: ${file.displayName} (${file.id})\nThis file is binary or non-text and could not be inlined.`,
      );
      continue;
    }

    try {
      const text = await workspaceService.readWorkspaceFileText(file);
      const sliceLength = Math.min(remainingBudget, 6000);
      const excerpt = text.slice(0, sliceLength);
      remainingBudget -= excerpt.length;

      sections.push(
        [
          `File: ${file.displayName} (${file.id})`,
          "Content:",
          "```",
          excerpt,
          text.length > excerpt.length ? "\n[truncated]" : "",
          "```",
        ].join("\n"),
      );
    } catch (error) {
      sections.push(
        `File: ${file.displayName} (${file.id})\nThe file could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return sections.join("\n\n");
}
