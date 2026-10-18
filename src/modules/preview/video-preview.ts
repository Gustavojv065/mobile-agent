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
 * Preview job bounds live in `video-job-bounds.ts` alongside the mix and
 * render clocks, so every timeout and its message derive from one source
 * and the calibrated start/job pairs stay calibrated.
 */
export {
  SCENE_PREVIEW_START_TIMEOUT_MS,
  SCENE_PREVIEW_JOB_TIMEOUT_MS,
  describeScenePreviewJob,
  scenePreviewStartTimeoutError,
  scenePreviewJobTimeoutError,
} from "@/modules/preview/video-job-bounds";

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
