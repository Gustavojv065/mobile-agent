import { describe, expect, it } from "vitest";

import {
  defaultPdfSpec,
  parsePdfSpec,
  pdfPageSizePt,
  PDF_PAGE_SIZE_PT,
} from "@/modules/documents/spec/pdf-spec";

describe("pdf spec", () => {
  it("resolves full defaults for an empty spec", () => {
    const spec = parsePdfSpec({});

    expect(spec.page).toMatchObject({
      size: "A4",
      orientation: "portrait",
      marginTopPt: 72,
      marginRightPt: 72,
      marginBottomPt: 72,
      marginLeftPt: 72,
    });
    expect(spec.fonts.body).toMatchObject({
      family: "Calibri",
      sizePt: 11,
      color: "000000",
    });
    expect(spec.headingStyles[1]).toMatchObject({ sizePt: 20, bold: true });
    expect(spec.paragraphs).toMatchObject({ spacingAfterPt: 8, lineSpacing: 1.15 });
    expect(spec.codeBlock).toMatchObject({ background: "F2F2F2" });
    expect(spec.tables.headerBold).toBe(true);
    expect(spec.pageNumberPosition).toBe("center");
    expect(spec.header.text).toBe("");
    expect(spec.footer.text).toBe("");
    expect(pdfPageSizePt(spec)).toEqual(PDF_PAGE_SIZE_PT.A4);
  });

  it("defaults match the exported defaultPdfSpec", () => {
    expect(parsePdfSpec({})).toEqual(defaultPdfSpec());
  });

  it("merges partial specs onto defaults", () => {
    const spec = parsePdfSpec({
      page: { size: "LETTER", orientation: "landscape" },
      fonts: { body: { family: "Georgia", sizePt: 12 } },
      headingStyles: { 1: { color: "#1f4e78" } },
      footer: { text: "Page {PAGE}" },
    });

    expect(spec.page.size).toBe("LETTER");
    expect(spec.page.orientation).toBe("landscape");
    expect(spec.fonts.body.family).toBe("Georgia");
    expect(spec.fonts.body.sizePt).toBe(12);
    // Untouched fields survive the merge.
    expect(spec.fonts.body.color).toBe("000000");
    expect(spec.headingStyles[1].sizePt).toBe(20);
    expect(spec.headingStyles[1].color).toBe("1F4E78");
    expect(spec.footer.text).toBe("Page {PAGE}");
  });

  it("swaps width and height for landscape pages", () => {
    const spec = parsePdfSpec({ page: { size: "A4", orientation: "landscape" } });

    expect(pdfPageSizePt(spec)).toEqual({
      width: PDF_PAGE_SIZE_PT.A4.height,
      height: PDF_PAGE_SIZE_PT.A4.width,
    });
  });

  it("rejects invalid specs with a clear message", () => {
    expect(() => parsePdfSpec({ page: { size: "POSTCARD" } })).toThrow(
      /Invalid pdf spec/,
    );
    expect(() => parsePdfSpec({ paragraphs: { alignment: "middle" } })).toThrow(
      /Invalid pdf spec/,
    );
    expect(() => parsePdfSpec({ fonts: { body: { color: "red" } } })).toThrow(
      /Invalid pdf spec/,
    );
    // Unknown keys are stripped, not rejected.
    expect(() => parsePdfSpec({ colors: "red" })).not.toThrow();
  });
});