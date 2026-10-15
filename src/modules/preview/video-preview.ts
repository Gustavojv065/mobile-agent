/**
 * Tool-driven scene preview queue.
 *
 * The agent previews a video scene by calling the `previewScene` tool, which
 * hands the self-contained HTML document (assets already inlined) to
 * {@link requestScenePreview}. The promise stays pending until the app-level
 * {@link ScenePreviewHost} (rendered in the root layout) runs the document's
 * `render(t, ...)` at each requested timestamp in a hidden WebView and
 * resolves it with the captured stills.
 *
 * Like the video-render queue this module is pure (no react-native imports)
 * so it can be unit-tested in Node.
 */

export type ScenePreviewFrame = {
  /** Requested timestamp in seconds. */
  time: number;
  width: number;
  height: number;
  /** Raw JPEG bytes (base64) of the captured canvas. */
  base64: string;
};

export type ScenePreviewResult = {
  frames: ScenePreviewFrame[];
  /** Non-fatal notes (media still loading, per-frame capture issues, ...). */
  warnings: string[];
};

export type ScenePreviewJob = {
  id: string;
  html: string;
  times: number[];
  signal?: AbortSignal;
  resolve: (result: ScenePreviewResult) => void;
  reject: (error: Error) => void;
};

type ScenePreviewListener = (job: ScenePreviewJob) => void;

const listeners = new Set<ScenePreviewListener>();

let jobCounter = 0;

/** Registers the host that actually performs previews. Returns an unsubscribe. */
export function subscribeScenePreview(
  listener: ScenePreviewListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True when a mounted host can service preview requests on this platform.
 * Used to fail fast with a helpful message instead of hanging forever.
 */
export function hasScenePreviewHost(): boolean {
  return listeners.size > 0;
}

/**
 * Bounds for a single preview job, owned by the host (`ScenePreviewHost`).
 * The in-page script settles media in ~10s and captures each timestamp in
 * ~0.4s, so a healthy preview finishes in seconds. Without these the job
 * hangs until the run-level inactivity timeout (5 min) aborts the whole
 * agent run — and the abort was then recorded as "Run completed".
 */
export const SCENE_PREVIEW_START_TIMEOUT_MS = 15_000;
export const SCENE_PREVIEW_JOB_TIMEOUT_MS = 60_000;

/** One-line diagnostics captured into timeout/load error messages. */
export function describeScenePreviewJob(job: {
  html: string;
  times: number[];
}): string {
  const chars = job.html.length;
  const count = job.times.length;
  return `${count} timestamp${count === 1 ? "" : "s"}, ${chars}-char document`;
}

/** The preview page never posted back (load failed or bridge never started). */
export function scenePreviewStartTimeoutError(job: {
  html: string;
  times: number[];
}): Error {
  const seconds = Math.round(
    SCENE_PREVIEW_START_TIMEOUT_MS / 1000,
  );
  return new Error(
    `Scene preview failed: the preview page did not start within ${seconds}s ` +
      `(${describeScenePreviewJob(job)}). The WebView may have failed to load — ` +
      `try a smaller document or fewer timestamps.`,
  );
}

/** The page started but never finished all timestamps. */
export function scenePreviewJobTimeoutError(
  job: { html: string; times: number[] },
  framesCaptured: number,
): Error {
  const seconds = Math.round(SCENE_PREVIEW_JOB_TIMEOUT_MS / 1000);
  return new Error(
    `Scene preview timed out after ${seconds}s ` +
      `(${framesCaptured}/${job.times.length} frames captured, ` +
      `${describeScenePreviewJob(job)}). ` +
      `Try fewer timestamps or a smaller document.`,
  );
}

/**
 * Captures stills of a self-contained HTML document that implements the
 * `window.MOBILE_AGENT_VIDEO` contract, one per requested timestamp.
 */
export function requestScenePreview(
  html: string,
  options: { times: number[]; signal?: AbortSignal } = { times: [] },
): Promise<ScenePreviewResult> {
  return new Promise<ScenePreviewResult>((resolve, reject) => {
    if (!html.includes("MOBILE_AGENT_VIDEO")) {
      reject(
        new Error(
          "The HTML does not implement the window.MOBILE_AGENT_VIDEO contract, so it cannot be previewed.",
        ),
      );
      return;
    }

    const times = (Array.isArray(options.times) ? options.times : []).filter(
      (t) => Number.isFinite(t) && t >= 0,
    );
    if (times.length === 0) {
      reject(new Error("At least one preview timestamp is required."));
      return;
    }

    if (!hasScenePreviewHost()) {
      reject(
        new Error(
          "Scene previews are only available on Android builds that include the preview host.",
        ),
      );
      return;
    }

    if (options.signal?.aborted) {
      reject(new Error("Scene preview was cancelled."));
      return;
    }

    const job: ScenePreviewJob = {
      id: `scene-preview-${++jobCounter}`,
      html,
      times,
      signal: options.signal,
      resolve,
      reject,
    };

    for (const listener of [...listeners]) {
      listener(job);
    }
  });
}
