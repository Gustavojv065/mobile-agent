import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";

import {
  buildAudioAnalysisDocument,
  type AudioAnalysisSummary,
} from "@/modules/preview/video-audio-analysis";
import {
  subscribeAudioAnalysis,
  type AudioAnalysisJob,
  type AudioAnalysisJobResult,
} from "@/modules/preview/video-audio-analysis-job";

/**
 * Owns the hidden WebView that decodes and analyzes a workspace audio file for
 * the `analyzeAudio` tool. Mounted once in the root layout. It publishes the
 * decoded feature summary (tempo, onsets, energy curves) back to the tool so
 * the agent can plan visuals that follow the actual soundtrack.
 *
 * It also serves the `transcribeAudio` fallback lane (builds without the
 * native decoder): when a job asks for a `pcmSampleRate`, the same decode is
 * exported as mono 16-bit PCM for on-device speech recognition.
 *
 * No wall-clock timers: decode duration legitimately scales with the source —
 * a timer guessed how long and killed valid jobs (e.g. a 12 MB video whose
 * soundtrack decodes past 30 s, producing a false "timed out"). Failures are
 * event-driven — in-page script errors and WebView onError reject; the
 * run-level inactivity abort remains the last-resort backstop. The decode
 * shares the same engine as the recorder (video-audio-analysis.ts), so the
 * numbers the agent plans with match what the page sees at render time.
 */
export function AudioAnalysisHost() {
  const [pending, setPending] = useState<AudioAnalysisJob[]>([]);
  const [active, setActive] = useState(false);
  const [documentHtml, setDocumentHtml] = useState<string | null>(null);

  const webViewRef = useRef<WebView>(null);
  const jobRef = useRef<AudioAnalysisJob | null>(null);
  const settledRef = useRef<WeakSet<AudioAnalysisJob>>(new WeakSet());
  const abortCleanupRef = useRef<(() => void) | null>(null);

  const settle = useCallback(
    (
      job: AudioAnalysisJob,
      outcome:
        | { type: "resolve"; result: AudioAnalysisJobResult }
        | { type: "reject"; error: Error },
    ) => {
      if (settledRef.current.has(job)) return;
      settledRef.current.add(job);
      if (outcome.type === "resolve") {
        job.resolve(outcome.result);
      } else {
        job.reject(outcome.error);
      }
    },
    [],
  );

  const finishJob = useCallback(() => {
    abortCleanupRef.current?.();
    abortCleanupRef.current = null;
    jobRef.current = null;
    setDocumentHtml(null);
    setActive(false);
  }, []);

  const beginAnalysis = useCallback(
    (job: AudioAnalysisJob) => {
      jobRef.current = job;
      setDocumentHtml(
        buildAudioAnalysisDocument({
          src: job.src,
          maxSeconds: job.maxSeconds,
          sampleRate: job.sampleRate,
          maxBeats: job.maxBeats,
          curvePoints: job.curvePoints,
          pcmSampleRate: job.pcmSampleRate,
        }),
      );

      if (job.signal) {
        const onAbort = () => {
          settle(job, {
            type: "reject",
            error: new Error("Audio analysis was cancelled."),
          });
          finishJob();
        };
        job.signal.addEventListener("abort", onAbort);
        abortCleanupRef.current = () =>
          job.signal?.removeEventListener("abort", onAbort);
      }

      setActive(true);
    },
    [finishJob, settle],
  );

  // Drain the queue one analysis at a time.
  useEffect(() => {
    if (active || pending.length === 0) return;
    const [next, ...rest] = pending;
    setPending(rest);
    if (next.signal?.aborted) {
      settle(next, {
        type: "reject",
        error: new Error("Audio analysis was cancelled."),
      });
      return;
    }
    beginAnalysis(next);
  }, [active, beginAnalysis, pending, settle]);

  // Collect analysis requests.
  useEffect(
    () =>
      subscribeAudioAnalysis((job) => {
        setPending((current) => [...current, job]);
      }),
    [],
  );

  // Reject anything in flight when the host unmounts.
  useEffect(() => {
    return () => {
      abortCleanupRef.current?.();
      abortCleanupRef.current = null;
      const inFlight = jobRef.current;
      if (inFlight) {
        settle(inFlight, {
          type: "reject",
          error: new Error("Audio analysis was interrupted."),
        });
      }
    };
  }, [settle]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let payload: {
        type?: unknown;
        summary?: unknown;
        message?: unknown;
        pcmBase64?: unknown;
        pcmSampleRate?: unknown;
      };
      try {
        payload = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== "object") return;

      const job = jobRef.current;
      if (payload.type === "mobileAgentAudioAnalysis") {
        if (job) {
          const result: AudioAnalysisJobResult = {
            summary: payload.summary as AudioAnalysisSummary,
          };
          if (
            typeof payload.pcmBase64 === "string" &&
            typeof payload.pcmSampleRate === "number" &&
            payload.pcmSampleRate > 0
          ) {
            result.pcm = {
              base64: payload.pcmBase64,
              sampleRate: payload.pcmSampleRate,
            };
          }
          settle(job, { type: "resolve", result });
        }
        finishJob();
      } else if (payload.type === "mobileAgentAudioAnalysisError") {
        if (job) {
          settle(job, {
            type: "reject",
            error: new Error(String(payload.message || "Audio analysis failed.")),
          });
        }
        finishJob();
      }
    },
    [finishJob, settle],
  );

  if (!documentHtml) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        backgroundColor: "transparent",
        height: 1,
        left: 0,
        opacity: 0.01,
        position: "absolute",
        top: 0,
        width: 1,
      }}
    >
      <WebView
        ref={webViewRef}
        originWhitelist={["*"]}
        onError={() => {
          const job = jobRef.current;
          if (job) {
            settle(job, {
              type: "reject",
              error: new Error("The audio analysis view failed to load."),
            });
          }
          finishJob();
        }}
        onLoadEnd={() =>
          webViewRef.current?.injectJavaScript(
            "window.__startMobileAgentAudioAnalysis && window.__startMobileAgentAudioAnalysis(); true;",
          )
        }
        onMessage={handleMessage}
        source={{ html: documentHtml }}
        style={{ backgroundColor: "transparent", flex: 1 }}
      />
    </View>
  );
}
