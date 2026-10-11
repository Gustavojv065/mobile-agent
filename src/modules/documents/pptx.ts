import PptxGenJS from "pptxgenjs";

import { parseMarkdownBlocks } from "@/modules/documents/markdown";
import {
  parsePptxSpec,
  pptxSlideSize,
  type PptxSpec,
} from "@/modules/documents/spec/pptx-spec";
import type { DocumentBlock, InlineRun } from "@/modules/documents/types";

const LINK_COLOR = "0563C1";

const PRESET_LAYOUT_NAMES: Record<string, string> = {
  "16x9": "LAYOUT_16x9",
  "16x10": "LAYOUT_16x10",
  "4x3": "LAYOUT_4x3",
  wide: "LAYOUT_WIDE",
};

type SlidePlan = {
  blocks: DocumentBlock[];
  title: string;
};

// ---------------------------------------------------------------------------
// Slide planning (headings level <= 2 start a slide; --- forces a page break)
// ---------------------------------------------------------------------------

function planSlides(
  blocks: DocumentBlock[],
  defaultTitle: string,
): SlidePlan[] {
  const slides: SlidePlan[] = [];
  let current: SlidePlan = { title: defaultTitle, blocks: [] };
  let started = false;

  const push = () => {
    if (current.blocks.length > 0 || current.title !== defaultTitle) {
      slides.push(current);
    }
  };

  for (const block of blocks) {
    if (block.type === "heading" && block.level <= 2) {
      if (started) {
        push();
      }

      current = { title: block.text, blocks: [] };
      started = true;
      continue;
    }

    if (block.type === "pageBreak") {
      push();
      current = { title: current.title, blocks: [] };
      started = true;
      continue;
    }

    started = true;
    current.blocks.push(block);
  }

  slides.push(current);

  return slides.filter(
    (slide) => slide.blocks.length > 0 || slide.title !== defaultTitle,
  );
}

function collectTables(
  blocks: DocumentBlock[],
): Extract<DocumentBlock, { type: "table" }>[] {
  return blocks.filter(
    (block): block is Extract<DocumentBlock, { type: "table" }> =>
      block.type === "table",
  );
}

function collectImages(
  blocks: DocumentBlock[],
): Extract<DocumentBlock, { type: "image" }>[] {
  return blocks.filter(
    (block): block is Extract<DocumentBlock, { type: "image" }> =>
      block.type === "image",
  );
}

function countBodyLines(blocks: DocumentBlock[]): number {
  let count = 0;

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        count += 1;
        break;
      case "list":
        count += Math.max(1, block.items.length);
        break;
      case "code":
        count += Math.max(1, block.text.split("\n").length);
        break;
      default:
        break;
    }
  }

  return count;
}

function effectiveBodySizePt(lineCount: number, spec: PptxSpec): number {
  const base = spec.body.font.sizePt;

  if (!spec.body.autoFit) {
    return base;
  }

  let size = base;

  if (lineCount > 9) {
    size = Math.min(size, 12);
  } else if (lineCount > 5) {
    size = Math.min(size, 15);
  }

  return Math.max(spec.body.minFontSizePt, size);
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

type InlineItem = { options: Record<string, unknown>; text: string };

function bulletOptions(spec: PptxSpec): Record<string, unknown> | undefined {
  if (!spec.body.bullet.enabled) {
    return undefined;
  }

  const character = spec.body.bullet.character;
  const characterCode = character.codePointAt(0)?.toString(16).toUpperCase();

  return {
    type: "bullet",
    characterCode: characterCode || "2022",
    color: spec.body.bullet.color,
    indent: 12,
  };
}

function inlineToItems(
  runs: InlineRun[],
  spec: PptxSpec,
  options: {
    baseSizePt: number;
    bold?: boolean;
    bullet?: boolean;
    breakLine?: boolean;
    color?: string;
    indentLevel?: number;
    paraSpaceAfterPt?: number;
    paraSpaceBeforePt?: number;
    sizePt?: number;
  },
): InlineItem[] {
  const usable = runs.filter((run) => run.text.length > 0);
  const effective = usable.length > 0 ? usable : [{ text: " " }];
  const bullet = options.bullet ? bulletOptions(spec) : undefined;

  return effective.map((run, index) => {
    const isLast = index === effective.length - 1;
    const runOptions: Record<string, unknown> = {
      fontFace: run.code ? spec.code.fontFamily : spec.body.font.family,
      breakLine: isLast && (options.breakLine ?? true),
    };

    const sizePt = options.sizePt ?? options.baseSizePt;

    if (sizePt) {
      runOptions.fontSize = sizePt;
    }

    const color =
      options.color ??
      (run.code
        ? spec.code.color
        : run.href
          ? LINK_COLOR
          : spec.body.font.color);

    runOptions.color = color;

    if (options.bold || run.bold || spec.body.font.bold) {
      runOptions.bold = true;
    }

    if (run.italic || spec.body.font.italic) {
      runOptions.italic = true;
    }

    if (run.href) {
      runOptions.underline = { style: "sng" };
      runOptions.hyperlink = { url: run.href };
    } else if (spec.body.font.underline) {
      runOptions.underline = { style: "sng" };
    }

    if (run.code && spec.code.fill) {
      runOptions.highlight = spec.code.fill;
    }

    if (index === 0) {
      if (bullet) {
        runOptions.bullet = bullet;
      }

      if (options.indentLevel) {
        runOptions.indentLevel = options.indentLevel;
      }

      if (options.paraSpaceBeforePt !== undefined) {
        runOptions.paraSpaceBefore = options.paraSpaceBeforePt;
      }
    }

    if (isLast && options.paraSpaceAfterPt !== undefined) {
      runOptions.paraSpaceAfter = options.paraSpaceAfterPt;
    }

    return { text: run.text, options: runOptions };
  });
}

function bodyItemsForBlocks(
  blocks: DocumentBlock[],
  spec: PptxSpec,
): InlineItem[] {
  const baseSizePt = effectiveBodySizePt(countBodyLines(blocks), spec);
  const items: InlineItem[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        items.push(
          ...inlineToItems([{ text: block.text, bold: true }], spec, {
            baseSizePt: spec.heading.sizePt,
            bold: true,
            color: spec.heading.color,
            breakLine: true,
            paraSpaceAfterPt: 4,
            paraSpaceBeforePt: spec.heading.spaceBeforePt,
            sizePt: spec.heading.sizePt,
          }),
        );
        break;
      case "paragraph":
        items.push(
          ...inlineToItems(block.runs, spec, {
            baseSizePt,
            breakLine: true,
            paraSpaceAfterPt: spec.body.paraSpaceAfterPt,
          }),
        );
        break;
      case "list":
        block.items.forEach((item, index) => {
          const runs: InlineRun[] = block.ordered
            ? [{ text: `${index + 1}. ` }, ...item]
            : item;

          items.push(
            ...inlineToItems(runs, spec, {
              baseSizePt,
              bullet: !block.ordered,
              breakLine: true,
              paraSpaceAfterPt: 2,
            }),
          );
        });
        break;
      case "code":
        block.text.split("\n").forEach((line) => {
          items.push({
            text: line || " ",
            options: {
              fontFace: spec.code.fontFamily,
              fontSize: spec.code.sizePt,
              color: spec.code.color,
              highlight: spec.code.fill,
              breakLine: true,
            },
          });
        });
        break;
      default:
        break;
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function imageDimensions(bytes: Uint8Array): {
  height: number;
  width: number;
} {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return {
      width: readUint32BE(bytes, 16),
      height: readUint32BE(bytes, 20),
    };
  }

  // JPEG: scan for a start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;

    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = bytes[offset + 1]!;

      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
          width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
        };
      }

      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;

      if (length <= 0) {
        break;
      }

      offset += 2 + length;
    }
  }

  return { width: 400, height: 300 };
}

function imageMime(bytes: Uint8Array, src: string): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return "image/gif";
  }

  const extension = src.split("?")[0]!.split(".").pop()?.toLowerCase();

  switch (extension) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/jpeg";
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + chunkSize),
    );
  }

  return btoa(binary);
}

async function resolveImageBytes(
  src: string,
  resolveImage?: (src: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (src.startsWith("data:")) {
    const commaIndex = src.indexOf(",");

    if (commaIndex < 0) {
      throw new Error(`Invalid image data URI: ${src.slice(0, 40)}...`);
    }

    const base64 = src.slice(commaIndex + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  if (!resolveImage) {
    throw new Error(
      `Cannot embed image "${src}": no image resolver is available. Use a data URI (data:image/...;base64,...) or provide a workspace-relative path inside the app.`,
    );
  }

  return resolveImage(src);
}

function imageDataUri(bytes: Uint8Array, src: string): string {
  return `${imageMime(bytes, src)};base64,${toBase64(bytes)}`;
}

// ---------------------------------------------------------------------------
// Slide assembly
// ---------------------------------------------------------------------------

function applyBackground(
  slide: PptxGenJS.Slide,
  spec: PptxSpec,
  backgroundImage?: string,
) {
  if (backgroundImage) {
    // pptxgenjs expects the data URI without the leading "data:".
    slide.background = { data: backgroundImage.replace(/^data:/, "") };
    return;
  }

  slide.background = { color: spec.background.color };
}

function titleOptions(spec: PptxSpec, overrides: Record<string, unknown> = {}) {
  return {
    x: spec.title.xIn,
    y: spec.title.yIn,
    w: spec.title.wIn,
    h: spec.title.hIn,
    align: spec.title.align,
    valign: "middle" as const,
    fontFace: spec.title.font.family,
    fontSize: spec.title.font.sizePt,
    color: spec.title.font.color,
    bold: spec.title.font.bold,
    italic: spec.title.font.italic,
    ...(spec.title.fill ? { fill: { color: spec.title.fill } } : {}),
    ...(spec.title.lineColor
      ? { line: { color: spec.title.lineColor, width: 1 } }
      : {}),
    ...overrides,
  };
}

function bodyOptions(spec: PptxSpec) {
  return {
    x: spec.body.xIn,
    y: spec.body.yIn,
    w: spec.body.wIn,
    h: spec.body.hIn,
    align: spec.body.align,
    valign: spec.body.valign,
    fontFace: spec.body.font.family,
    color: spec.body.font.color,
    lineSpacingMultiple: spec.body.lineSpacing,
    margin: 0,
  };
}

function addFooter(
  slide: PptxGenJS.Slide,
  spec: PptxSpec,
  size: { heightIn: number; widthIn: number },
) {
  if (spec.footer.text) {
    slide.addText(spec.footer.text, {
      x: spec.body.xIn,
      y: size.heightIn - 0.4,
      w: Math.max(1, size.widthIn / 2 - 0.6),
      h: 0.3,
      align: spec.footer.align,
      valign: "middle",
      fontFace: spec.body.font.family,
      fontSize: spec.footer.sizePt,
      color: spec.footer.color,
      margin: 0,
    });
  }

  if (spec.slideNumber.show) {
    slide.slideNumber = {
      x: size.widthIn / 2,
      y: size.heightIn - 0.4,
      w: Math.max(1, size.widthIn / 2 - 0.6),
      h: 0.3,
      align: spec.slideNumber.align,
      valign: "middle",
      fontFace: spec.body.font.family,
      fontSize: spec.slideNumber.sizePt,
      color: spec.slideNumber.color,
    };
  }
}

function addTableSlide(
  pptx: PptxGenJS,
  title: string,
  table: Extract<DocumentBlock, { type: "table" }>,
  spec: PptxSpec,
  backgroundImage: string | undefined,
  size: { heightIn: number; widthIn: number },
) {
  const slide = pptx.addSlide();
  applyBackground(slide, spec, backgroundImage);
  slide.addText(title, titleOptions(spec, { h: 0.8 }));

  const columnCount = Math.max(table.headers.length, 1);
  const rows = [table.headers, ...table.rows]
    .filter((row) => row.length > 0)
    .map((row, rowIndex) => {
      const isHeader = rowIndex === 0;
      const striped =
        !isHeader &&
        Boolean(spec.table.stripeFill) &&
        rowIndex % 2 === 0;

      return table.headers.map((_header, columnIndex) => ({
        text: row[columnIndex]?.trim() ?? "",
        options: {
          bold: isHeader ? spec.table.headerBold : spec.table.font.bold,
          color: isHeader ? spec.table.headerColor : spec.table.font.color,
          fontSize: spec.table.font.sizePt,
          align: spec.table.align,
          valign: "middle" as const,
          fill: isHeader
            ? { color: spec.table.headerFill }
            : striped
              ? { color: spec.table.stripeFill! }
              : undefined,
        },
      }));
    });

  slide.addTable(rows, {
    x: spec.table.xIn,
    y: spec.table.yIn,
    w: spec.table.wIn,
    colW: spec.table.wIn / columnCount,
    rowH: spec.table.rowHeightIn,
    fontFace: spec.table.font.family,
    fontSize: spec.table.font.sizePt,
    color: spec.table.font.color,
    border: { pt: spec.table.borderPt, color: spec.table.borderColor },
    autoPage: spec.table.autoPage,
    autoPageRepeatHeader: true,
    autoPageHeaderRows: 1,
  });

  addFooter(slide, spec, size);
}

async function addImages(
  slide: PptxGenJS.Slide,
  images: Extract<DocumentBlock, { type: "image" }>[],
  spec: PptxSpec,
  resolveImage: ((src: string) => Promise<Uint8Array>) | undefined,
  size: { heightIn: number; widthIn: number },
) {
  let offsetY = spec.body.yIn;

  for (const image of images) {
    const bytes = await resolveImageBytes(image.src, resolveImage);
    const dimensions = imageDimensions(bytes);
    const requestedWidth = image.widthPx
      ? image.widthPx / 96
      : spec.images.defaultWidthIn;
    let widthIn = Math.min(requestedWidth, size.widthIn - 1);
    let heightIn = (widthIn * dimensions.height) / Math.max(1, dimensions.width);

    if (heightIn > spec.images.maxHeightIn) {
      heightIn = spec.images.maxHeightIn;
      widthIn = (heightIn * dimensions.width) / Math.max(1, dimensions.height);
    }

    slide.addImage({
      data: imageDataUri(bytes, image.src),
      x: Math.max(0, (size.widthIn - widthIn) / 2),
      y: offsetY,
      w: widthIn,
      h: heightIn,
    });

    offsetY += heightIn + 0.2;
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildPptx(input: {
  content: string;
  fileName: string;
  spec?: PptxSpec;
  resolveImage?: (src: string) => Promise<Uint8Array>;
}): Promise<Uint8Array> {
  const spec = input.spec ?? parsePptxSpec({});
  const size = pptxSlideSize(spec);
  const blocks = parseMarkdownBlocks(input.content);
  const defaultTitle =
    spec.presentation.title?.trim() ||
    input.fileName.replace(/\.pptx$/i, "");
  const slides = planSlides(blocks, defaultTitle);
  const plan = slides.length > 0 ? slides : [{ title: defaultTitle, blocks: [] }];

  const backgroundImage = spec.background.image
    ? imageDataUri(
        await resolveImageBytes(spec.background.image, input.resolveImage),
        spec.background.image,
      )
    : undefined;

  const pptx = new PptxGenJS();

  if (spec.presentation.layout === "custom") {
    pptx.defineLayout({
      name: "MOBILE_AGENT_CUSTOM",
      width: size.widthIn,
      height: size.heightIn,
    });
    pptx.layout = "MOBILE_AGENT_CUSTOM";
  } else {
    pptx.layout = PRESET_LAYOUT_NAMES[spec.presentation.layout] ?? "LAYOUT_16x9";
  }

  pptx.title = defaultTitle;
  pptx.author = spec.presentation.author ?? "Mobile Agent";
  pptx.company = spec.presentation.company ?? "Mobile Agent";
  pptx.subject = spec.presentation.subject ?? defaultTitle;
  pptx.rtlMode = spec.presentation.rtlMode;
  pptx.theme = {
    headFontFace: spec.theme.headFontFace,
    bodyFontFace: spec.theme.bodyFontFace,
  };

  if (spec.cover.enabled) {
    const slide = pptx.addSlide();
    applyBackground(slide, spec, backgroundImage);
    slide.addText(spec.cover.title ?? defaultTitle, {
      ...titleOptions(spec),
      x: 0.5,
      y: size.heightIn / 2 - 1.1,
      w: size.widthIn - 1,
      h: 1.2,
      align: "center",
      fontSize: spec.title.font.sizePt + 8,
    });

    if (spec.cover.subtitle) {
      slide.addText(spec.cover.subtitle, {
        x: 0.5,
        y: size.heightIn / 2 + 0.2,
        w: size.widthIn - 1,
        h: 0.8,
        align: "center",
        valign: "middle",
        fontFace: spec.body.font.family,
        fontSize: spec.body.font.sizePt,
        color: spec.body.font.color,
      });
    }
  }

  for (const slidePlan of plan) {
    const slide = pptx.addSlide();
    applyBackground(slide, spec, backgroundImage);
    slide.addText(slidePlan.title || defaultTitle, titleOptions(spec));

    const items = bodyItemsForBlocks(slidePlan.blocks, spec);

    if (items.length > 0) {
      slide.addText(items, bodyOptions(spec));
    }

    const images = collectImages(slidePlan.blocks);

    if (images.length > 0) {
      await addImages(slide, images, spec, input.resolveImage, size);
    }

    addFooter(slide, spec, size);

    for (const table of collectTables(slidePlan.blocks)) {
      addTableSlide(
        pptx,
        `${slidePlan.title || defaultTitle} - table`,
        table,
        spec,
        backgroundImage,
        size,
      );
    }
  }

  const output = await pptx.write({ outputType: "uint8array" });

  if (output instanceof Uint8Array) {
    return output;
  }

  if (output instanceof ArrayBuffer) {
    return new Uint8Array(output);
  }

  throw new Error("Unexpected pptx output format.");
}
