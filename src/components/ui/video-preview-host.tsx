import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";

import { buildScenePreviewDocument } from "@/modules/preview/video-preview-script";
import { createSceneDocument } from "@/modules/preview/scene-document";
import {
  SCENE_PREVIEW_JOB_TIMEOUT_MS,
  SCENE_PREVIEW_START_TIMEOUT_MS,
  describeScenePreviewJob,
  scenePreviewJobTimeoutError,
  scenePreviewStartTimeoutError,
  subscribeScenePreview,
  type ScenePreviewFrame,
  type ScenePreviewJob,
} from "@/modules/preview/video-preview";

const PREVIEW_VIEWPORT_WIDTH = 1280;
const PREVIEW_VIEWPORT_HEIGHT = 720;
const START_ATTEMPTS = 8;
const START_RETRY_MS = 200;

type PreviewMessage =
  | { type: "mobileAgentPreviewStarted" }
  | { type: "mobileAgentPreviewFrame"; frame: ScenePreviewFrame }
  | { type: "mobileAgentPreviewDone"; warnings?: string[] }
  | { type: "mobileAgentPreviewError"; message?: string };

/**
 * Owns the hidden WebView that stills video scenes for the agent. Mounted
 * once in the root layout next to the render host. It subscribes to
 * {@link subscribeScenePreview} and runs one requested document at a time,
 * calling its `render(t, ...)` per timestamp and resolving the tool's promise
 * with the captured frames (the `previewScene` tool persists them and hands
 * them back to the user).
 *
 * The overlay mirrors the render host (full-size, near-invisible, no pointer
 * events) so scenes lay out exactly as they would for export; the captured
 * bitmap comes from the canvas itself and is resolution-independent.
 */
export function ScenePreviewHost() {
  const canPreview = Platform.OS === "android";

  const [pending, setPending] = useState<ScenePreviewJob[]>([]);
  const [active, setActive] = useState(false);
  const [documentUri, setDocumentUri] = useState<string | null>(null);

  const webViewRef = useRef<WebView>(null);
  const documentRef = useRef<ReturnType<typeof createSceneDocument> | null>(null);
  const jobRef = useRef<ScenePreviewJob | null>(null);
  const framesRef = useRef<ScenePreviewFrame[]>([]);
  const settledRef = useRef<WeakSet<ScenePreviewJob>>(new WeakSet());
  const abortCleanupRef = useRef<(() => void) | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (startTimerRef.current) {
      clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }
    if (jobTimerRef.current) {
      clearTimeout(jobTimerRef.current);
      jobTimerRef.current = null;
    }
  }, []);

  const settle = useCallback(
    (
      job: ScenePreviewJob,
      outcome:
        | { type: "resolve"; frames: ScenePreviewFrame[]; warnings: string[] }
        | { type: "reject"; error: Error },
    ) => {
      if (settledRef.current.has(job)) return;
      settledRef.current.add(job);
      if (outcome.type === "resolve") {
        job.resolve({ frames: outcome.frames, warnings: outcome.warnings });
      } else {
        job.reject(outcome.error);
      }
    },
    [],
  );

  const finishJob = useCallback(() => {
    documentRef.current?.dispose();
    documentRef.current = null;
    abortCleanupRef.current?.();
    abortCleanupRef.current = null;
    jobRef.current = null;
    framesRef.current = [];
    startedRef.current = false;
    clearTimers();
    setDocumentUri(null);
    setActive(false);
  }, [clearTimers]);

  const stopActive = useCallback(
    (error: Error) => {
      const job = jobRef.current;
      if (job) settle(job, { type: "reject", error });
      webViewRef.current?.injectJavaScript(
        "window.__cancelMobileAgentScenePreview ? (window.__cancelMobileAgentScenePreview(), true) : false;",
      );
      finishJob();
    },
    [finishJob, settle],
  );

  const beginPreview = useCallback(
    (job: ScenePreviewJob) => {
      jobRef.current = job;
      framesRef.current = [];
      startedRef.current = false;
      clearTimers();

      if (job.signal) {
        const onAbort = () =>
          stopActive(new Error("Scene preview was cancelled."));
        job.signal.addEventListener("abort", onAbort);
        abortCleanupRef.current = () =>
          job.signal?.removeEventListener("abort", onAbort);
      }

      // Fail fast instead of hanging until the run-level inactivity timeout:
      // no message from the page means the WebView never loaded the document.
      startTimerRef.current = setTimeout(() => {
        if (jobRef.current === job && !startedRef.current) {
          stopActive(scenePreviewStartTimeoutError(job));
        }
      }, SCENE_PREVIEW_START_TIMEOUT_MS);
      // The page started but stalled mid-storyboard (heavy media, a render
      // that never settles). Report progress so far instead of hanging.
      jobTimerRef.current = setTimeout(() => {
        if (jobRef.current === job) {
          stopActive(
            scenePreviewJobTimeoutError(job, framesRef.current.length),
          );
        }
      }, SCENE_PREVIEW_JOB_TIMEOUT_MS);

      try {
        const document = createSceneDocument(buildScenePreviewDocument(job.html));
        documentRef.current = document;
        setDocumentUri(document.uri);
      } catch (error) {
        stopActive(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      setActive(true);
    },
    [clearTimers, stopActive],
  );

  // Drain the queue one preview at a time.
  useEffect(() => {
    if (active || pending.length === 0) return;
    const [next, ...rest] = pending;
    setPending(rest);
    if (next.signal?.aborted) {
      settle(next, {
        type: "reject",
        error: new Error("Scene preview was cancelled."),
      });
      return;
    }
    beginPreview(next);
  }, [active, beginPreview, pending, settle]);

  // Collect preview requests for as long as previews are usable.
  useEffect(() => {
    if (!canPreview) return;
    return subscribeScenePreview((job) => {
      setPending((current) => [...current, job]);
    });
  }, [canPreview]);

  // Reject anything still in flight when the host goes away.
  useEffect(() => {
    return () => {
      abortCleanupRef.current?.();
      abortCleanupRef.current = null;
      documentRef.current?.dispose();
      documentRef.current = null;
      const inFlight = jobRef.current;
      if (inFlight) {
        settle(inFlight, {
          type: "reject",
          error: new Error("Scene preview was interrupted."),
        });
      }
      clearTimers();
    };
  }, [clearTimers, settle]);

  const attemptStart = useCallback((triesLeft: number) => {
    const job = jobRef.current;
    if (!job || startedRef.current) return;
    webViewRef.current?.injectJavaScript(
      `window.__startMobileAgentScenePreview ? (window.__startMobileAgentScenePreview(${JSON.stringify(job.times)}), true) : false;`,
    );
    if (triesLeft > 0) {
      retryTimerRef.current = setTimeout(
        () => attemptStart(triesLeft - 1),
        START_RETRY_MS,
      );
    }
  }, []);

  const handleRenderProcessGone = useCallback(
    (event: { nativeEvent: { didCrash?: boolean } }) => {
      const job = jobRef.current;
      if (!job) return;
      stopActive(
        new Error(
          event.nativeEvent.didCrash === true
            ? "Scene preview failed: the page renderer crashed (likely out of memory). Try a smaller document or fewer timestamps."
            : "Scene preview failed: the page renderer was killed. Try a smaller document.",
        ),
      );
    },
    [stopActive],
  );

  const handleWebViewError = useCallback(() => {
    const job = jobRef.current;
    if (!job || startedRef.current) return;
    stopActive(
      new Error(
        `Scene preview failed: the page could not load (${describeScenePreviewJob(job)}). Try a smaller document.`,
      ),
    );
  }, [stopActive]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const job = jobRef.current;
      if (!job) return;
      let message: PreviewMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as PreviewMessage;
      } catch {
        return;
      }
      if (
        message.type === "mobileAgentPreviewStarted" ||
        message.type === "mobileAgentPreviewFrame" ||
        message.type === "mobileAgentPreviewDone" ||
        message.type === "mobileAgentPreviewError"
      ) {
        startedRef.current = true;
        if (startTimerRef.current) clearTimeout(startTimerRef.current);
        startTimerRef.current = null;
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (message.type === "mobileAgentPreviewFrame" && message.frame) {
        framesRef.current.push(message.frame);
      } else if (message.type === "mobileAgentPreviewDone") {
        const frames = [...framesRef.current].sort((a, b) => a.time - b.time);
        settle(job, {
          type: "resolve",
          frames,
          warnings: Array.isArray(message.warnings) ? message.warnings : [],
        });
        finishJob();
      } else if (message.type === "mobileAgentPreviewError") {
        settle(job, {
          type: "reject",
          error: new Error(
            typeof message.message === "string" && message.message
              ? message.message
              : "Scene preview failed.",
          ),
        });
        finishJob();
      }
    },
    [finishJob, settle],
  );

  if (!canPreview) return null;

  return documentUri ? (
    <View
      pointerEvents="none"
      style={{
        backgroundColor: "transparent",
        height: PREVIEW_VIEWPORT_HEIGHT,
        left: 0,
        opacity: 0.01,
        position: "absolute",
        top: 0,
        width: PREVIEW_VIEWPORT_WIDTH,
      }}
    >
      <WebView
        ref={webViewRef}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowFileAccess
        originWhitelist={["file://*", "http://*", "https://*"]}
        onLoadEnd={() => attemptStart(START_ATTEMPTS)}
        onMessage={handleMessage}
        onError={handleWebViewError}
        onHttpError={handleWebViewError}
        onRenderProcessGone={handleRenderProcessGone}
        source={{ uri: documentUri }}
        style={{ backgroundColor: "transparent", flex: 1 }}
      />
    </View>
  ) : null;
}
