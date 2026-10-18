/**
 * Interactive-browser command queue.
 *
 * The agent drives ONE persistent hidden WebView through the `browser` tool:
 * navigate, back, reload, scroll, click, type, read the rendered page, and
 * screenshot the viewport / the full page (zoomed-out overview plus
 * top-to-bottom slices). State lives in the host between commands — history,
 * cookies, storage — so "open a site, click around" works like a session,
 * unlike the old one-shot `screenshotPage`.
 *
 * Like the other preview queues this module is pure (no react-native
 * imports) so it can be unit-tested in Node. The host component owns the
 * timers; only the numbers and the bounds-derived messages live here.
 */

export type BrowserTarget = {
  /** Absolute URL of the page, post-redirects. */
  url: string;
  title: string | null;
};

export type ReadLink = { href: string; text: string };

export type BrowserCommand =
  | { kind: "navigate"; url: string }
  | { kind: "back" }
  | { kind: "reload" }
  | { kind: "scroll"; dy?: number; top?: number }
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string; submit?: boolean }
  | { kind: "read" }
  | { kind: "screenshot"; fullPage?: boolean; maxSlices?: number };

export type BrowserCommandResult =
  | ({ kind: "navigate" } & BrowserTarget)
  | ({ kind: "back" } & BrowserTarget)
  | ({ kind: "reload" } & BrowserTarget)
  | ({ kind: "scroll"; top: number } & BrowserTarget)
  | ({ kind: "click"; heading: string | null } & BrowserTarget)
  | ({ kind: "type"; heading: string | null; submit: boolean } & BrowserTarget)
  | ({ kind: "read"; text: string; links: ReadLink[] } & BrowserTarget)
  | {
      kind: "screenshot";
      /** True when the caller asked for the whole page (slices present). */
      fullPage: boolean;
    } & BrowserCommandScreenshotPayload;

export type BrowserCommandScreenshotPayload = {
  /** Total rendered page height in CSS pixels. */
  pageHeight: number;
  /** True when the whole page never fit the slice budget. */
  truncated: boolean;
  /** Captured screens: one for a viewport shot, N top-to-bottom slices otherwise. */
  shots: { uri: string; top: number }[];
  /** Zoomed-out whole-page overview (full-page shots only). */
  overview: { uri: string; truncated: boolean } | null;
} & BrowserTarget;

export type BrowserCommandWithResult = {
  id: string;
  command: BrowserCommand;
  signal?: AbortSignal;
  resolve: (result: BrowserCommandResult) => void;
  reject: (error: Error) => void;
};

type BrowserCommandListener = (job: BrowserCommandWithResult) => void;

const listeners = new Set<BrowserCommandListener>();

let jobCounter = 0;

/** Registers the host that performs browser commands. Returns an unsubscribe. */
export function subscribeBrowser(listener: BrowserCommandListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when a mounted host can service browser commands on this platform. */
export function hasBrowserHost(): boolean {
  return listeners.size > 0;
}

/**
 * Enqueues one command against the persistent session; the host runs commands
 * one at a time in order, so a sequence from the tool keeps its semantics.
 */
export function requestBrowserCommand(options: {
  command: BrowserCommand;
  signal?: AbortSignal;
}): Promise<BrowserCommandResult> {
  const { command, signal } = options;
  if (signal?.aborted) {
    return Promise.reject(new Error("Browser command was cancelled."));
  }
  if (!hasBrowserHost()) {
    return Promise.reject(
      new Error("The interactive browser is only available on Android builds."),
    );
  }
  return new Promise<BrowserCommandResult>((resolve, reject) => {
    const job: BrowserCommandWithResult = {
      id: `browser-command-${++jobCounter}`,
      command,
      signal,
      resolve,
      reject,
    };
    for (const listener of [...listeners]) {
      listener(job);
    }
  });
}

/**
 * Time the host allows ONE page load (navigate/reload/back) to announce
 * itself. Long enough for slow public pages; short enough that a dead URL
 * fails inside the run instead of hanging it.
 */
export const BROWSER_PAGE_LOAD_TIMEOUT_MS = 45_000;

/** Time bound for one in-page command (scroll/click/type/read/screenshot). */
export const BROWSER_COMMAND_TIMEOUT_MS = 30_000;

/** Time added per screenshot slice (scroll + settle + capture). */
export const BROWSER_SLICE_TIMEOUT_MS = 4_000;

/** Back button on single-page apps never fires a new load; cap the settle. */
export const BROWSER_HISTORY_SETTLE_MS = 1_500;

/** Functional wait after a command for late paint (not a watchdog). */
export const BROWSER_SETTLE_MS = 1_200;

/** Uppercase bound of slices one screenshot command may take. */
export const BROWSER_MAX_SLICES = 8;

/** Fallback heading for click/type results when no heading was found. */
export function describeCommandDetails(command: BrowserCommand): string {
  switch (command.kind) {
    case "navigate":
      return command.url;
    case "click":
      return `click ${command.selector}`;
    case "type":
      return `type into ${command.selector}`;
    case "screenshot":
      return command.fullPage ? "full-page screenshot" : "viewport screenshot";
    default:
      return command.kind;
  }
}

/** The page never announced itself after a navigation command. */
export function browserLoadTimeoutError(command: BrowserCommand): Error {
  return new Error(
    `Browser navigation timed out after ${Math.round(BROWSER_PAGE_LOAD_TIMEOUT_MS / 1000)}s ` +
      `(${describeCommandDetails(command)}). The page may be unreachable or too slow — try again later or use fetchPage for its raw text.`,
  );
}

/** The page loaded but never answered the command. */
export function browserCommandTimeoutError(command: BrowserCommand): Error {
  return new Error(
    `Browser command timed out after ${Math.round(BROWSER_COMMAND_TIMEOUT_MS / 1000)}s ` +
      `(${describeCommandDetails(command)}). The page may be busy, or the selector matched nothing — try text= with the visible label or read the page first.`,
  );
}
