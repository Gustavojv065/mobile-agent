import { describe, expect, it } from "vitest";

import { buildDocument } from "@/modules/documents";
import { snapshotDocxSpec } from "@/modules/documents/snapshot/docx-snapshot";

const CONTENT = `# The Solar System

An essay about our neighborhood in space.

## The Sun

The Sun is a star at the center of the system.
`;

async function buildStyledDocx(
  spec: Record<string, unknown>,
): Promise<Uint8Array> {
  const built = await buildDocument({
    format: "docx",
    content: CONTENT,
    fileName: "sample",
    spec,
  });

  return built.bytes;
}

describe("docx style snapshot", () => {
  it("captures fonts, page, headings, header/footer and TOC from a docx", async () => {
    const bytes = await buildStyledDocx({
      page: {
        size: "LETTER",
        orientation: "landscape",
        marginTopPt: 60,
        marginRightPt: 50,
        marginBottomPt: 40,
        marginLeftPt: 30,
      },
      fonts: {
        body: { family: "Georgia", sizePt: 12, color: "112233" },
        headings: { family: "Arial" },
      },
      headingStyles: {
        1: { sizePt: 26, color: "C00000" },
        3: { sizePt: 15 },
      },
      header: { text: "Confidential" },
      footer: { text: "Page {PAGE} of report" },
      includeToc: true,
    });

    const spec = await snapshotDocxSpec(bytes);

    expect(spec).not.toBeNull();
    expect(spec!.fonts.body.family).toBe("Georgia");
    expect(spec!.fonts.body.sizePt).toBe(12);
    expect(spec!.fonts.body.color).toBe("112233");
    expect(spec!.fonts.headings.family).toBe("Arial");
    expect(spec!.headingStyles[1].sizePt).toBe(26);
    expect(spec!.headingStyles[1].color).toBe("C00000");
    expect(spec!.headingStyles[3].sizePt).toBe(15);

    expect(spec!.page.size).toBe("LETTER");
    expect(spec!.page.orientation).toBe("landscape");
    expect(spec!.page.marginTopPt).toBe(60);
    expect(spec!.page.marginRightPt).toBe(50);
    expect(spec!.page.marginBottomPt).toBe(40);
    expect(spec!.page.marginLeftPt).toBe(30);

    expect(spec!.header.text).toBe("Confidential");
    expect(spec!.footer.text).toBe("Page {PAGE} of report");
    expect(spec!.includeToc).toBe(true);
  });

  it("falls back to defaults for a plain docx", async () => {
    const bytes = (await buildDocument({
      format: "docx",
      content: CONTENT,
      fileName: "plain",
    })).bytes;

    const spec = await snapshotDocxSpec(bytes);

    expect(spec).not.toBeNull();
    expect(spec!.fonts.body.family).toBe("Calibri");
    expect(spec!.page.size).toBe("A4");
    expect(spec!.page.orientation).toBe("portrait");
    expect(spec!.includeToc).toBe(false);
  });

  it("returns null for bytes that are not a docx package", async () => {
    expect(await snapshotDocxSpec(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});