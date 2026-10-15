import { tool } from "ai";
import { z } from "zod";
import { File } from "expo-file-system";

import { createWorkspaceFileService } from "@/core/services/workspace-file-service";
import { createRecord, summarizeValue } from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { checkUrl } from "@/modules/tools/built-in/fetch-page";
import {
  hasPageShotHost,
  requestPageShot,
} from "@/modules/preview/page-shot";

type ScreenshotPageOutput = {
  fileId: string;
  displayName: string;
  link: string;
  mimeType: string;
  size: number;
  url: string;
};

/**
 * Screenshots a public web page's visible viewport (above the fold, 1280×800
 * desktop-ish layout — not a full-page scroll stitch, not interactive).
 * Same SSRF guard as fetchPage: public http(s) hosts only. The capture is
 * persisted to the workspace so the model can open it with viewFile.
 */
export function createScreenshotPageTool({
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);
  return tool({
    description:
      "Take a screenshot of a public web page (http/https) at desktop width. Returns a workspace image of the visible viewport — open it with viewFile to see it. Use when the user asks what a page looks like, or to check a layout visually. Not interactive (no login, clicks, or scrolling); pages behind login are out of scope. Local/private URLs are blocked.",
    inputSchema: z.object({
      url: z.string().min(1),
    }),
    execute: async (
      { url }: { url: string },
      { abortSignal }: { abortSignal?: AbortSignal },
    ) => {
      const inputSummary = summarizeValue({ url });

      try {
        const target = checkUrl(url);
        if (!hasPageShotHost()) {
          throw new Error("Page screenshots are only available on Android builds.");
        }
        const shot = await requestPageShot({
          url: target.toString(),
          signal: abortSignal,
        });
        const name = `screenshot-${Date.now()}.png`;
        const file = await workspaceService.createDocumentFileFromFile({
          source: new File(shot.tmpUri),
          mimeType: "image/png",
          name,
        });
        const output: ScreenshotPageOutput = {
          fileId: file.id,
          displayName: file.displayName,
          link: `workspace://${file.id}`,
          mimeType: "image/png",
          size: file.size ?? 0,
          url: target.toString(),
        };

        onRecord?.(
          createRecord({
            toolName: "screenshotPage",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue({
              fileId: output.fileId,
              displayName: output.displayName,
            }),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "screenshotPage",
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
