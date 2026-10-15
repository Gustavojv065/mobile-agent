/**
 * Tool-driven web page screenshot queue.
 *
 * The agent captures a website's visible viewport by calling the
 * `screenshotPage` tool, which hands the public URL to
 * {@link requestPageShot}. The promise stays pending until the app-level
 * {@link PageShotHost} (rendered in the root layout) loads the URL in a
 * hidden WebView and resolves it with the captured tmpfile URI (the tool
 * then persists it to the workspace and hands back a fileId).
 *
 * Like the other preview queues this module is pure (no react-native
 * imports) so it can be unit-tested in Node.
 */

export type PageShotResult = {
  /** `tmpfile` URI from captureRef, owned by the caller after resolve. */
  tmpUri: string;
};

export type PageShotJob = {
  id: string;
  url: string;
  signal?: AbortSignal;
  resolve: (result: PageShotResult) => void;
  reject: (error: Error) => void;
};

type PageShotListener = (job: PageShotJob) => void;

const listeners = new Set<PageShotListener>();

let jobCounter = 0;

/** Registers the host that actually performs screenshots. Returns an unsubscribe. */
export function subscribePageShot(listener: PageShotListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True when a mounted host can service screenshot requests on this platform.
 * Used to fail fast with a helpful message instead of hanging forever.
 */
export function hasPageShotHost(): boolean {
  return listeners.size > 0;
}

/** Enqueues a screenshot; resolves once the host captures the viewport. */
export function requestPageShot(options: {
  url: string;
  signal?: AbortSignal;
}): Promise<PageShotResult> {
  const { url, signal } = options;
  if (signal?.aborted) {
    return Promise.reject(new Error("Page screenshot was cancelled."));
  }
  if (!hasPageShotHost()) {
    return Promise.reject(
      new Error("Page screenshots are only available on Android builds."),
    );
  }
  return new Promise<PageShotResult>((resolve, reject) => {
    const job: PageShotJob = {
      id: `page-shot-${++jobCounter}`,
      url,
      signal,
      resolve,
      reject,
    };
    for (const listener of [...listeners]) {
      listener(job);
    }
  });
}
