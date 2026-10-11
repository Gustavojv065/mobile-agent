/**
 * Auto-export support for the `html-video` skill.
 *
 * The agent writes the `window.MOBILE_AGENT_VIDEO` contract into the HTML it
 * generates. When the user asked for the finished file ("make me a video and
 * give me the MP4"), the skill also adds a
 * `<meta name="mobile-agent-video" content="auto-export">` tag to the head.
 * The chat layer detects that combination and enqueues the document here; the
 * app-level {@link AutoVideoExportHost} (rendered in the root layout) records
 * it in a hidden WebView and saves the MP4 to Downloads — no preview, no taps.
 *
 * This module is intentionally pure (no react-native imports) so it can be
 * unit-tested in Node.
 */

export const AUTO_EXPORT_META_NAME = "mobile-agent-video";
export const AUTO_EXPORT_META_CONTENT = "auto-export";

/** A code block must stop changing for this long before it is queued, so a
 *  streaming delta is never recorded as the final document. */
export const AUTO_EXPORT_STABILITY_MS = 800;

export type AutoExportRequest = {
  html: string;
};

type AutoExportListener = (request: AutoExportRequest) => void;

const listeners = new Set<AutoExportListener>();

// Exact HTML documents seen so far. Streaming re-renders produce the same
// final string many times; enqueue must fire exactly once per document.
const seenHtml = new Set<string>();
const SEEN_HTML_LIMIT = 24;

export function detectAutoExportHtml(html: string): boolean {
  return (
    html.includes("MOBILE_AGENT_VIDEO") &&
    html.includes(`name="${AUTO_EXPORT_META_NAME}"`) &&
    html.includes(`content="${AUTO_EXPORT_META_CONTENT}"`)
  );
}

/** Enqueues a document for auto-export. Returns false when the exact document
 *  was already enqueued (duplicate renders are skipped). */
export function enqueueAutoExport(html: string): boolean {
  if (seenHtml.has(html)) return false;
  seenHtml.add(html);
  if (seenHtml.size > SEEN_HTML_LIMIT) {
    const oldest = seenHtml.values().next().value as string | undefined;
    if (oldest !== undefined) seenHtml.delete(oldest);
  }

  const request: AutoExportRequest = { html };
  for (const listener of [...listeners]) listener(request);
  return true;
}

/** Registers a listener for auto-export requests. Returns an unsubscribe. */
export function subscribeAutoExport(listener: AutoExportListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}