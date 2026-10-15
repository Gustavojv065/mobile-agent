import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { captureRef } from "react-native-view-shot";

import {
  subscribePageShot,
  type PageShotJob,
  type PageShotResult,
} from "@/modules/preview/page-shot";

const SHOT_VIEWPORT_WIDTH = 1280;
const SHOT_VIEWPORT_HEIGHT = 800;
/** Functional settle wait for late paint (fonts, images) — not a watchdog. */
const SETTLE_MS = 1200;

/**
 * Owns the hidden WebView that screenshots public web pages for the agent.
 * Mounted once in the root layout. Loads one URL at a time at a fixed
 * desktop-ish viewport and captures the visible viewport (above the fold —
 * not a full-page scroll stitch). Load/render failures reject loudly;
 * silence degrades to the run-level abort, never a false kill.
 */
export function PageShotHost() {
  const canShoot = Platform.OS === "android";

  const [pending, setPending] = useState<PageShotJob[]>([]);
  const [active, setActive] = useState(false);
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  const webViewRef = useRef<WebView>(null);
  const jobRef = useRef<PageShotJob | null>(null);
  const settledRef = useRef<WeakSet<PageShotJob>>(new WeakSet());
  const abortCleanupRef = useRef<(() => void) | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settle = useCallback(
    (
      job: PageShotJob,
      outcome:
        | { type: "resolve"; result: PageShotResult }
        | { type: "reject"; error: Error },
    ) => {
      if (settledRef.current.has(job)) return;
      settledRef.current.add(job);
      if (outcome.type === "resolve") job.resolve(outcome.result);
      else job.reject(outcome.error);
    },
    [],
  );

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const finishJob = useCallback(() => {
    abortCleanupRef.current?.();
    abortCleanupRef.current = null;
    jobRef.current = null;
    clearSettleTimer();
    setPageUrl(null);
    setActive(false);
  }, [clearSettleTimer]);

  const stopActive = useCallback(
    (error: Error) => {
      const job = jobRef.current;
      if (job) settle(job, { type: "reject", error });
      finishJob();
    },
    [finishJob, settle],
  );

  const capture = useCallback(
    (job: PageShotJob) => {
      const view = webViewRef.current;
      if (!view) {
        stopActive(new Error("Page screenshot failed: the page view is gone."));
        return;
      }
      captureRef(view, { format: "png", quality: 1, result: "tmpfile" }).then(
        (tmpUri) => {
          const current = jobRef.current;
          if (!current || current !== job) return;
          settle(job, { type: "resolve", result: { tmpUri } });
          finishJob();
        },
        (error: unknown) => {
          const current = jobRef.current;
          if (!current || current !== job) return;
          stopActive(
            new Error(
              `Page screenshot failed: could not capture the viewport (${error instanceof Error ? error.message : String(error)}).`,
            ),
          );
        },
      );
    },
    [finishJob, settle, stopActive],
  );

  const beginShot = useCallback(
    (job: PageShotJob) => {
      jobRef.current = job;
      clearSettleTimer();

      if (job.signal) {
        const onAbort = () =>
          stopActive(new Error("Page screenshot was cancelled."));
        job.signal.addEventListener("abort", onAbort);
        abortCleanupRef.current = () =>
          job.signal?.removeEventListener("abort", onAbort);
      }

      setPageUrl(job.url);
      setActive(true);
    },
    [clearSettleTimer, stopActive],
  );

  // Drain the queue one screenshot at a time.
  useEffect(() => {
    if (active || pending.length === 0) return;
    const [next, ...rest] = pending;
    setPending(rest);
    if (next.signal?.aborted) {
      settle(next, {
        type: "reject",
        error: new Error("Page screenshot was cancelled."),
      });
      return;
    }
    beginShot(next);
  }, [active, beginShot, pending, settle]);

  // Collect screenshot requests for as long as shooting is usable.
  useEffect(() => {
    if (!canShoot) return;
    return subscribePageShot((job) => {
      setPending((current) => [...current, job]);
    });
  }, [canShoot]);

  // Reject anything still in flight when the host goes away.
  useEffect(() => {
    return () => {
      abortCleanupRef.current?.();
      abortCleanupRef.current = null;
      const inFlight = jobRef.current;
      if (inFlight) {
        settle(inFlight, {
          type: "reject",
          error: new Error("Page screenshot was interrupted."),
        });
      }
      clearSettleTimer();
    };
  }, [clearSettleTimer, settle]);

  const handleLoadEnd = useCallback(() => {
    const job = jobRef.current;
    if (!job) return;
    clearSettleTimer();
    settleTimerRef.current = setTimeout(() => capture(job), SETTLE_MS);
  }, [capture, clearSettleTimer]);

  const handleRenderProcessGone = useCallback(
    (event: { nativeEvent: { didCrash?: boolean } }) => {
      const job = jobRef.current;
      if (!job) return;
      stopActive(
        new Error(
          event.nativeEvent.didCrash === true
            ? "Page screenshot failed: the page renderer crashed (the page may be too heavy). Try a lighter page."
            : "Page screenshot failed: the page renderer was killed.",
        ),
      );
    },
    [stopActive],
  );

  const handleWebViewError = useCallback(() => {
    const job = jobRef.current;
    if (!job) return;
    stopActive(
      new Error("Page screenshot failed: the page could not load. Check the URL and try again."),
    );
  }, [stopActive]);

  // WebView posts nothing on its own here; onMessage stays wired so future
  // page scripts (readiness pings) have a channel without a refactor.
  const handleMessage = useCallback((_event: WebViewMessageEvent) => {}, []);

  if (!canShoot) return null;

  return pageUrl ? (
    <View
      pointerEvents="none"
      style={{
        backgroundColor: "#ffffff",
        height: SHOT_VIEWPORT_HEIGHT,
        left: 0,
        opacity: 0.01,
        position: "absolute",
        top: 0,
        width: SHOT_VIEWPORT_WIDTH,
      }}
    >
      <WebView
        ref={webViewRef}
        originWhitelist={["http://*", "https://*"]}
        onLoadEnd={handleLoadEnd}
        onMessage={handleMessage}
        onError={handleWebViewError}
        onHttpError={handleWebViewError}
        onRenderProcessGone={handleRenderProcessGone}
        source={{ uri: pageUrl }}
        style={{ backgroundColor: "#ffffff", flex: 1 }}
      />
    </View>
  ) : null;
}
