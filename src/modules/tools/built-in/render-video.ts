import { File, Paths } from "expo-file-system";
import { tool } from "ai";
import { z } from "zod";

import type { WorkspaceRepository } from "@/core/db/database";
import { createWorkspaceFileService } from "@/core/services/workspace-file-service";
import { readContractDuration } from "@/modules/preview/video-audio";
import {
  inlineAudioAssets,
  inlineImageAssets,
  inlineVideoAssets,
} from "@/modules/preview/video-assets";
import { requestVideoRender } from "@/modules/preview/video-render";
import {
  createRecord,
  summarizeValue,
} from "@/modules/tools/built-in/shared";
import type { WorkspaceToolFactoryParams } from "@/modules/tools/built-in/types";

const MAX_HTML_CHARS = 2_000_000;
/** Segments stay inside the validated per-render envelope (frames, bridge, abort headroom). */
const SEGMENT_SECONDS = 30;

export type SegmentRenderResult = {
  uri: string;
  hasAudio: boolean;
  audioWarnings: string[];
  warnings: string[];
};

/**
 * Renders the document, segmenting timelines over SEGMENT_SECONDS into
 * ordinary render jobs and concatenating the MP4s natively. Short videos
 * take the legacy single render (zero behavior change). Segment files live
 * in cache keyed by source so a failed run resumes by re-rendering only
 * the missing pieces — exports are deterministic, so resumed segments are
 * byte-identical to a clean run.
 */
export async function renderSegments(options: {
  abortSignal?: AbortSignal;
  contractDuration: number | null;
  documentHtml: string;
  onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void;
  sourceFileId: string;
}): Promise<SegmentRenderResult> {
  const { abortSignal, contractDuration, documentHtml, onProgress, sourceFileId } = options;
  const reportProgress = (done: number, total: number, segProgress: number) => {
    const overall = total <= 0 ? 0 : Math.max(0, Math.min(1, (done + segProgress) / total));
    onProgress?.({ bytesWritten: Math.round(overall * 100), totalBytes: 100 });
  };
  const runOne = (
    segment: { offset: number; length: number } | undefined,
    segIndex: number,
    segTotal: number,
  ) => {
    const done = segIndex;
    return requestVideoRender(documentHtml, {
      signal: abortSignal,
      onProgress: (progress) => reportProgress(done, segTotal, progress),
      segment: segment,
    });
  };

  if (contractDuration == null || contractDuration <= SEGMENT_SECONDS) {
    const result = await runOne(undefined, 0, 1);
    return { uri: result.uri, hasAudio: result.hasAudio, audioWarnings: result.audioWarnings, warnings: [] };
  }

  const total = contractDuration;
  const count = Math.ceil(total / SEGMENT_SECONDS);
  const uris: string[] = [];
  const audioWarnings: string[] = [];
  let hasAudio = false;
  const sidecar = (index: number) =>
    new File(Paths.cache, `render-${sourceFileId}-seg-${index}.json`);
  for (let i = 0; i < count; i += 1) {
    const offset = i * SEGMENT_SECONDS;
    const length = Math.min(SEGMENT_SECONDS, total - offset);
    const segFile = new File(Paths.cache, `render-${sourceFileId}-seg-${i}.mp4`);
    if (segFile.exists) {
      uris.push(segFile.uri);
      try {
        const meta = JSON.parse(await sidecar(i).text()) as {
          hasAudio?: boolean;
          audioWarnings?: string[];
        };
        hasAudio = hasAudio || meta.hasAudio === true;
        if (Array.isArray(meta.audioWarnings)) audioWarnings.push(...meta.audioWarnings);
      } catch {
        // Unreadable sidecar: keep the footage, audio flags stay conservative.
      }
      continue;
    }
    let result;
    try {
      result = await runOne({ offset, length }, i, count);
    } catch (error) {
      throw new Error(
        `Segment ${i + 1}/${count} (t=${offset}-${Math.round((offset + length) * 100) / 100}s) failed: ${error instanceof Error ? error.message : String(error)}. Re-run to resume — finished segments are kept.`,
      );
    }
    hasAudio = hasAudio || result.hasAudio;
    audioWarnings.push(...result.audioWarnings);
    await new File(result.uri).move(segFile, { overwrite: true });
    try {
      await sidecar(i).write(
        JSON.stringify({ hasAudio: result.hasAudio, audioWarnings: result.audioWarnings }),
      );
    } catch {
      // Sidecar is resume metadata only; footage is already safe.
    }
    uris.push(segFile.uri);
  }

  const stripScheme = (uri: string) => (uri.startsWith("file://") ? uri.slice("file://".length) : uri);
  const outFile = new File(Paths.cache, `render-${sourceFileId}-full.mp4`);
  const { getHtmlVideoExportModule } = await import("html-video-export");
  const module = getHtmlVideoExportModule();
  if (!module || typeof module.concatSegments !== "function") {
    throw new Error("Segmented rendering needs the video export module (concatSegments).");
  }
  await module.concatSegments(uris.map(stripScheme), stripScheme(outFile.uri));
  for (const uri of uris) {
    try {
      await new File(uri).delete();
    } catch {
      // Best-effort cache cleanup; segments are small and bounded.
    }
  }
  return {
    uri: outFile.uri,
    hasAudio,
    audioWarnings,
    warnings: [
      `Rendered in ${count} segments and concatenated; per-segment audio fades up to 50 ms at seams.`,
    ],
  };
}

/**
 * Renders a self-contained HTML document (the `window.MOBILE_AGENT_VIDEO`
 * contract) into an MP4 and stores it in the workspace so the user gets the
 * finished file directly in the conversation.
 *
 * The actual recording happens in the app-level hidden WebView host; this tool
 * just hands the document over and waits for the encoded file.
 */
export function createRenderVideoTool({
  onProgress,
  onRecord,
  repository,
}: WorkspaceToolFactoryParams) {
  const workspaceService = createWorkspaceFileService(repository);
  return tool({
    description:
      "Render a self-contained HTML document into an MP4 video and deliver the finished file to the user. The document must define window.MOBILE_AGENT_VIDEO = { duration, fps, width, height, canvasId?, render(t, canvas, ctx, audio, speech) } and draw its animation on a single <canvas>; see the html-video skill for the full contract. Always pass `duration` with the length you promised the user (1–600 s): it must match the contract's `duration` field or the render fails fast. Timelines over 30 s render in 30 s segments and concatenate (resume keeps finished segments on failure). The result reports the actual `duration` — quote that number to the user, never the requested one. Pass the complete HTML either inline as `html` or point at an existing HTML workspace file with `fileId`. Rendering is real time: a 10 second video takes about 10 seconds, so do not call this repeatedly. Returns the saved MP4 as a workspace file for the user. After the tool returns, embed the video inline in your response exactly where you discuss it with ![displayName](workspace://fileId) using the returned fileId, so it renders as a playable in-chat video — do not paste a bare workspace:// link and do not rely on an end-of-message card. Optional sound: add an `audio` schedule to the contract — { master?, tracks: [...] } — where each track is either { file: 'workspace://<audio-file-id>', start?, offset?, duration?, loop?, volume?, fadeIn?, fadeOut? } using an MP3, WAV, M4A, AAC, OGG, or WebM file already in the workspace (served from the device over loopback HTTP — up to 200 MB, no inlining; a 15 MB data-URI fallback applies only on builds without the loopback server) or { synth: {...}, start?, duration?, volume?, fadeIn?, fadeOut? } with synth tones (freq or notes as MIDI numbers/note names like 'C4', wave, noteDur, attack, release), pads (chord notes), filtered noise sweeps (filter, filterFreq, filterEnd, q), or drum patterns (kind 'drums' with stepDur and steps of kick/snare/hat/openhat/clap). Schedule-level `fx` adds one shared reverb ({ decay }) and echo ({ time, feedback, mix }), with per-track `reverb`/`delay` sends on any track. Music tracks duck under voice with `duckUnder` ranges plus `duckAmount`/`duckAttack`/`duckRelease`. Keep per-track volumes modest so the mix stays near 1. Omit `audio` for a silent video. Scenes can also draw user images (`<img src='workspace://<image-file-id>'>`, JPEG/PNG/WebP/GIF, served from the device over loopback HTTP up to 100 MB — a 15 MB data-URI fallback applies only on builds without the loopback server — alpha composites in-scene) and play muted video clips (`<video muted playsinline src='workspace://<video-file-id>'>`, MP4/WebM/MOV, streamed over loopback HTTP up to 1 GB, driven by scene JS) — see the skill. When file or generated (synth) audio is present it is analyzed before recording and the 4th `render` argument `audio` exposes deterministic reactive features — audio.ready, audio.bpm, audio.beats, audio.level(t)/lowAt(t)/midAt(t)/highAt(t)/onsetAt(t), audio.beatPulse(t) — so visuals can sync to the actual soundtrack (see the skill). Use the analyzeAudio tool first if you want the tempo/onsets before authoring. For spoken audio, use the transcribeAudio tool to get word/phrase timings and drive captions or speech-synced visuals: put those segments on the contract as `speech` = { segments, offset?, language?, text? } and the recorder passes them to render as the 5th argument `speech` (also mirrored at window.MOBILE_AGENT_VIDEO_SPEECH) with ready, segments, activeText(t), activeSegment(t), activeIndex(t), progress(t) and nextStart(t). Segment times are video time; add `offset` when you shift the audio track's start so words stay glued to the sound. The result reports hasAudio and any audioWarnings.",
    inputSchema: z.object({
      html: z
        .string()
        .min(1)
        .max(MAX_HTML_CHARS)
        .optional()
        .describe(
          "The complete self-contained HTML document implementing the MOBILE_AGENT_VIDEO contract.",
        ),
      fileId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Alternatively, the id of an existing workspace .html file to render.",
        ),
      name: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("Output file name (a .mp4 extension is added if missing)."),
      duration: z
        .number()
        .min(1)
        .max(600)
        .optional()
        .describe(
          "Expected video length in seconds. Must match the `duration` field in the HTML contract — the render fails fast on a mismatch instead of producing a wrong-length video. Over 30 s renders in 30 s segments, concatenated.",
        ),
    }),
    execute: async ({ html, fileId, name, duration }, { abortSignal }) => {
      const inputSummary = summarizeValue({
        hasHtml: Boolean(html),
        fileId: fileId ?? null,
        name: name ?? null,
        duration: duration ?? null,
      });

      try {
        const rawHtml = await resolveHtml({
          fileId,
          html,
          repository,
          workspaceService,
        });

        if (!rawHtml.includes("MOBILE_AGENT_VIDEO")) {
          throw new Error(
            "The HTML is missing the window.MOBILE_AGENT_VIDEO contract, so there is nothing to record.",
          );
        }

        const contractDuration = readContractDuration(rawHtml);

        // Persist the source HTML alongside the render so later revision
        // requests can Read + edit this file instead of regenerating blind.
        // Only the fileId travels in chat context; the full source is loaded
        // on demand. Saved even when the duration check below fails, so the
        // retry has something to fix.
        const outputName = normalizeName(name);
        const sourceFile = await workspaceService.createTextFile({
          content: rawHtml,
          mimeType: "text/html",
          name: sourceName(outputName),
        });

        if (
          duration != null &&
          contractDuration != null &&
          Math.abs(contractDuration - duration) > 0.5
        ) {
          throw new Error(
            `The HTML contract duration (${contractDuration} s) does not match the requested duration (${duration} s). Read workspace://${sourceFile.id}, fix the contract's duration field (and scale audio cue timings to it), then retry — rendering now would produce a wrong-length video.`,
          );
        }

        const { html: audioHtml, audioFiles } = await inlineAudioAssets(
          rawHtml,
          repository,
        );
        const { html: imageHtml, imageFiles } = await inlineImageAssets(
          audioHtml,
          repository,
        );
        const { html: documentHtml, videoFiles, warnings: clipWarnings } = await inlineVideoAssets(
          imageHtml,
          repository,
        );

        const result = await renderSegments({
          abortSignal,
          contractDuration,
          documentHtml,
          onProgress,
          sourceFileId: sourceFile.id,
        });

        const cacheFile = new File(result.uri);

        // Move (not bytes() round-trip): loading a 100+ MB MP4 into the JS
        // heap OOMs the app, while a same-volume move costs ~zero memory.
        const file = await workspaceService.createDocumentFileFromFile({
          source: cacheFile,
          mimeType: "video/mp4",
          name: normalizeName(name),
        });

        const output = {
          fileId: file.id,
          displayName: file.displayName,
          link: `workspace://${file.id}`,
          mimeType: "video/mp4",
          size: file.size,
          duration: contractDuration,
          sourceFileId: sourceFile.id,
          sourceLink: `workspace://${sourceFile.id}`,
          audioFiles,
          imageFiles,
          videoFiles,
          warnings: [...clipWarnings, ...result.warnings],
          hasAudio: result.hasAudio,
          audioWarnings: result.audioWarnings,
        };

        onRecord?.(
          createRecord({
            toolName: "renderVideo",
            status: "completed",
            inputSummary,
            outputSummary: summarizeValue(output),
          }),
        );

        return output;
      } catch (error) {
        onRecord?.(
          createRecord({
            toolName: "renderVideo",
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

export async function resolveHtml({
  fileId,
  html,
  repository,
  workspaceService,
}: {
  fileId: string | undefined;
  html: string | undefined;
  repository: WorkspaceRepository;
  workspaceService: ReturnType<typeof createWorkspaceFileService>;
}) {
  if (html && html.trim().length > 0) {
    return html;
  }

  if (!fileId) {
    throw new Error(
      "Provide the HTML document to render, either inline as `html` or as an existing `fileId`.",
    );
  }

  const file = await repository.getById(fileId);
  if (!file) {
    throw new Error(`No workspace file found with id ${fileId}.`);
  }

  return workspaceService.readTextFile(file);
}

function normalizeName(name: string | undefined) {
  const base = (name ?? `video-${Date.now()}`).trim() || `video-${Date.now()}`;
  return /\.mp4$/i.test(base) ? base : `${base}.mp4`;
}

/** `clip.mp4` -> `clip.source.html`: the revisable render source. */
function sourceName(outputName: string) {
  return `${outputName.replace(/\.mp4$/i, "")}.source.html`;
}
