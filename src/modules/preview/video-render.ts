/**
 * Tool-driven video rendering queue.
 *
 * The agent renders a video by calling the `renderVideo` tool, which hands the
 * self-contained HTML document to {@link requestVideoRender}. The promise stays
 * pending until the app-level {@link VideoRenderHost} (rendered in the root
 * layout) records the document in a hidden WebView and resolves it with the
 * finished MP4.
 *
 * There is no renderer in JS: the only thing that can record is the mounted
 * WebView adapter, so this module is just a hand-off queue with promises. It is
 * intentionally pure (no react-native imports) so it can be unit-tested in Node.
 */

export type VideoRenderResult = {
  /** Cache-directory `file://` URI of the finished MP4. */
  uri: string;
  sizeBytes: number;
  /** True when the muxer wrote at least one audio sample. */
  hasAudio: boolean;
  /** Non-fatal audio notes (skipped cues, blocked playback, ...). */
  audioWarnings: string[];
};

export type VideoRenderJob = {
  id: string;
  html: string;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  /** Segmented export: render [offset, offset + length) instead of the whole contract. */
  segment?: { offset: number; length: number };
  resolve: (result: VideoRenderResult) => void;
  reject: (error: Error) => void;
};

type VideoRenderListener = (job: VideoRenderJob) => void;

const listeners = new Set<VideoRenderListener>();

let jobCounter = 0;

/** Live progress for the active render, consumed by the in-chat indicator. */
export type VideoRenderStatus = {
  /** 0–1 recording progress. */
  progress: number;
  /** True once frames are done and the file is being finalized. */
  finishing: boolean;
};

let activeStatus: VideoRenderStatus | null = null;
const statusListeners = new Set<() => void>();

export function getVideoRenderStatus(): VideoRenderStatus | null {
  return activeStatus;
}

export function subscribeVideoRenderStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

export function setVideoRenderStatus(next: VideoRenderStatus | null): void {
  activeStatus = next;
  for (const listener of [...statusListeners]) {
    listener();
  }
}

/** Registers the host that actually performs renders. Returns an unsubscribe. */
export function subscribeVideoRender(
  listener: VideoRenderListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True when a mounted host can service render requests on this platform. Used to
 * fail fast with a helpful message instead of hanging forever.
 */
export function hasVideoRenderHost(): boolean {
  return listeners.size > 0;
}

/**
 * Requests an MP4 for a self-contained HTML document that implements the
 * `window.MOBILE_AGENT_VIDEO` contract. Resolves with the recorded file.
 */
export function requestVideoRender(
  html: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
    segment?: { offset: number; length: number };
  } = {},
): Promise<VideoRenderResult> {
  return new Promise<VideoRenderResult>((resolve, reject) => {
    if (!html.includes("MOBILE_AGENT_VIDEO")) {
      reject(
        new Error(
          "The HTML does not implement the window.MOBILE_AGENT_VIDEO contract, so it cannot be recorded.",
        ),
      );
      return;
    }

    if (!hasVideoRenderHost()) {
      reject(
        new Error(
          "Video rendering is only available on Android builds that include the video export module.",
        ),
      );
      return;
    }

    if (options.signal?.aborted) {
      reject(new Error("Video render was cancelled."));
      return;
    }

    const job: VideoRenderJob = {
      id: `video-render-${++jobCounter}`,
      html,
      onProgress: options.onProgress,
      signal: options.signal,
      segment: options.segment,
      resolve,
      reject,
    };

    for (const listener of [...listeners]) {
      listener(job);
    }
  });
}
