import { File, Paths } from "expo-file-system";

import {
  type VideoExportTimings,
  requestVideoRender,
} from "@/modules/preview/video-render";

/** Segments stay inside the validated per-render envelope (frames, bridge, abort headroom). */
export const SEGMENT_SECONDS = 30;

export type SegmentRenderResult = {
  uri: string;
  hasAudio: boolean;
  audioWarnings: string[];
  warnings: string[];
  /** Per-stage timing summary of the slowest measured segment, when reported. */
  timings?: VideoExportTimings;
  /** Non-fatal performance notes derived from the timings. */
  perfWarnings: string[];
  /** One-time clip-mapping diagnostics, deduped across segments. */
  visualWarnings: string[];
  /** Device codec that encoded the video, when the native module reported one. */
  encoder?: string;
};

/**
 * Renders the document, segmenting timelines over SEGMENT_SECONDS into
 * ordinary render jobs and concatenating the MP4s natively. Short videos
 * take the legacy single render (zero behavior change). Segment files live
 * in cache keyed by source so a failed run resumes by re-rendering only
 * the missing pieces.
 *
 * Resumed segments must share ONE encoder with the fresh ones: concat
 * sample-copies every segment under the first segment's H.264 parameters
 * (SPS/PPS), so each segment's sidecar records the codec that made it and
 * the run pins every later render to it — across app restarts included. A
 * concat that refuses the set reports the error and keeps completed segments.
 * Never silently restart a finished render or discard its completed footage.
 *
 * This is the single render engine shared by both surfaces: the `renderVideo`
 * tool (hidden host, output moved into the workspace) and the preview
 * dialog's Export button (same hidden host queue, output saved to Downloads).
 * Kept in `@/modules/preview` — not in the tool module — so the UI can import
 * it without pulling the `ai`/`zod` tool stack into the component tree.
 */
export async function renderSegments(options: {
  abortSignal?: AbortSignal;
  contractDuration: number | null;
  documentHtml: string;
  onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void;
  /**
   * Cache key for segment resume files. Both callers pass a content hash of
   * the inlined document (`hashDocumentKey`), so retrying the *same* scene
   * resumes and an *edited* scene starts fresh — a workspace file id would be
   * stable across edits (`updateDocumentFile` rewrites in place) and would
   * serve the previous version's segments.
   */
  sourceFileId: string;
}): Promise<SegmentRenderResult> {
  const { abortSignal, contractDuration, documentHtml, onProgress, sourceFileId } = options;
  const reportProgress = (base: number, span: number, segProgress: number) => {
    const overall = span <= 0 ? 0 : Math.max(0, Math.min(1, base + segProgress * span));
    // Keep 100% for successful completion, not merely the last encoded frame.
    // Basis-point units preserve sub-percent progress for the decimal UI.
    onProgress?.({ bytesWritten: Math.min(9900, Math.floor(overall * 9900)), totalBytes: 10000 });
  };
  const runOne = (
    segment: { offset: number; length: number } | undefined,
    weight: { base: number; span: number },
    pinnedEncoder?: string,
  ) => {
    return requestVideoRender(documentHtml, {
      signal: abortSignal,
      onProgress: (progress) => reportProgress(weight.base, weight.span, progress),
      segment: segment,
      progressBase: weight.base,
      progressSpan: weight.span,
      pinnedEncoder,
    });
  };

  if (contractDuration == null || contractDuration <= SEGMENT_SECONDS) {
    const result = await runOne(undefined, { base: 0, span: 1 });
    onProgress?.({ bytesWritten: 10000, totalBytes: 10000 });
    return {
      uri: result.uri,
      hasAudio: result.hasAudio,
      audioWarnings: result.audioWarnings,
      warnings: [],
      timings: result.timings,
      perfWarnings: result.perfWarnings ?? [],
      visualWarnings: result.visualWarnings ?? [],
      encoder: result.encoder,
    };
  }

  const total = contractDuration;
  const count = Math.ceil(total / SEGMENT_SECONDS);
  const sidecar = (index: number) =>
    new File(Paths.cache, `render-${sourceFileId}-seg-${index}.json`);

  /**
   * One full pass over the timeline: render every segment the cache does not
   * already have — each pinned to the run's encoder — then concat. The pin is
   * the first known encoder of the run (a cached segment's sidecar record, or
   * the first fresh render's result) and is passed to every later
   * `requestVideoRender`, because `SegmentConcat` sample-copies all segments
   * under segment 1's SPS/PPS: segments from a different encoder corrupt the
   * output instead of failing at playback time. The pin also survives process
   * restarts through the sidecars, so resume-after-kill stays on one codec.
   */
  const renderAll = async () => {
    const uris: string[] = [];
    const audioWarnings: string[] = [];
    const perfWarnings: string[] = [];
    const visualWarnings = new Set<string>();
    let hasAudio = false;
    let runEncoder: string | undefined;
    let slowest: { timings?: VideoExportTimings; cost: number } | null = null;
    for (let i = 0; i < count; i += 1) {
      const offset = i * SEGMENT_SECONDS;
      const length = Math.min(SEGMENT_SECONDS, total - offset);
      const segFile = new File(Paths.cache, `render-${sourceFileId}-seg-${i}.mp4`);
      if (segFile.exists) {
        let meta: {
          hasAudio?: boolean;
          audioWarnings?: string[];
          perfWarnings?: string[];
          visualWarnings?: string[];
          encoder?: string;
        } | null = null;
        try {
          meta = JSON.parse(await sidecar(i).text());
        } catch {
          // Unreadable sidecar: keep the footage, audio flags stay
          // conservative and the encoder stays unknown (concat still verifies
          // parameters, and a mismatch self-heals below).
          meta = null;
        }
        const cachedEncoder =
          meta && typeof meta.encoder === "string" && meta.encoder ? meta.encoder : undefined;
        // Keep the cached segment unless it is known to have been made by a
        // *different* encoder than this run — feeding concat a known-bad mix
        // would only fail after every other segment finished.
        if (!runEncoder || !cachedEncoder || cachedEncoder === runEncoder) {
          if (cachedEncoder) runEncoder = cachedEncoder;
          uris.push(segFile.uri);
          hasAudio = hasAudio || meta?.hasAudio === true;
          if (Array.isArray(meta?.audioWarnings)) audioWarnings.push(...meta.audioWarnings);
          if (Array.isArray(meta?.perfWarnings)) perfWarnings.push(...meta.perfWarnings);
          if (Array.isArray(meta?.visualWarnings)) {
            for (const note of meta.visualWarnings) visualWarnings.add(note);
          }
          continue;
        }
        // Made by another encoder: drop just this segment and re-render it
        // under the run's pin.
        try {
          await segFile.delete();
          await sidecar(i).delete();
        } catch {
          // Best-effort; a leftover file would fail the move below loudly.
        }
      }
      let result;
      try {
        // Each segment's weight matches its share of the video length, so the
        // reported fraction is monotonic across segment boundaries: the bar
        // never resets to 0 mid-movie.
        result = await runOne(
          { offset, length },
          { base: offset / total, span: length / total },
          runEncoder,
        );
      } catch (error) {
        throw new Error(
          `Segment ${i + 1}/${count} (t=${offset}-${Math.round((offset + length) * 100) / 100}s) failed: ${error instanceof Error ? error.message : String(error)}. Re-run to resume — finished segments are kept.`,
        );
      }
      hasAudio = hasAudio || result.hasAudio;
      if (result.encoder && !runEncoder) runEncoder = result.encoder;
      audioWarnings.push(...result.audioWarnings);
      perfWarnings.push(...(result.perfWarnings ?? []));
      for (const note of result.visualWarnings ?? []) visualWarnings.add(note);
      const timings = result.timings;
      if (timings) {
        const cost = timings.prepareAvgMs + timings.captureAvgMs + timings.bridgeAvgMs;
        if (!slowest || cost > slowest.cost) slowest = { timings, cost };
      }
      await new File(result.uri).move(segFile, { overwrite: true });
      try {
        await sidecar(i).write(
          JSON.stringify({
            hasAudio: result.hasAudio,
            audioWarnings: result.audioWarnings,
            perfWarnings: result.perfWarnings ?? [],
            visualWarnings: [...visualWarnings],
            // The run's pin, recorded so any later resume stays on this codec.
            encoder: result.encoder,
          }),
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
    reportProgress(0, 1, 1);
    try {
      await module.concatSegments(uris.map(stripScheme), stripScheme(outFile.uri));
    } catch (error) {
      throw new Error(
        `Video segments finished, but joining failed. Completed segments were kept; the export did not restart automatically. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      uris,
      outFile,
      hasAudio,
      audioWarnings,
      perfWarnings,
      visualWarnings: [...visualWarnings],
      encoder: runEncoder,
      timings: slowest?.timings,
    };
  };

  const merged = await renderAll();
  for (const uri of merged.uris) {
    try {
      await new File(uri).delete();
    } catch {
      // Best-effort cache cleanup; segments are small and bounded.
    }
  }
  onProgress?.({ bytesWritten: 10000, totalBytes: 10000 });
  return {
    uri: merged.outFile.uri,
    hasAudio: merged.hasAudio,
    audioWarnings: merged.audioWarnings,
    timings: merged.timings,
    perfWarnings: merged.perfWarnings,
    visualWarnings: merged.visualWarnings,
    encoder: merged.encoder,
    warnings: [
      `Rendered in ${count} segments and concatenated; per-segment audio fades up to 50 ms at seams.`,
    ],
  };
}

/**
 * Stable cache key for a document's segment-resume files. Exports are
 * deterministic in the document, so a retry of the same HTML legitimately
 * reuses finished segments and an edit must not. Pure FNV-1a over the document
 * (truncated) — this guards a cache directory name, not security.
 */
export function hashDocumentKey(documentHtml: string): string {
  // FNV-1a 32-bit, chunked so a multi-megabyte document does not build parts.
  let hash = 0x811c9dc5;
  const CHUNK = 0x8000;
  for (let i = 0; i < documentHtml.length; i += CHUNK) {
    const slice = documentHtml.slice(i, i + CHUNK);
    for (let j = 0; j < slice.length; j += 1) {
      hash ^= slice.charCodeAt(j);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `hash-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
