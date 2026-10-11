import { describe, expect, it } from "vitest";

import {
  defaultPptxSpec,
  parsePptxSpec,
  PPTX_LAYOUT_SIZES,
  pptxSlideSize,
} from "@/modules/documents/spec/pptx-spec";

describe("pptx spec", () => {
  it("resolves full defaults for an empty spec", () => {
    const spec = parsePptxSpec({});

    expect(spec.presentation).toMatchObject({
      layout: "16x9",
      rtlMode: false,
    });
    expect(spec.presentation.title).toBeUndefined();
    expect(spec.cover.enabled).toBe(false);
    expect(spec.background.color).toBe("FFFFFF");
    expect(spec.title.font).toMatchObject({ sizePt: 28, color: "1A1A1A", bold: true });
    expect(spec.body.font).toMatchObject({ family: "Calibri", sizePt: 18, color: "333333" });
    expect(spec.body.bullet.enabled).toBe(true);
    expect(spec.body.autoFit).toBe(true);
    expect(spec.code.fontFamily).toBe("Courier New");
    expect(spec.table.headerBold).toBe(true);
    expect(spec.slideNumber.show).toBe(false);
    expect(pptxSlideSize(spec)).toEqual(PPTX_LAYOUT_SIZES["16x9"]);
  });

  it("defaults match the exported defaultPptxSpec", () => {
    expect(parsePptxSpec({})).toEqual(defaultPptxSpec());
  });

  it("merges partial specs onto defaults", () => {
    const spec = parsePptxSpec({
      presentation: { layout: "wide" },
      theme: { bodyFontFace: "Georgia" },
      body: { font: { family: "Georgia", sizePt: 20 } },
      title: { font: { color: "#1f4e78" } },
    });

    expect(spec.presentation.layout).toBe("wide");
    expect(pptxSlideSize(spec)).toEqual(PPTX_LAYOUT_SIZES["wide"]);
    expect(spec.theme.bodyFontFace).toBe("Georgia");
    expect(spec.body.font.family).toBe("Georgia");
    expect(spec.body.font.sizePt).toBe(20);
    // Untouched fields survive the merge.
    expect(spec.body.font.color).toBe("333333");
    // Colors are normalized (strip #, uppercase).
    expect(spec.title.font.color).toBe("1F4E78");
    expect(spec.cover.enabled).toBe(false);
  });

  it("uses explicit size for a custom layout", () => {
    const spec = parsePptxSpec({
      presentation: { layout: "custom", widthIn: 12, heightIn: 8 },
    });

    expect(pptxSlideSize(spec)).toEqual({ widthIn: 12, heightIn: 8 });
  });

  it("rejects invalid specs with a clear message", () => {
    expect(() =>
      parsePptxSpec({ body: { align: "diagonal" } }),
    ).toThrow(/Invalid pptx spec/);
    expect(() =>
      parsePptxSpec({ presentation: { layout: "letter" } }),
    ).toThrow(/Invalid pptx spec/);
    expect(() =>
      parsePptxSpec({ background: { color: "red" } }),
    ).toThrow(/Invalid pptx spec/);
    // Unknown keys are stripped, not rejected.
    expect(() => parsePptxSpec({ colors: "red" })).not.toThrow();
  });

  it("normalizes colors by stripping # and uppercasing", () => {
    const spec = parsePptxSpec({ footer: { color: "#abcdef" } });
    expect(spec.footer.color).toBe("ABCDEF");
  });
});