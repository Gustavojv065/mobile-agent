import { tool } from "ai";
import { z } from "zod";

import { createWorkspaceFileService } from "@/core/services/workspace-file-service";
import { readContractDuration } from "@/modules/preview/video-audio";
import {
  inlineImageAssets,
  inlineVideoAssets,
} from "@/modules/preview/video-assets";
import { requestScenePreview } from "@/modules/preview/video-preview";
import {
  createRecord,
  summarizeValue,
} from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";
import { resolveHtml } from "@/modules/tools/built-in/render-video";

const MAX_PREVIEW_FRAMES = 8;

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

/** Default storyboard: start, quarters, and just before the end. */
export function defaultStoryboardTimes(duration: number): number[] {
  const d = Math.max(0.05, duration);
  const times = [0, d * 0.25, d * 0.5, d * 0.75, Math.max(0, d - 0.05)];
  return [...new Set(times.map(round2))];
}

/**
 * Cleans requested timestamps: finite, inside the video, ascending, unique,
 * at most MAX_PREVIEW_FRAMES. Out-of-range times clamp (with a warning)
 * instead of failing — the storyboard is approximate by design.
 */
export function normalizePreviewTimes(
  times: number[] | undefined,
  duration: number,
  fallback: number[],
): { times: number[]; warnings: string[] } {
  const warnings: string[] = [];
  const raw = Array.isArray(times) && times.length > 0 ? times : fallback;
  const cleaned: number[] = [];
  for (const t of raw) {
    if (!Number.isFinite(t)) continue;
    const clamped = Math.min(Math.max(0, t), duration);
    if (clamped !== t) {
      warnings.push(
        `Preview time ${t}s is outside the ${duration}s video and was clamped to ${round2(clamped)}s.`,
      );
    }
    cleaned.push(round2(clamped));
  }
  const unique = [...new Set(cleaned)].sort((a, b) => a - b);
  if (unique.length > MAX_PREVIEW_FRAMES) {
    warnings.push(
      `Only the first ${MAX_PREVIEW_FRAMES} preview times were captured.`,
    );
  }
  const finalTimes = unique.slice(0, MAX_PREVIEW_FRAMES);
  if (finalTimes.length === 0) {
    warnings.push("No valid preview timestamps; captured the opening frame.");
    return { times: [0], warnings };
  }
  return { times: finalTimes, warnings };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Captures stills of a video scene before spending render time on it. Use
 * this after authoring a scene (especially with user images, clips, or
 * tricky layout) and before calling `renderVideo`: it runs the scene's
 * `render(t, ...)` at storyboard timestamps in a hidden host and shows you
 * the frames, so composition, framing, and caption placement can be fixed
 * while iteration is cheap.
 *
 * The preview is approximate — async media settles, no audio plays — and the
 * render stays the truth. File-audio tracks are not inlined (nothing plays);
 * image and clip assets are, exactly as for export.
 */
export function createPreviewSceneTool({
  onRecord,
  repository,
  supportsImageInput = true,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);
  return tool({
    description:
      "Look at a video scene before rendering it. Use this after writing or revising a scene for renderVideo — especially with user images, video clips, or tricky layout — to check composition, framing, and caption placement while iteration is cheap. Pass the same HTML (or scene fileId) you would render, plus the promised duration. Returns storyboard stills as workspace image files and — on vision-capable models — inline image content you can actually see. On models without image input you only get the file links: use the ocr tool to read on-screen text, or ask the user what they see. The preview is approximate (media settles, no audio plays); the render is truth.",
    inputSchema: z.object({
      html: z
        .string()
        .min(1)
        .optional()
        .describe("The complete scene HTML (same document renderVideo takes)."),
      fileId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The id of a workspace HTML file holding the scene (e.g. a .source.html from a previous render).",
        ),
      duration: z
        .number()
        .min(1)
        .max(45)
        .optional()
        .describe(
          "Expected video length in seconds. Must match the `duration` field in the scene contract.",
        ),
      times: z
        .array(z.number().min(0).max(45))
        .max(MAX_PREVIEW_FRAMES)
        .optional()
        .describe(
          "Timestamps in seconds to capture (default: a 5-frame storyboard across the scene).",
        ),
      name: z
        .string()
        .min(1)
        .max(60)
        .optional()
        .describe("Base file name for the saved stills."),
    }),
    execute: async ({ html, fileId, duration, times, name }, { abortSignal }) => {
      const inputSummary = summarizeValue({
        hasHtml: Boolean(html),
        fileId: fileId ?? null,
        duration: duration ?? null,
        times: times ?? null,
        name: name ?? null,
      });

      try {
        const rawHtml = await resolveHtml({
          fileId,
          html,
          repository,
          workspaceService,
        });
        const contractDuration = readContractDuration(rawHtml);
        if (
          duration != null &&
          contractDuration != null &&
          Math.abs(contractDuration - duration) > 0.5
        ) {
          throw new Error(
            `The scene contract duration (${contractDuration} s) does not match the requested duration (${duration} s). Fix the contract's duration field and retry — previewing now would check the wrong scene.`,
          );
        }
        const videoDuration = duration ?? contractDuration;
        if (!(videoDuration != null && videoDuration > 0)) {
          throw new Error(
            "Cannot storyboard this scene: pass `duration` (1–45 s) matching the contract's duration field.",
          );
        }

        // Image and clip assets inline exactly as for export; file-audio
        // tracks stay as references (nothing plays in a silent preview).
        const { html: imageHtml } = await inlineImageAssets(rawHtml, repository);
        const { html: sceneHtml } = await inlineVideoAssets(imageHtml, repository);

        const storyboard = normalizePreviewTimes(
          times,
          videoDuration,
          defaultStoryboardTimes(videoDuration),
        );

        const preview = await requestScenePreview(sceneHtml, {
          times: storyboard.times,
          signal: abortSignal,
        });
        const warnings = [...storyboard.warnings, ...preview.warnings];

        if (preview.frames.length === 0) {
          throw new Error(
            `Scene preview produced no frames.${warnings.length > 0 ? ` ${warnings.join(" ")}` : ""}`,
          );
        }

        const baseName = (name ?? "scene").trim() || "scene";
        const frames: {
          fileId: string;
          link: string;
          time: number;
          width: number;
          height: number;
        }[] = [];
        const inlineParts: { type: "file"; data: Uint8Array; mediaType: string }[] = [];
        for (const frame of preview.frames) {
          const bytes = base64ToBytes(frame.base64);
          const saved = await workspaceService.createDocumentFile({
            bytes,
            mimeType: "image/jpeg",
            name: `${baseName}-preview-${frame.time}s.jpg`,
          });
          frames.push({
            fileId: saved.id,
            link: `workspace://${saved.id}`,
            time: frame.time,
            width: frame.width,
            height: frame.height,
          });
          inlineParts.push({
            type: "file" as const,
            data: bytes,
            mediaType: "image/jpeg",
          });
        }

        const text =
          `Storyboard of "${baseName}" (${videoDuration}s, ${frames.length} frame${frames.length === 1 ? "" : "s"}): ` +
          frames.map((f) => `${f.time}s as workspace://${f.fileId}`).join(", ") +
          ". Describe what you see at each timestamp when replying.";

        const output = supportsImageInput
          ? {
              content: [{ type: "text" as const, text }, ...inlineParts],
              frames,
              frameCount: frames.length,
              warnings,
            }
          : {
              text:
                `${text} Your model cannot display images, so inspect ` +
                `the saved stills with the ocr tool for on-screen text, or ask ` +
                `the user what they see at each timestamp.`,
              frames,
              frameCount: frames.length,
              warnings,
            };

        onRecord?.(
          createRecord({
            toolName: "previewScene",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue({
              frameCount: frames.length,
              frames: frames.map((f) => ({
                fileId: f.fileId,
                link: f.link,
                time: f.time,
              })),
              warnings,
              inlineImage: supportsImageInput,
            }),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "previewScene",
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
