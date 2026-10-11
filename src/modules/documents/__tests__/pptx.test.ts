import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { buildDocument } from "@/modules/documents";

const SAMPLE = `# The Solar System

An essay about our neighborhood in space.

## The Sun

The Sun is a star at the center of the system.

- Mercury
- Venus
- Earth

## The Planets

| Planet | Type | Moons |
| --- | --- | --- |
| Mars | Rocky | 2 |
| Jupiter | Gas giant | 95 |

\`\`\`js
const planets = 8;
\`\`\`

---

## Conclusion

We are small.
`;

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function unzip(bytes: Uint8Array) {
  return JSZip.loadAsync(bytes);
}

async function slideCount(bytes: Uint8Array): Promise<number> {
  const zip = await unzip(bytes);

  return Object.keys(zip.files).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  ).length;
}

describe("pptx builder", () => {
  it("builds a valid default deck with one slide per heading", async () => {
    const built = await buildDocument({
      format: "pptx",
      content: SAMPLE,
      fileName: "solar-system",
    });

    expect(built.format).toBe("pptx");
    expect(built.fileName).toBe("solar-system.pptx");
    expect(new TextDecoder().decode(built.bytes.subarray(0, 2))).toBe("PK");

    const zip = await unzip(built.bytes);
    const presentation = await zip.file("ppt/presentation.xml")?.async("string");

    expect(presentation).toBeDefined();
    // LAYOUT_16x9 = 10 x 5.625 inches, in EMU.
    expect(presentation).toContain('sldSz cx="9144000" cy="5143500"');
    expect(await slideCount(built.bytes)).toBeGreaterThanOrEqual(3);

    const slide1 = await zip.file("ppt/slides/slide1.xml")?.async("string");

    expect(slide1).toContain("The Solar System");
    expect(slide1).toContain('val="1A1A1A"'); // default title color
    expect(slide1).toContain('val="333333"'); // default body color

    const theme = await zip.file("ppt/theme/theme1.xml")?.async("string");

    expect(theme).toContain("Calibri Light");
    expect(theme).toContain("Calibri");
  });

  it("applies a full front-matter spec to the deck", async () => {
    const STYLED = `---
format:
  presentation:
    layout: wide
    title: "Solar System Deck"
  cover:
    enabled: true
    subtitle: "By the science team"
  background:
    color: "#fff8e1"
  theme:
    headFontFace: Georgia
    bodyFontFace: Cambria
  title:
    font:
      color: "#1f4e78"
      sizePt: 32
  body:
    font:
      color: "#222222"
      sizePt: 20
  footer:
    text: "Confidential"
  slideNumber:
    show: true
---

# The Solar System

An essay about our neighborhood in space.
`;

    const built = await buildDocument({
      format: "pptx",
      content: STYLED,
      fileName: "styled-deck",
    });

    const zip = await unzip(built.bytes);
    const presentation = await zip.file("ppt/presentation.xml")?.async("string");

    // LAYOUT_WIDE = 13.333 x 7.5 inches, in EMU.
    expect(presentation).toContain('sldSz cx="12192000" cy="6858000"');

    const slides = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort();

    expect(slides.length).toBeGreaterThanOrEqual(2); // cover + content

    const slide1 = await zip.file("ppt/slides/slide1.xml")?.async("string");

    expect(slide1).toContain("By the science team");
    expect(slide1).toContain("Solar System Deck");
    expect(slide1).toContain("1F4E78"); // title color
    expect(slide1).toContain("FFF8E1"); // background color

    const slide2 = await zip.file("ppt/slides/slide2.xml")?.async("string");

    expect(slide2).toContain("Confidential"); // footer text
    expect(slide2).toContain("slidenum"); // slide number field
    expect(slide2).toContain("222222"); // body color
    expect(slide2).toContain("sz=\"2000\"");

    const theme = await zip.file("ppt/theme/theme1.xml")?.async("string");

    expect(theme).toContain("Georgia");
    expect(theme).toContain("Cambria");
  });

  it("embeds a data-URI image on its own slide", async () => {
    const WITH_IMAGE = `# The Solar System

![Tiny](data:image/png;base64,${ONE_PX_PNG})
`;

    const built = await buildDocument({
      format: "pptx",
      content: WITH_IMAGE,
      fileName: "with-image",
    });

    const zip = await unzip(built.bytes);
    const media = Object.keys(zip.files).filter((name) =>
      name.startsWith("ppt/media/"),
    );

    expect(media.length).toBeGreaterThan(0);
    expect(media.some((name) => name.endsWith(".png"))).toBe(true);
  });
});