import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFetchPageTool,
  extractPageText,
} from "@/modules/tools/built-in/fetch-page";

function makeTool() {
  return createFetchPageTool({ onRecord: vi.fn() } as never);
}

async function execute(tool: ReturnType<typeof makeTool>, input: object) {
  const def = tool as unknown as {
    execute: (input: object, opts: object) => Promise<unknown>;
  };
  return def.execute(input, {});
}

function mockHtml(html: string, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      url: "https://example.com/article",
      headers: {
        get: (name: string) =>
          headers[name.toLowerCase()] ??
          (name.toLowerCase() === "content-type" ? "text/html" : null),
      },
      text: async () => html,
    })),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractPageText", () => {
  it("keeps title, headings, and paragraphs while dropping scripts and tags", () => {
    const { title, text } = extractPageText(
      `<html><head><title>Test Page</title><style>.x{color:red}</style></head>` +
        `<body><script>alert(1)</script><h1>Hello</h1><p>World &amp; more</p></body></html>`,
    );
    expect(title).toBe("Test Page");
    expect(text).toContain("Hello");
    expect(text).toContain("World & more");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("<h1>");
  });

  it("decodes numeric entities", () => {
    const { text } = extractPageText("<p>&#65;&#x42;</p>");
    expect(text).toBe("AB");
  });
});

describe("fetchPage tool", () => {
  it("returns title and text for an HTML page", async () => {
    mockHtml("<html><head><title>Hi</title></head><body><p>Body text here.</p></body></html>");
    const out = (await execute(makeTool(), { url: "https://example.com/article" })) as Record<
      string,
      unknown
    >;
    expect(out.url).toBe("https://example.com/article");
    expect(out.title).toBe("Hi");
    expect(out.text).toContain("Body text here.");
    expect(out.truncated).toBe(false);
  });

  it("truncates long pages at maxChars", async () => {
    mockHtml(`<p>${"x".repeat(5000)}</p>`);
    const out = (await execute(makeTool(), { url: "https://example.com/a", maxChars: 500 })) as Record<
      string,
      unknown
    >;
    expect(out.truncated).toBe(true);
    expect((out.text as string).length).toBeLessThan(700);
  });

  it.each([
    "http://localhost:8080/x",
    "https://localhost/x",
    "http://127.0.0.1/x",
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest",
    "http://[::1]/x",
    "ftp://example.com/x",
  ])("blocks %s", async (url) => {
    const tool = makeTool();
    await expect(execute(tool, { url })).rejects.toThrow();
  });

  it("rejects non-HTML content types", async () => {
    mockHtml("%PDF-1.4", { "content-type": "application/pdf" });
    await expect(execute(makeTool(), { url: "https://example.com/f.pdf" })).rejects.toThrow(
      /content-type/i,
    );
  });

  it("reports HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        url: "https://example.com/missing",
        headers: { get: () => "text/html" },
        text: async () => "",
      })),
    );
    await expect(execute(makeTool(), { url: "https://example.com/missing" })).rejects.toThrow(
      /404/,
    );
  });
});
