/**
 * Tool-driven audio-analysis queue.
 *
 * The `analyzeAudio` tool hands a workspace audio file (as a data URI) to
 * {@link requestAudioAnalysis}. The promise stays pending until the app-level
 * {@link AudioAnalysisHost} (mounted in the root layout) decodes and analyzes it
 * in a hidden WebView and resolves it with a compact JSON summary. The audio is
 * decoded in the WebView, not natively, so it reuses the exact same feature
 * extractor the recorder uses at render time (video-audio-analysis.ts).
 *
 * Like the video-render queue this module is pure (no react-native imports) so
 * it can be unit-tested in Node.
 */

import type { AudioAnalysisSummary } from "@/modules/preview/video-audio-analysis";

export type AudioAnalysisJobResult = {
  summary: AudioAnalysisSummary;
};

export type AudioAnalysisJob = {
  id: string;
  /** Data URI of the audio to decode and analyze. */
  src: string;
  maxSeconds: number;
  sampleRate: number;
  maxBeats: number;
  curvePoints: number;
  signal?: AbortSignal;
  resolve: (result: AudioAnalysisJobResult) => void;
  reject: (error: Error) => void;
};

type AudioAnalysisListener = (job: AudioAnalysisJob) => void;

const listeners = new Set<AudioAnalysisListener>();

let jobCounter = 0;

/** Registers the host that performs analyses. Returns an unsubscribe. */
export function subscribeAudioAnalysis(
  listener: AudioAnalysisListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when a mounted host can service analysis requests on this platform. */
export function hasAudioAnalysisHost(): boolean {
  return listeners.size > 0;
}

export type RequestAudioAnalysisParams = {
  /** Data URI of the audio to analyze. */
  src: string;
  /** Analyze at most this many seconds (default 90). */
  maxSeconds?: number;
  /** Target analysis sample rate (default 22050). */
  sampleRate?: number;
  maxBeats?: number;
  curvePoints?: number;
  signal?: AbortSignal;
};

/**
 * Decodes and analyzes an audio file, resolving with a deterministic feature
 * summary (duration, tempo, onsets, energy curves).
 */
export function requestAudioAnalysis(
  params: RequestAudioAnalysisParams,
): Promise<AudioAnalysisJobResult> {
  return new Promise<AudioAnalysisJobResult>((resolve, reject) => {
    if (!params.src) {
      reject(new Error("No audio source was provided."));
      return;
    }

    if (!hasAudioAnalysisHost()) {
      reject(
        new Error(
          "Audio analysis is only available on builds that include the analysis host.",
        ),
      );
      return;
    }

    if (params.signal?.aborted) {
      reject(new Error("Audio analysis was cancelled."));
      return;
    }

    const job: AudioAnalysisJob = {
      id: `audio-analysis-${++jobCounter}`,
      src: params.src,
      maxSeconds: params.maxSeconds ?? 90,
      sampleRate: params.sampleRate ?? 22050,
      maxBeats: params.maxBeats ?? 300,
      curvePoints: params.curvePoints ?? 24,
      signal: params.signal,
      resolve,
      reject,
    };

    for (const listener of [...listeners]) {
      listener(job);
    }
  });
}
