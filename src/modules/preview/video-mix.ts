/**
 * Tool-driven mix-check queue.
 *
 * The agent checks a scene's audio mix by calling the `previewMix` tool,
 * which hands the self-contained HTML document (assets already inlined) to
 * {@link requestMixCheck}. The promise stays pending until the app-level
 * {@link MixCheckHost} (rendered in the root layout) renders the scene's
 * audio schedule offline in a hidden WebView and resolves it with level
 * numbers (peak/RMS/clip and quiet ranges, ducked ranges).
 *
 * Like the other preview queues this module is pure (no react-native
 * imports) so it can be unit-tested in Node.
 */

export type MixCheckRange = {
  start: number;
  end: number;
};

export type MixCheckDuckedRange = MixCheckRange & {
  /** Target music level while ducked (0–1). */
  level: number;
};

export type MixCheckStats = {
  peak: number;
  rms: number;
  clipped: boolean;
  clippedRanges: MixCheckRange[];
  quietRanges: MixCheckRange[];
  duckedRanges: MixCheckDuckedRange[];
  duration: number;
};

export type MixCheckResult = {
  /** Null when there is nothing to check (no schedule, unsupported device). */
  stats: MixCheckStats | null;
  warnings: string[];
};

export type MixCheckJob = {
  id: string;
  html: string;
  duration: number;
  signal?: AbortSignal;
  resolve: (result: MixCheckResult) => void;
  reject: (error: Error) => void;
};

type MixCheckListener = (job: MixCheckJob) => void;

const listeners = new Set<MixCheckListener>();

let jobCounter = 0;

/** Registers the host that actually performs mix checks. Returns an unsubscribe. */
export function subscribeMixCheck(listener: MixCheckListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True when a mounted host can service mix checks on this platform. Used to
 * fail fast with a helpful message instead of hanging forever.
 */
export function hasMixCheckHost(): boolean {
  return listeners.size > 0;
}

/**
 * Renders a scene document's audio schedule offline and reports its levels,
 * without recording anything.
 */
export function requestMixCheck(
  html: string,
  options: { duration: number; signal?: AbortSignal },
): Promise<MixCheckResult> {
  return new Promise<MixCheckResult>((resolve, reject) => {
    if (!html.includes("MOBILE_AGENT_VIDEO")) {
      reject(
        new Error(
          "The HTML does not implement the window.MOBILE_AGENT_VIDEO contract, so its mix cannot be checked.",
        ),
      );
      return;
    }

    if (!(options.duration > 0)) {
      reject(new Error("A positive video duration is required to check the mix."));
      return;
    }

    if (!hasMixCheckHost()) {
      reject(
        new Error(
          "Mix checks are only available on Android builds that include the mix host.",
        ),
      );
      return;
    }

    if (options.signal?.aborted) {
      reject(new Error("Mix check was cancelled."));
      return;
    }

    const job: MixCheckJob = {
      id: `mix-check-${++jobCounter}`,
      html,
      duration: options.duration,
      signal: options.signal,
      resolve,
      reject,
    };

    for (const listener of [...listeners]) {
      listener(job);
    }
  });
}
