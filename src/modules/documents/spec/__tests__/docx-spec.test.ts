import { describe, expect, it } from "vitest";

import {
  defaultDocxSpec,
  parseDocxSpec,
} from "@/modules/documents/spec/docx-spec";

describe("docx spec", () => {
  it("resolves full defaults for an empty spec", () => {
    const spec = parseDocxSpec({});

    expect(spec.page).toMatchObject({
      size: "A4",
      orientation: "portrait",
      marginTopPt: 72,
    });
    expect(spec.fonts.body).toMatchObject({ family: "Calibri", sizePt: 11 });
    expect(spec.fonts.headings.family).toBe("Calibri");
    expect(spec.headingStyles[1]).toMatchObject({ sizePt: 20, bold: true });
    expect(spec.headingStyles[6].sizePt).toBe(12);
    expect(spec.codeBlock.background).toBe("F2F2F2");
    expect(spec.tables.headerBackground).toBe("E8E8E8");
    expect(spec.header.text).toBe("");
    expect(spec.footer.text).toBe("");
    expect(spec.includeToc).toBe(false);
    expect(spec.images.defaultWidthPx).toBe(400);
  });

  it("defaults match the exported defaultDocxSpec", () => {
    expect(parseDocxSpec({})).toEqual(defaultDocxSpec());
  });

  it("merges partial specs onto defaults", () => {
    const spec = parseDocxSpec({
      page: { size: "LETTER" },
      fonts: { body: { family: "Georgia" } },
    });

    expect(spec.page.size).toBe("LETTER");
    expect(spec.page.orientation).toBe("portrait");
    expect(spec.page.marginTopPt).toBe(72);
    expect(spec.fonts.body.family).toBe("Georgia");
    expect(spec.fonts.body.sizePt).toBe(11);
    expect(spec.fonts.headings.family).toBe("Calibri");
  });

  it("merges nested per-level heading overrides", () => {
    const spec = parseDocxSpec({
      headingStyles: { 1: { sizePt: 28, color: "#C00000" } },
    });

    expect(spec.headingStyles[1].sizePt).toBe(28);
    expect(spec.headingStyles[1].color).toBe("C00000");
    expect(spec.headingStyles[2].sizePt).toBe(16);
  });

  it("normalizes hex colors", () => {
    const spec = parseDocxSpec({
      tables: { headerBackground: "#e8E8e8" },
      codeBlock: { background: "F2F2F2" },
    });

    expect(spec.tables.headerBackground).toBe("E8E8E8");
    expect(spec.codeBlock.background).toBe("F2F2F2");
  });

  it("rejects invalid specs with a helpful error", () => {
    expect(() => parseDocxSpec({ page: { size: "NOPE" } })).toThrow(
      /Invalid docx spec/,
    );
    expect(() =>
      parseDocxSpec({ fonts: { body: { family: "" } } }),
    ).toThrow(/Invalid docx spec/);
    expect(() =>
      parseDocxSpec({ codeBlock: { background: "red" } }),
    ).toThrow(/hex color/);
    expect(() => parseDocxSpec({ headings: { spacingBeforePt: -5 } })).toThrow(
      /Invalid docx spec/,
    );
  });

  it("rejects non-object input", () => {
    expect(() => parseDocxSpec("nope")).toThrow(/expected an object/);
  });

  it("lists every heading level 1 to 6", () => {
    const spec = parseDocxSpec({});

    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(spec.headingStyles[level as 1 | 2 | 3 | 4 | 5 | 6].sizePt).toBeTypeOf(
        "number",
      );
    }
  });
});