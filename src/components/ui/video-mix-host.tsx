import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";

import { VIDEO_EXPORT_SCRIPT } from "@/modules/preview/video-recorder";
import { VIDEO_MIX_SCRIPT } from "@/modules/preview/video-mix-script";
import {
  subscribeMixCheck,
  type MixCheckJob,
  type MixCheckStats,
} from "@/modules/preview/video-mix";

const START_ATTEMPTS = 8;
const START_RETRY_MS = 200;

type MixMessage =
  | { type: "mobileAgentMixDone"; stats?: MixCheckStats | null; warnings?: string[] }
  | { type: "mobileAgentMixError"; message?: string }
  | { type: "mobileAgentVideoAudioWarning"; reason?: string };

/**
 * Owns the hidden WebView that preflights scene audio mixes for the agent.
 * Mounted once in the root layout next to the other preview hosts. It
 * subscribes to {@link subscribeMixCheck} and runs one requested document at
 * a time: the page evaluates the recorder script for its audio engine
 * (never started) plus the mix script, which renders the scene's schedule
 * offline and posts back level numbers. Audio warnings raised while
 * scheduling (voice budget, unsupported effects) join the result warnings.
 */
export function MixCheckHost() {
  const canCheck = Platform.OS === "android";

  const [pending, setPending] = useState<MixCheckJob[]>([]);
  const [active, setActive] = useState(false);
  const [documentHtml, setDocumentHtml] = useState<string | null>(null);

  const webViewRef = useRef<WebView>(null);
  const jobRef = useRef<MixCheckJob | null>(null);
  const warningsRef = useRef<string[]>([]);
  const settledRef = useRef<WeakSet<MixCheckJob>>(new WeakSet());
  const abortCleanupRef = useRef<(() => void) | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedRef = useRef(false);

  const clearRetries = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const settle = useCallback(
    (
      job: MixCheckJob,
      outcome:
        | { type: "resolve"; stats: MixCheckStats | null; warnings: string[] }
        | { type: "reject"; error: Error },
    ) => {
      if (settledRef.current.has(job)) return;
      settledRef.current.add(job);
      if (outcome.type === "resolve") {
        job.resolve({ stats: outcome.stats, warnings: outcome.warnings });
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
    warningsRef.current = [];
    startedRef.current = false;
    clearRetries();
    setDocumentHtml(null);
    setActive(false);
  }, [clearRetries]);

  const stopActive = useCallback(
    (error: Error) => {
      const job = jobRef.current;
      if (job) settle(job, { type: "reject", error });
      webViewRef.current?.injectJavaScript(
        "window.__cancelMobileAgentMixCheck ? (window.__cancelMobileAgentMixCheck(), true) : false;",
      );
      finishJob();
    },
    [finishJob, settle],
  );

  const beginCheck = useCallback(
    (job: MixCheckJob) => {
      jobRef.current = job;
      warningsRef.current = [];
      startedRef.current = false;
      clearRetries();

      if (job.signal) {
        const onAbort = () =>
          stopActive(new Error("Mix check was cancelled."));
        job.signal.addEventListener("abort", onAbort);
        abortCleanupRef.current = () =>
          job.signal?.removeEventListener("abort", onAbort);
      }

      setDocumentHtml(job.html);
      setActive(true);
    },
    [clearRetries, stopActive],
  );

  // Drain the queue one check at a time.
  useEffect(() => {
    if (active || pending.length === 0) return;
    const [next, ...rest] = pending;
    setPending(rest);
    if (next.signal?.aborted) {
      settle(next, {
        type: "reject",
        error: new Error("Mix check was cancelled."),
      });
      return;
    }
    beginCheck(next);
  }, [active, beginCheck, pending, settle]);

  // Collect mix checks for as long as checks are usable.
  useEffect(() => {
    if (!canCheck) return;
    return subscribeMixCheck((job) => {
      setPending((current) => [...current, job]);
    });
  }, [canCheck]);

  // Reject anything still in flight when the host goes away.
  useEffect(() => {
    return () => {
      abortCleanupRef.current?.();
      abortCleanupRef.current = null;
      const inFlight = jobRef.current;
      if (inFlight) {
        settle(inFlight, {
          type: "reject",
          error: new Error("Mix check was interrupted."),
        });
      }
      clearRetries();
    };
  }, [clearRetries, settle]);

  const attemptStart = useCallback((triesLeft: number) => {
    const job = jobRef.current;
    if (!job || startedRef.current) return;
    webViewRef.current?.injectJavaScript(
      `window.__startMobileAgentMixCheck ? (window.__startMobileAgentMixCheck(${JSON.stringify(job.duration)}), true) : false;`,
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
            ? "Mix check failed: the page renderer crashed (likely out of memory). Try a smaller document."
            : "Mix check failed: the page renderer was killed. Try a smaller document.",
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
        "Mix check failed: the page could not load. Try a smaller document.",
      ),
    );
  }, [stopActive]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const job = jobRef.current;
      if (!job) return;
      let message: MixMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as MixMessage;
      } catch {
        return;
      }
      if (message.type === "mobileAgentVideoAudioWarning" && message.reason) {
        startedRef.current = true;
        warningsRef.current.push(message.reason);
      } else if (message.type === "mobileAgentMixDone") {
        settle(job, {
          type: "resolve",
          stats: message.stats ?? null,
          warnings: [
            ...warningsRef.current,
            ...(Array.isArray(message.warnings) ? message.warnings : []),
          ],
        });
        finishJob();
      } else if (message.type === "mobileAgentMixError") {
        settle(job, {
          type: "reject",
          error: new Error(
            typeof message.message === "string" && message.message
              ? message.message
              : "Mix check failed.",
          ),
        });
        finishJob();
      }
    },
    [finishJob, settle],
  );

  if (!canCheck) return null;

  return documentHtml ? (
    <View
      pointerEvents="none"
      style={{
        backgroundColor: "transparent",
        height: 8,
        left: 0,
        opacity: 0.01,
        position: "absolute",
        top: 0,
        width: 8,
      }}
    >
      <WebView
        ref={webViewRef}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        originWhitelist={["http://*", "https://*"]}
        onLoadEnd={() => attemptStart(START_ATTEMPTS)}
        onMessage={handleMessage}
        onError={handleWebViewError}
        onHttpError={handleWebViewError}
        onRenderProcessGone={handleRenderProcessGone}
        source={{
          html: `${documentHtml}\n<script>${VIDEO_EXPORT_SCRIPT}</script>\n<script>${VIDEO_MIX_SCRIPT}</script>\n`,
        }}
        style={{ backgroundColor: "transparent", flex: 1 }}
      />
    </View>
  ) : null;
}
