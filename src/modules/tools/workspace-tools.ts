import { createCreateFileTool } from "@/modules/tools/built-in/create-file";
import { createDownloadFileTool } from "@/modules/tools/built-in/download-file";
import { createEditTool } from "@/modules/tools/built-in/edit";
import { createGlobTool } from "@/modules/tools/built-in/glob";
import { createGrepTool } from "@/modules/tools/built-in/grep";
import { createListFilesTool } from "@/modules/tools/built-in/list-files";
import { createMergeDocumentsTool } from "@/modules/tools/built-in/merge-documents";
import { createMergePdfsTool } from "@/modules/tools/built-in/merge-pdfs";
import { createOcrTool } from "@/modules/tools/built-in/ocr";
import {
  buildSelectedFilesInlineContext,
  buildWorkspaceSystemPrompt,
} from "@/modules/tools/built-in/prompts";
import { createReadTool } from "@/modules/tools/built-in/read";
import { createRenderVideoTool } from "@/modules/tools/built-in/render-video";
import { createSplitDocumentTool } from "@/modules/tools/built-in/split-document";
import { createSplitPdfTool } from "@/modules/tools/built-in/split-pdf";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { createUpdateDocumentTool } from "@/modules/tools/built-in/update-document";
import { createWriteTool } from "@/modules/tools/built-in/write";
import type { ExternalFolderSession } from "@/core/types/app-state";
import { createWorkspaceFileService } from "@/core/services/workspace-file-service";

export function createWorkspaceTools(
  params: WorkspaceToolFactoryParams & {
    session?: ExternalFolderSession | null;
  },
) {
  return {
    tools: {
      createFile: createCreateFileTool(params),
      downloadFile: createDownloadFileTool({ ...params, session: params.session }),
      edit: createEditTool(params),
      glob: createGlobTool(params),
      grep: createGrepTool(params),
      listFiles: createListFilesTool(params),
      mergeDocuments: createMergeDocumentsTool(params),
      mergePdfs: createMergePdfsTool(params),
      ocr: createOcrTool(params),
      read: createReadTool(params),
      renderVideo: createRenderVideoTool(params),
      splitDocument: createSplitDocumentTool(params),
      splitPdf: createSplitPdfTool(params),
      updateDocument: createUpdateDocumentTool(params),
      write: createWriteTool(params),
    },
    workspaceService: createWorkspaceFileService(params.repository),
  };
}

export { buildSelectedFilesInlineContext, buildWorkspaceSystemPrompt };
