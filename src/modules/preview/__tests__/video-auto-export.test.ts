import { describe, expect, it, vi } from "vitest";

import {
  AUTO_EXPORT_META_CONTENT,
  AUTO_EXPORT_META_NAME,
  detectAutoExportHtml,
  enqueueAutoExport,
  subscribeAutoExport,
} from "@/modules/preview/video-auto-export";

const CONTRACT = "window.MOBILE_AGENT_VIDEO = { duration: 10, render: function (t) {} };";

function autoExportHtml(body: string) {
  return `<html><head><meta name="${AUTO_EXPORT_META_NAME}" content="${AUTO_EXPORT_META_CONTENT}"></head><body>${body}</body></html>`;
}

describe("detectAutoExportHtml", () => {
  it("accepts documents with the contract and the auto-export meta tag", () => {
    expect(detectAutoExportHtml(autoExportHtml(`<script>${CONTRACT}</script>`))).toBe(true);
  });

  it("rejects documents without the meta tag", () => {
    expect(detectAutoExportHtml(`<html><script>${CONTRACT}</script></html>`)).toBe(false);
  });

  it("rejects documents without the video contract", () => {
    expect(detectAutoExportHtml(autoExportHtml("<canvas></canvas>"))).toBe(false);
  });

  it("rejects empty or unrelated html", () => {
    expect(detectAutoExportHtml("")).toBe(false);
    expect(detectAutoExportHtml("<p>hello</p>")).toBe(false);
    expect(detectAutoExportHtml("just some text")).toBe(false);
  });
});

describe("auto-export queue", () => {
  it("delivers each unique document exactly once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAutoExport(listener);
    const html = autoExportHtml(`<script>${CONTRACT}</script>`);

    expect(enqueueAutoExport(html)).toBe(true);
    expect(enqueueAutoExport(html)).toBe(false);
    expect(enqueueAutoExport(html)).toBe(false);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ html });

    unsubscribe();
  });

  it("delivers distinct documents in enqueue order", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAutoExport(listener);
    const first = autoExportHtml("<canvas id='a'></canvas>");
    const second = autoExportHtml("<canvas id='b'></canvas>");

    enqueueAutoExport(first);
    enqueueAutoExport(second);

    expect(listener.mock.calls.map(([request]) => request.html)).toEqual([
      first,
      second,
    ]);

    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAutoExport(listener);

    enqueueAutoExport(autoExportHtml("<canvas id='c'></canvas>"));
    unsubscribe();
    enqueueAutoExport(autoExportHtml("<canvas id='d'></canvas>"));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});