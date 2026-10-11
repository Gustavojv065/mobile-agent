import { describe, expect, it } from "vitest";

import {
  mergeSpecIntoSource,
  parseDocumentSource,
} from "@/modules/documents/source";

describe("parseDocumentSource", () => {
  it("returns plain content unchanged when there is no front-matter", () => {
    const result = parseDocumentSource("# Title\n\nBody text.\n");

    expect(result).toEqual({
      body: "# Title\n\nBody text.\n",
      hadFrontMatter: false,
      meta: {},
    });
  });

  it("parses a YAML front-matter block and keeps the body", () => {
    const result = parseDocumentSource(
      "---\ntitle: Report\nauthor: Ada\n---\n\n# Title\n\nBody.",
    );

    expect(result.hadFrontMatter).toBe(true);
    expect(result.meta).toEqual({ title: "Report", author: "Ada" });
    expect(result.body).toContain("# Title");
    expect(result.body).toContain("Body.");
  });

  it("exposes a format spec key", () => {
    const result = parseDocumentSource(
      "---\nformat:\n  page:\n    size: A5\n---\n\nBody.",
    );

    expect(result.meta.format).toEqual({ page: { size: "A5" } });
  });

  it("ignores malformed YAML and treats the content as body", () => {
    const content = "---\n\tbroken: [yaml\n---\n\nBody.";
    const result = parseDocumentSource(content);

    expect(result.hadFrontMatter).toBe(false);
    expect(result.body).toBe(content);
  });

  it("does not treat a mid-document horizontal rule as front-matter", () => {
    const content = "# Title\n\n---\n\nMore.";
    const result = parseDocumentSource(content);

    expect(result.hadFrontMatter).toBe(false);
    expect(result.body).toBe(content);
  });

  it("normalizes CRLF line endings before splitting", () => {
    const result = parseDocumentSource(
      "---\r\ntitle: Report\r\n---\r\n\r\nBody.",
    );

    expect(result.hadFrontMatter).toBe(true);
    expect(result.meta.title).toBe("Report");
  });
});

describe("mergeSpecIntoSource", () => {
  it("leaves content untouched without a spec", () => {
    const content = "# Plain\n\nText.";

    expect(mergeSpecIntoSource(content, undefined)).toBe(content);
    expect(mergeSpecIntoSource(content, null)).toBe(content);
  });

  it("adds a front-matter format block to content without one", () => {
    const merged = mergeSpecIntoSource("# Title\n\nBody.", {
      page: { size: "A5" },
    });

    const reparsed = parseDocumentSource(merged);

    expect(reparsed.hadFrontMatter).toBe(true);
    expect(reparsed.meta.format).toEqual({ page: { size: "A5" } });
    expect(reparsed.body).toContain("# Title");
    expect(reparsed.body).not.toContain("format:");
  });

  it("replaces the format key but keeps other front-matter keys", () => {
    const content = "---\ntitle: Keep Me\nformat:\n  page:\n    size: A4\n---\n\nBody.";
    const merged = mergeSpecIntoSource(content, { page: { size: "LETTER" } });

    const reparsed = parseDocumentSource(merged);

    expect(reparsed.meta.title).toBe("Keep Me");
    expect(reparsed.meta.format).toEqual({ page: { size: "LETTER" } });
    expect(reparsed.body).toContain("Body.");
    expect(reparsed.body).not.toContain("size: A4");
    expect(reparsed.body).not.toContain("format:");
  });

  it("round-trips through parseDocumentSource", () => {
    const spec = {
      page: { size: "LETTER", orientation: "landscape" },
      footer: { text: "Page {PAGE}" },
    };
    const merged = mergeSpecIntoSource("Body.", spec);
    const reparsed = parseDocumentSource(merged);

    expect(reparsed.meta.format).toEqual(spec);
  });
});