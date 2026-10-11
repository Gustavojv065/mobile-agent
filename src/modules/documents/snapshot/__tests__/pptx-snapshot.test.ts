import { describe, expect, it } from "vitest";

import { buildPptx } from "@/modules/documents/pptx";
import { snapshotPptxSpec } from "@/modules/documents/snapshot/pptx-snapshot";
import { parsePptxSpec } from "@/modules/documents/spec/pptx-spec";

const DECK = `# The Solar System

An essay about our neighborhood in space.

- Mercury
- Venus
- Earth
`;

describe("pptx snapshot", () => {
  it("returns null for bytes that are not a pptx package", async () => {
    expect(await snapshotPptxSpec(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("recovers the approximate styling of its own default output", async () => {
    const bytes = await buildPptx({
      content: DECK,
      fileName: "default.pptx",
      spec: parsePptxSpec({}),
    });

    const snapshot = await snapshotPptxSpec(bytes);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.presentation.layout).toBe("16x9");
    expect(snapshot!.theme.headFontFace).toBe("Calibri Light");
    expect(snapshot!.theme.bodyFontFace).toBe("Calibri");
    expect(snapshot!.title.font).toMatchObject({ sizePt: 28, color: "1A1A1A" });
    expect(snapshot!.body.font).toMatchObject({ sizePt: 18, color: "333333" });
    // Headings inside the body do not change the dominant body face.
    expect(snapshot!.body.font.family).toBe("Calibri");
  });

  it("recovers custom fonts, sizes and colors", async () => {
    const spec = parsePptxSpec({
      presentation: { layout: "wide" },
      theme: { headFontFace: "Georgia", bodyFontFace: "Cambria" },
      title: { font: { family: "Georgia", sizePt: 40, color: "1F4E78", bold: true } },
      body: { font: { family: "Cambria", sizePt: 22, color: "222222" } },
    });

    const bytes = await buildPptx({
      content: DECK,
      fileName: "styled.pptx",
      spec,
    });

    const snapshot = await snapshotPptxSpec(bytes);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.presentation.layout).toBe("wide");
    expect(snapshot!.theme.headFontFace).toBe("Georgia");
    expect(snapshot!.theme.bodyFontFace).toBe("Cambria");
    expect(snapshot!.title.font).toMatchObject({
      sizePt: 40,
      color: "1F4E78",
      bold: true,
    });
    expect(snapshot!.body.font).toMatchObject({
      sizePt: 22,
      color: "222222",
      bold: false,
    });
  });

  it("is stable when re-snapshotted from its own output", async () => {
    const specA = parsePptxSpec({
      presentation: { layout: "4x3" },
      title: { font: { sizePt: 34, color: "0B5394", bold: true } },
      body: { font: { sizePt: 16, color: "444444" } },
    });

    const bytesA = await buildPptx({ content: DECK, fileName: "a.pptx", spec: specA });
    const specB = await snapshotPptxSpec(bytesA);
    const bytesB = await buildPptx({
      content: DECK,
      fileName: "b.pptx",
      spec: specB!,
    });
    const specC = await snapshotPptxSpec(bytesB);

    expect(specB).not.toBeNull();
    expect(specC).not.toBeNull();

    expect(specC!.presentation.layout).toBe("4x3");
    expect(specC!.title.font.sizePt).toBe(specB!.title.font.sizePt);
    expect(specC!.title.font.color).toBe(specB!.title.font.color);
    expect(specC!.title.font.bold).toBe(specB!.title.font.bold);
    expect(specC!.body.font.sizePt).toBe(specB!.body.font.sizePt);
    expect(specC!.body.font.color).toBe(specB!.body.font.color);
    expect(specC!.body.font.bold).toBe(specB!.body.font.bold);
  });
});