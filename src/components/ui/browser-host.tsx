import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";

import {
  BROWSER_COMMAND_TIMEOUT_MS,
  BROWSER_HISTORY_SETTLE_MS,
  BROWSER_MAX_SLICES,
  BROWSER_PAGE_LOAD_TIMEOUT_MS,
  BROWSER_SETTLE_MS,
  BROWSER_SLICE_TIMEOUT_MS,
  browserCommandTimeoutError,
  browserLoadTimeoutError,
  subscribeBrowser,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserCommandWithResult,
} from "@/modules/preview/browser-session";
import { captureViewToTmpFile } from "@/modules/preview/view-shot";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
/** Overview: the CSS zoom floor — below this the overview is unreadable anyway. */
const OVERVIEW_MIN_ZOOM = 0.22;
/** Functional waits for in-page paints after zoom/scroll changes (not watchdogs). */
const ZOOM_SETTLE_MS = 450;
const SLICE_SETTLE_MS = 400;
/** A click/type may trigger navigation; give a cross-document load this window. */
const NAV_BOOT_WINDOW_MS = 2_500;

/**
 * In-page bridge, free of backticks and `${` (house style for injected
 * engines). Installs `window.__mobileAgentBrowser` on every document and
 * answers `run(requestId, jsonCommand)` over `ReactNativeWebView` with
 * `{ src: 'mobileAgentBrowser', requestId, status, result | message }`, plus
 * one `{ kind: 'boot' }` ping per load so the host knows a document is ready.
 * Selectors accept CSS or `text=...` (visible label text match) — clicking by
 * label is what agents actually do.
 */
const BRIDGE_SCRIPT = `(function () {
  if (window.__mobileAgentBrowser) return;
  function post(payload) {
    try {
      var out = { src: 'mobileAgentBrowser' };
      for (var k in payload) out[k] = payload[k];
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(out));
      }
    } catch (_) {}
  }
  function norm(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); }
  var TEXT_ELEMENTS = 'a,button,input,textarea,select,label,[role="button"],[role="link"],summary,option,td,th,h1,h2,h3,h4,h5,h6,li,p,span,div';
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function label(el) {
    return norm(el.value || el.placeholder || el.innerText || (el.getAttribute && el.getAttribute('aria-label')) || '');
  }
  function findTarget(selector) {
    var raw = String(selector == null ? '' : selector);
    if (raw.indexOf('text=') === 0) {
      var lowered = norm(raw.slice(5)).toLowerCase();
      var nodes = document.querySelectorAll(TEXT_ELEMENTS);
      var i;
      for (i = 0; i < nodes.length; i += 1) {
        if (!visible(nodes[i]) || !label(nodes[i])) continue;
        if (label(nodes[i]).toLowerCase() === lowered) return nodes[i];
      }
      for (i = 0; i < nodes.length; i += 1) {
        if (!visible(nodes[i]) || !label(nodes[i])) continue;
        if (label(nodes[i]).toLowerCase().indexOf(lowered) !== -1) return nodes[i];
      }
      return null;
    }
    return document.querySelector(raw);
  }
  function targetHeading(el) {
    var node = el;
    while (node && node !== document.body) {
      if (/^H[1-6]$/.test(node.tagName || '')) return label(node);
      node = node.parentElement;
    }
    return null;
  }
  function setValue(el, text) {
    if (el.isContentEditable) { el.innerText = text; return; }
    var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text); else el.value = text;
    ['input', 'change'].forEach(function (name) {
      try { el.dispatchEvent(new Event(name, { bubbles: true })); } catch (_) {}
    });
  }
  function submitKeyboard(target) {
    ['keydown', 'keypress', 'keyup'].forEach(function (name) {
      try {
        target.dispatchEvent(new KeyboardEvent(name, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      } catch (_) {}
    });
  }
  function collectLinks(limit) {
    var out = [];
    var nodes = document.querySelectorAll('a[href]');
    for (var i = 0; i < nodes.length && out.length < limit; i += 1) {
      var href = nodes[i].getAttribute('href');
      if (!href || href.indexOf('javascript:') === 0) continue;
      try { href = new URL(href, location.href).toString(); } catch (_) {}
      out.push({ href: href, text: norm(nodes[i].innerText) });
    }
    return out;
  }
  function dims() {
    var doc = document.documentElement;
    return {
      url: location.href,
      title: norm(document.title) || null,
      heading: null,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      contentH: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
      scrollY: window.scrollY,
      zoom: parseFloat(getComputedStyle(doc).zoom || '1')
    };
  }
  function afterPaint(fn) {
    requestAnimationFrame(function () { requestAnimationFrame(fn); });
  }
  var state = function () {
    return { url: location.href, title: norm(document.title) || null, heading: null };
  };
  var api = {
    state: state,
    scroll: function (opts) {
      if (opts && typeof opts.top === 'number') window.scrollTo(0, opts.top);
      else if (opts && typeof opts.dy === 'number') window.scrollBy(0, opts.dy);
      else window.scrollBy(0, window.innerHeight * 0.9);
      return new Promise(function (resolve) {
        afterPaint(function () {
          var d = dims();
          resolve({ url: location.href, title: norm(document.title) || null, heading: null, top: Math.round(d.scrollY), pageHeight: d.contentH, innerH: d.innerH });
        });
      });
    },
    click: function (selector) {
      var el = findTarget(selector);
      if (!el) throw new Error('No element matched ' + JSON.stringify(String(selector)) + ' on this page. Try text= with the visible label, or read the page first.');
      try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) { try { el.scrollIntoView(); } catch (_2) {} }
      try { el.focus({ preventScroll: true }); } catch (_) {}
      try { el.click(); } catch (e) { throw new Error('Could not click the element: ' + String((e && e.message) || e)); }
      return { url: location.href, title: norm(document.title) || null, heading: targetHeading(el), clicked: label(el) || String(el.tagName || '').toLowerCase() };
    },
    type: function (selector, text, submit) {
      var el = findTarget(selector);
      if (!el) throw new Error('No field matched ' + JSON.stringify(String(selector)) + ' on this page. Try text= with the visible label, or read the page first.');
      try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) { try { el.scrollIntoView(); } catch (_2) {} }
      try { el.focus({ preventScroll: true }); } catch (_) {}
      setValue(el, text == null ? '' : String(text));
      var didSubmit = false;
      if (submit) {
        didSubmit = true;
        var form = el.form || (el.closest ? el.closest('form') : null);
        if (form) {
          try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch (_) { submitKeyboard(el); }
        } else submitKeyboard(el);
      }
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({ url: location.href, title: norm(document.title) || null, heading: targetHeading(el), clicked: null, submit: !!didSubmit });
        }, 250);
      });
    },
    read: function (limit) {
      var text = '';
      try { text = norm(document.body ? document.body.innerText : document.documentElement.innerText); } catch (_) {}
      return { url: location.href, title: norm(document.title) || null, heading: null, text: text.slice(0, limit || 12000), links: collectLinks(60) };
    },
    dims: function () { return dims(); },
    zoom: function (scale) {
      var doc = document.documentElement;
      doc.style.zoom = String(scale);
      try { if (document.body) document.body.style.zoom = String(scale); } catch (_) {}
      return new Promise(function (resolve) {
        setTimeout(function () {
          window.scrollTo(0, 0);
          afterPaint(function () { resolve(dims()); });
        }, 60);
      });
    },
    resetZoom: function () {
      var doc = document.documentElement;
      doc.style.zoom = '';
      try { if (document.body) document.body.style.zoom = ''; } catch (_) {}
      return new Promise(function (resolve) {
        setTimeout(function () { afterPaint(function () { resolve(dims()); }); }, 60);
      });
    }
  };
  api.run = function (requestId, json) {
    var cmd;
    try { cmd = JSON.parse(json); } catch (e) {
      post({ requestId: requestId, status: 'error', message: 'Malformed browser command.' });
      return;
    }
    Promise.resolve().then(function () {
      if (cmd.kind === 'navigate') { location.replace(cmd.url); return { url: cmd.url, title: null, heading: null, navigated: true }; }
      if (cmd.kind === 'back') { history.back(); return { url: location.href, title: null, heading: null, navigated: true }; }
      if (cmd.kind === 'reload') { location.reload(); return { url: location.href, title: null, heading: null, navigated: true }; }
      if (cmd.kind === 'scroll') return api.scroll(cmd);
      if (cmd.kind === 'click') return api.click(cmd.selector);
      if (cmd.kind === 'type') return api.type(cmd.selector, cmd.text, cmd.submit);
      if (cmd.kind === 'read') return api.read(cmd.limit);
      if (cmd.kind === 'state') return state();
      if (cmd.kind === 'dims') return api.dims();
      if (cmd.kind === 'zoom') return api.zoom(cmd.scale);
      if (cmd.kind === 'resetZoom') return api.resetZoom();
      throw new Error('Unknown browser command: ' + String(cmd && cmd.kind));
    }).then(function (result) {
      post({ requestId: requestId, status: 'ok', result: result });
    }, function (error) {
      post({ requestId: requestId, status: 'error', message: String((error && error.message) || error) });
    });
  };
  window.__mobileAgentBrowser = api;
  post({ kind: 'boot', url: location.href, title: norm(document.title) || null });
})();`;

type PageResult = {
  url?: unknown;
  title?: unknown;
  heading?: unknown;
  clicked?: unknown;
  text?: unknown;
  links?: unknown;
  top?: unknown;
  pageHeight?: unknown;
  innerH?: unknown;
  contentH?: unknown;
  scrollY?: unknown;
  navigated?: unknown;
};

type BridgeMessage =
  | { type: "boot"; url: string; title: string | null }
  | { type: "command"; requestId: number; status: "ok"; result: PageResult }
  | { type: "command"; requestId: number; status: "error"; message: string };

function parseBridgeMessage(data: string): BridgeMessage | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.src !== "mobileAgentBrowser") return null;
    if (parsed.kind === "boot" && typeof parsed.url === "string") {
      return { type: "boot", url: parsed.url, title: typeof parsed.title === "string" ? parsed.title : null };
    }
    if (typeof parsed.requestId !== "number") return null;
    if (parsed.status === "ok") return { type: "command", requestId: parsed.requestId, status: "ok", result: (parsed.result ?? {}) as PageResult };
    if (parsed.status === "error") return { type: "command", requestId: parsed.requestId, status: "error", message: String(parsed.message ?? "Command failed.") };
    return null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the persistent hidden WebView behind the interactive `browser` tool.
 * Mounted once in the root layout; the page survives across commands so the
 * agent can open a site, click around, and sign in like a person — history,
 * cookies, and storage stay live between tool calls. Every dead end fails
 * loud inside a bound: loads must announce themselves with a boot ping,
 * commands are raced against the command timeout, and a crashed renderer
 * rejects the in-flight command with an explained error.
 */
export function BrowserHost() {
  const active = Platform.OS === "android";

  const [pending, setPending] = useState<BrowserCommandWithResult[]>([]);
  const [running, setRunning] = useState(false);
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  const webViewRef = useRef<WebView>(null);
  const jobRef = useRef<BrowserCommandWithResult | null>(null);
  const settledRef = useRef<WeakSet<BrowserCommandWithResult>>(new WeakSet());
  const abortCleanupRef = useRef<(() => void) | null>(null);
  const guardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootWaitersRef = useRef<Set<(boot: { url: string; title: string | null }) => void>>(new Set());
  const commandWaitersRef = useRef<Map<number, (message: BridgeMessage) => void>>(new Map());
  const requestIdRef = useRef(0);

  const settle = useCallback(
    (
      job: BrowserCommandWithResult,
      outcome: { type: "resolve"; result: BrowserCommandResult } | { type: "reject"; error: Error },
    ) => {
      if (settledRef.current.has(job)) return;
      settledRef.current.add(job);
      if (outcome.type === "resolve") job.resolve(outcome.result);
      else job.reject(outcome.error);
    },
    [],
  );

  const clearGuardTimer = useCallback(() => {
    if (guardTimerRef.current) {
      clearTimeout(guardTimerRef.current);
      guardTimerRef.current = null;
    }
  }, []);

  const finishJob = useCallback(() => {
    abortCleanupRef.current?.();
    abortCleanupRef.current = null;
    clearGuardTimer();
    jobRef.current = null;
    setRunning(false);
  }, [clearGuardTimer]);

  const stopActive = useCallback(
    (error: Error) => {
      const job = jobRef.current;
      if (job) settle(job, { type: "reject", error });
      finishJob();
    },
    [finishJob, settle],
  );

  /** Resolves the next boot ping (any new document announcement). */
  const nextBoot = useCallback(
    () =>
      new Promise<{ url: string; title: string | null }>((resolve) => {
        bootWaitersRef.current.add(resolve);
      }),
    [],
  );

  /** Races a wait against a window; timeouts are never an error here. */
  const nextBootWithin = useCallback(
    (windowMs: number) =>
      Promise.race([
        nextBoot(),
        delay(windowMs).then(() => null),
      ]),
    [nextBoot],
  );

  const postCommand = useCallback(
    (command: Record<string, unknown>): Promise<PageResult> => {
      const webView = webViewRef.current;
      if (!webView) return Promise.reject(new Error("The browser view is gone."));
      const requestId = ++requestIdRef.current;
      return new Promise<PageResult>((resolve, reject) => {
        commandWaitersRef.current.set(requestId, (message) => {
          commandWaitersRef.current.delete(requestId);
          if (message.type !== "command") return;
          if (message.status === "ok") resolve(message.result);
          else reject(new Error(message.message));
        });
        webView.injectJavaScript(
          `window.__mobileAgentBrowser ? window.__mobileAgentBrowser.run(${requestId}, ${JSON.stringify(
            JSON.stringify(command),
          )}) : window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ src: 'mobileAgentBrowser', requestId: ${requestId}, status: 'error', message: 'The browser bridge is not running on this page.' }));`,
        );
      });
    },
    [],
  );

  /** Final page state after a possibly-navigating command. */
  const finalState = useCallback(async (): Promise<PageResult> => postCommand({ kind: "state" }), [postCommand]);

  /** Sets the source state when the bridge cannot navigate in-page itself. */
  const navigateBySource = useCallback(
    (url: string) => {
      // The stored URL never changes again; later in-page navigation keeps
      // React out of the loop entirely.
      setPageUrl(url);
    },
    [],
  );

  const installBridge = useCallback(() => {
    webViewRef.current?.injectJavaScript(BRIDGE_SCRIPT);
  }, []);

  const beginNav = useCallback(
    async (command: BrowserCommand): Promise<PageResult> => {
      try {
        await postCommand(resolveNavCommand(command));
      } catch {
        // No bridge (first navigation on a bare page): swap the source.
        if (command.kind === "navigate") {
          navigateBySource(command.url);
        }
      }
      if (command.kind === "back") {
        // A cross-document back announces a new boot; single-page-app routers
        // (pushState) never do, so cap the wait and report where we are.
        const booted = await nextBootWithin(BROWSER_HISTORY_SETTLE_MS);
        if (booted) await delay(BROWSER_SETTLE_MS);
        else await delay(SLICE_SETTLE_MS);
      } else {
        await nextBoot();
        await delay(BROWSER_SETTLE_MS);
      }
      return finalState();
    },
    [finalState, nextBoot, nextBootWithin, postCommand, navigateBySource],
  );

  const beginMaybeNav = useCallback(
    async (selector: string, textToType: string | undefined, submit: boolean): Promise<PageResult> => {
      const result = await postCommand(
        textToType === undefined
          ? { kind: "click", selector }
          : { kind: "type", selector, text: textToType, submit },
      );
      const fresh = await nextBootWithin(NAV_BOOT_WINDOW_MS);
      if (fresh) await delay(BROWSER_SETTLE_MS);
      else await delay(SLICE_SETTLE_MS);
      const state = await finalState();
      // Merge without letting the state query's nulls clobber click details
      // (heading/clicked label travel only on the in-page result).
      return {
        ...result,
        url: text(state.url) ?? text(result.url),
        title: text(state.title) ?? text(result.title),
      };
    },
    [finalState, nextBootWithin, postCommand],
  );

  /** Full-page pipeline: zoomed-out overview, then top-to-bottom viewport slices. */
  const captureFullPage = useCallback(
    async (fullPage: boolean, maxSlices: number): Promise<BrowserCommandResult> => {
      const view = webViewRef.current;
      if (!view) throw new Error("The browser view is gone.");
      const d = await postCommand({ kind: "dims" });
      const innerH = num(d.innerH, VIEWPORT_HEIGHT);
      const contentH = Math.max(1, num(d.contentH, VIEWPORT_HEIGHT));

      const shots: { uri: string; top: number }[] = [];
      let overview: { uri: string; truncated: boolean } | null = null;

      // Viewport capture: whatever is on screen, no page-height gymnastics.
      if (!fullPage) {
        const uri = await captureViewToTmpFile(view, { format: "png", quality: 1, result: "tmpfile" }, "Page capture");
        shots.push({
          uri,
          top: Math.round(num(d.scrollY, 0)),
        });
        return {
          kind: "screenshot",
          fullPage: false,
          pageHeight: Math.round(contentH),
          truncated: false,
          shots,
          overview: null,
          url: text(d.url) ?? "",
          title: text(d.title) ?? null,
        };
      }

      // Content already fits the viewport: one capture is the whole page.
      if (contentH <= innerH * 1.05) {
        await postCommand({ kind: "scroll", top: 0 });
        await delay(SLICE_SETTLE_MS);
        const uri = await captureViewToTmpFile(view, { format: "png", quality: 1, result: "tmpfile" }, "Full-page capture");
        shots.push({ uri, top: 0 });
        return {
          kind: "screenshot",
          fullPage: true,
          pageHeight: Math.round(contentH),
          truncated: false,
          shots,
          overview: null,
          url: text(d.url) ?? "",
          title: text(d.title) ?? null,
        };
      }

      // 1. Overview: shrink the CSS layout so the whole page fits 800 px.
      const zoom = Math.max(OVERVIEW_MIN_ZOOM, Math.min(1, VIEWPORT_HEIGHT / contentH));
      if (zoom < 1) {
        const after = await postCommand({ kind: "zoom", scale: zoom });
        const zoomedH = num(after.contentH, contentH);
        // Chromium may refuse non-integer zooms; only trust an overview that
        // actually shrank the layout near the requested factor.
        if (zoomedH < contentH * (zoom + 0.25) && zoomedH > innerH * 0.5) {
          const uri = await captureViewToTmpFile(view, { format: "png", quality: 1, result: "tmpfile" }, "Full-page capture");
          overview = { uri, truncated: zoomedH > VIEWPORT_HEIGHT * 1.02 };
        }
        await postCommand({ kind: "resetZoom" });
        await delay(ZOOM_SETTLE_MS);
      }

      // 2. Slices at natural size, top to bottom.
      const step = Math.max(1, Math.floor(innerH));
      const totalSlices = Math.ceil(contentH / step);
      const budget = Math.max(1, Math.min(maxSlices, BROWSER_MAX_SLICES));
      const count = Math.min(totalSlices, budget);
      for (let i = 0; i < count; i += 1) {
        const top = i * step;
        await postCommand({ kind: "scroll", top });
        await delay(SLICE_SETTLE_MS);
        const uri = await captureViewToTmpFile(view, { format: "png", quality: 1, result: "tmpfile" }, "Full-page capture");
        shots.push({ uri, top });
      }
      return {
        kind: "screenshot",
        fullPage: true,
        pageHeight: Math.round(contentH),
        truncated: totalSlices > count,
        shots,
        overview,
        url: text(d.url) ?? "",
        title: text(d.title) ?? null,
      };
    },
    [postCommand],
  );

  const execute = useCallback(
    async (command: BrowserCommand): Promise<BrowserCommandResult> => {
      switch (command.kind) {
        case "navigate": {
          const state = await beginNav(command);
          return { kind: "navigate", url: text(state.url) ?? command.url, title: text(state.title) ?? null };
        }
        case "back": {
          const state = await beginNav(command);
          return { kind: "back", url: text(state.url) ?? "", title: text(state.title) ?? null };
        }
        case "reload": {
          const state = await beginNav(command);
          return { kind: "reload", url: text(state.url) ?? "", title: text(state.title) ?? null };
        }
        case "click": {
          const merged = await beginMaybeNav(command.selector, undefined, false);
          return { kind: "click", url: text(merged.url) ?? "", title: text(merged.title) ?? null, heading: text(merged.heading) ?? null };
        }
        case "type": {
          const merged = await beginMaybeNav(command.selector, command.text, command.submit === true);
          return { kind: "type", url: text(merged.url) ?? "", title: text(merged.title) ?? null, heading: text(merged.heading) ?? null, submit: command.submit === true };
        }
        case "scroll": {
          const result = await postCommand({ kind: "scroll", top: command.top, dy: command.dy });
          return {
            kind: "scroll",
            url: text(result.url) ?? "",
            title: text(result.title) ?? null,
            top: num(result.top, 0),
          };
        }
        case "read": {
          const result = await postCommand({ kind: "read" });
          const links = Array.isArray(result.links)
            ? result.links.filter(
                (item): item is { href: string; text: string } =>
                  typeof (item as { href?: unknown })?.href === "string",
              )
            : [];
          return {
            kind: "read",
            url: text(result.url) ?? "",
            title: text(result.title) ?? null,
            text: text(result.text) ?? "",
            links,
          };
        }
        case "screenshot": {
          return captureFullPage(command.fullPage === true, command.maxSlices ?? BROWSER_MAX_SLICES);
        }
      }
    },
    [beginMaybeNav, beginNav, captureFullPage, postCommand],
  );

  const runJob = useCallback(
    (job: BrowserCommandWithResult) => {
      jobRef.current = job;
      setRunning(true);
      installBridge();

      if (job.signal) {
        const onAbort = () => stopActive(new Error("Browser command was cancelled."));
        job.signal.addEventListener("abort", onAbort);
        abortCleanupRef.current = () => job.signal?.removeEventListener("abort", onAbort);
      }

      // One guard per command: loads get the load bound, everything else the
      // command bound (plus slice budget for full-page captures).
      const guard =
        job.command.kind === "navigate" || job.command.kind === "reload" || job.command.kind === "back"
          ? BROWSER_PAGE_LOAD_TIMEOUT_MS
          : job.command.kind === "screenshot" && job.command.fullPage
            ? BROWSER_COMMAND_TIMEOUT_MS +
              BROWSER_SLICE_TIMEOUT_MS * Math.min(job.command.maxSlices ?? BROWSER_MAX_SLICES, BROWSER_MAX_SLICES)
            : BROWSER_COMMAND_TIMEOUT_MS;
      guardTimerRef.current = setTimeout(() => {
        stopActive(
          job.command.kind === "navigate" || job.command.kind === "reload"
            ? browserLoadTimeoutError(job.command)
            : browserCommandTimeoutError(job.command),
        );
      }, guard);

      void (async () => {
        try {
          const result = await execute(job.command);
          if (jobRef.current !== job) return;
          settle(job, { type: "resolve", result });
          finishJob();
        } catch (error) {
          if (jobRef.current !== job) return;
          stopActive(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    },
    [execute, finishJob, installBridge, settle, stopActive],
  );

  // Drain the queue one command at a time.
  useEffect(() => {
    if (running || pending.length === 0) return;
    const [next, ...rest] = pending;
    setPending(rest);
    if (next.signal?.aborted) {
      settle(next, { type: "reject", error: new Error("Browser command was cancelled.") });
      return;
    }
    runJob(next);
  }, [pending, runJob, running, settle]);

  // Collect commands for as long as the browser is usable.
  useEffect(() => {
    if (!active) return;
    return subscribeBrowser((job) => {
      setPending((current) => [...current, job]);
    });
  }, [active]);

  // Reject whatever is in flight when the host goes away.
  useEffect(() => {
    return () => {
      const inFlight = jobRef.current;
      if (inFlight) {
        settle(inFlight, { type: "reject", error: new Error("The interactive browser was shut down.") });
      }
      abortCleanupRef.current?.();
      abortCleanupRef.current = null;
      clearGuardTimer();
    };
  }, [clearGuardTimer, settle]);

  const handleLoadEnd = useCallback(() => {
    // Safety net for pages where injectedJavaScript never ran.
    webViewRef.current?.injectJavaScript(
      "window.__mobileAgentBrowser || " + BRIDGE_SCRIPT,
    );
  }, []);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseBridgeMessage(event.nativeEvent.data);
      if (!message) return;
      if (message.type === "boot") {
        const waiters = [...bootWaitersRef.current];
        bootWaitersRef.current.clear();
        for (const waiter of waiters) waiter({ url: message.url, title: message.title });
        return;
      }
      const waiter = commandWaitersRef.current.get(message.requestId);
      if (waiter) waiter(message);
    },
    [],
  );

  const handleRenderProcessGone = useCallback(
    (event: { nativeEvent: { didCrash?: boolean } }) => {
      stopActive(
        new Error(
          event.nativeEvent.didCrash === true
            ? "Browser command failed: the page renderer crashed (the page may be too heavy or hostile). Navigate elsewhere and continue."
            : "Browser command failed: the page renderer was killed.",
        ),
      );
    },
    [stopActive],
  );

  // Main-document load failures (DNS/timeout resolve to here); subresource
  // 404s also surface as onHttpError, so that event is deliberately ignored —
  // a real dead page never boots and the load watchdog rejects instead.
  const handleWebViewError = useCallback(() => {
    stopActive(
      new Error("Browser command failed: the page could not load. Check the URL and try fetchPage for the raw text."),
    );
  }, [stopActive]);

  if (!active) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        backgroundColor: "#ffffff",
        height: VIEWPORT_HEIGHT,
        left: 0,
        opacity: 0.01,
        position: "absolute",
        top: 0,
        width: VIEWPORT_WIDTH,
      }}
    >
      <WebView
        ref={webViewRef}
        injectedJavaScript={BRIDGE_SCRIPT}
        originWhitelist={["http://*", "https://*", "about:*"]}
        onLoadEnd={handleLoadEnd}
        onMessage={handleMessage}
        onError={handleWebViewError}
        onRenderProcessGone={handleRenderProcessGone}
        setSupportMultipleWindows={false}
        source={{ uri: pageUrl ?? "about:blank" }}
        style={{ backgroundColor: "#ffffff", flex: 1 }}
      />
    </View>
  );
}

function resolveNavCommand(command: BrowserCommand): Record<string, unknown> {
  if (command.kind === "navigate") return { kind: "navigate", url: command.url };
  if (command.kind === "reload") return { kind: "reload" };
  return { kind: "back" };
}
