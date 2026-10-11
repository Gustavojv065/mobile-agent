import {
  type PDFFont,
  type PDFPage,
  PDFDocument,
  StandardFonts,
  rgb,
} from "pdf-lib";

import type { PdfSpec } from "@/modules/documents/spec/pdf-spec";
import { parsePdfSpec, pdfPageSizePt } from "@/modules/documents/spec/pdf-spec";
import { parseMarkdownBlocks } from "@/modules/documents/markdown";
import type { DocumentBlock, InlineRun } from "@/modules/documents/types";

const TABLE_PADDING = 4;
const CODE_INDENT = 8;

type StandardFamily = "courier" | "helvetica" | "times";

type FaceSet = {
  bold: PDFFont;
  boldItalic: PDFFont;
  italic: PDFFont;
  regular: PDFFont;
};

type Fonts = {
  body: FaceSet;
  code: FaceSet;
  footer: FaceSet;
  header: FaceSet;
  headings: FaceSet;
  table: FaceSet;
};

type StyledWord = {
  color: ReturnType<typeof rgb>;
  font: PDFFont;
  size: number;
  text: string;
};

type Align = "center" | "justified" | "left" | "right";

type Context = {
  contentWidth: number;
  doc: PDFDocument;
  fonts: Fonts;
  height: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  page: PDFPage;
  spec: PdfSpec;
  width: number;
  y: number;
};

const TYPOGRAPHIC_REPLACEMENTS: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2026": "...",
  "\u2022": "*",
  "\u00a0": " ",
};

/**
 * The standard PDF fonts only expose the WinAnsi character set. Replace
 * common typographic characters and drop anything the encoder cannot handle so
 * generation never throws on emoji or non-Latin scripts.
 */
export function sanitizeForStandardFont(text: string): string {
  const replaced = text.replace(
    /[\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u2022\u00a0]/g,
    (char) => TYPOGRAPHIC_REPLACEMENTS[char] ?? "",
  );
  let output = "";

  for (const char of replaced) {
    const code = char.codePointAt(0) ?? 0;

    if (char === "\t") {
      output += "    ";
      continue;
    }

    if (code < 32) {
      continue;
    }

    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
      output += char;
      continue;
    }

    output += "?";
  }

  return output;
}

/**
 * Map a requested family name onto one of the standard PDF faces. Embedded
 * custom fonts are not supported, so serif and monospace names are
 * approximated with Times and Courier and everything else renders as
 * Helvetica.
 */
function standardFamily(family: string): StandardFamily {
  const normalized = family.toLowerCase();

  if (
    normalized.includes("courier") ||
    normalized.includes("mono") ||
    normalized.includes("consolas") ||
    normalized.includes("menlo")
  ) {
    return "courier";
  }

  if (
    normalized.includes("times") ||
    normalized.includes("georgia") ||
    normalized.includes("palatino") ||
    normalized.includes("serif")
  ) {
    return "times";
  }

  return "helvetica";
}

async function faceSet(
  doc: PDFDocument,
  family: string,
): Promise<FaceSet> {
  const base = standardFamily(family);

  switch (base) {
    case "times":
      return {
        regular: await doc.embedFont(StandardFonts.TimesRoman),
        bold: await doc.embedFont(StandardFonts.TimesRomanBold),
        italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
        boldItalic: await doc.embedFont(StandardFonts.TimesRomanBoldItalic),
      };
    case "courier":
      return {
        regular: await doc.embedFont(StandardFonts.Courier),
        bold: await doc.embedFont(StandardFonts.CourierBold),
        italic: await doc.embedFont(StandardFonts.CourierOblique),
        boldItalic: await doc.embedFont(StandardFonts.CourierBoldOblique),
      };
    default:
      return {
        regular: await doc.embedFont(StandardFonts.Helvetica),
        bold: await doc.embedFont(StandardFonts.HelveticaBold),
        italic: await doc.embedFont(StandardFonts.HelveticaOblique),
        boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
      };
  }
}

function toRgb(hex: string): ReturnType<typeof rgb> {
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  );
}

function measure(word: StyledWord): number {
  return word.font.widthOfTextAtSize(word.text, word.size);
}

function pickFont(run: InlineRun, face: FaceSet, codeFace: FaceSet): PDFFont {
  if (run.code) {
    return codeFace.regular;
  }

  if (run.bold && run.italic) {
    return face.boldItalic;
  }

  if (run.bold) {
    return face.bold;
  }

  if (run.italic) {
    return face.italic;
  }

  return face.regular;
}

function runsToWords(
  runs: InlineRun[],
  face: FaceSet,
  codeFace: FaceSet,
  size: number,
  color = toRgb("000000"),
): StyledWord[] {
  const words: StyledWord[] = [];

  for (const run of runs) {
    const font = pickFont(run, face, codeFace);
    const sanitized = sanitizeForStandardFont(run.text);

    for (const piece of sanitized.split(/(\s+)/)) {
      if (!piece) {
        continue;
      }

      words.push({ text: piece, font, size, color });
    }
  }

  return words;
}

function wordsFromText(
  text: string,
  font: PDFFont,
  size: number,
  color = toRgb("000000"),
): StyledWord[] {
  return [
    { text: sanitizeForStandardFont(text), font, size, color },
  ].filter((word) => word.text.length > 0);
}

function wrapWords(words: StyledWord[], maxWidth: number): StyledWord[][] {
  const lines: StyledWord[][] = [];
  let line: StyledWord[] = [];
  let lineWidth = 0;

  const flush = () => {
    if (line.length > 0) {
      lines.push(line);
      line = [];
      lineWidth = 0;
    }
  };

  for (const word of words) {
    const isWhitespace = /^\s+$/.test(word.text);

    if (isWhitespace) {
      if (line.length === 0) {
        continue;
      }

      line.push(word);
      lineWidth += measure(word);
      continue;
    }

    let remaining = word.text;

    while (remaining.length > 0) {
      const candidate: StyledWord = { ...word, text: remaining };
      const candidateWidth = measure(candidate);

      if (lineWidth + candidateWidth <= maxWidth) {
        line.push(candidate);
        lineWidth += candidateWidth;
        remaining = "";
        break;
      }

      if (line.length > 0) {
        flush();
        continue;
      }

      let slice = remaining;

      while (slice.length > 1 && measure({ ...word, text: slice }) > maxWidth) {
        slice = slice.slice(0, -1);
      }

      const fitted: StyledWord = { ...word, text: slice };
      line.push(fitted);
      lineWidth = measure(fitted);
      remaining = remaining.slice(slice.length);
      flush();
    }
  }

  flush();

  return lines;
}

function drawWords(
  context: Context,
  words: StyledWord[],
  x: number,
  baseline: number,
) {
  let cursor = x;

  for (const word of words) {
    context.page.drawText(word.text, {
      x: cursor,
      y: baseline,
      size: word.size,
      font: word.font,
      color: word.color,
    });
    cursor += measure(word);
  }
}

function drawLine(
  context: Context,
  line: StyledWord[],
  x: number,
  baseline: number,
  maxWidth: number,
  align: Align,
) {
  const lineWidth = line.reduce((total, word) => total + measure(word), 0);

  if (align === "justified" && line.length > 1 && lineWidth < maxWidth) {
    const gapCount = line.length - 1;
    const extra = (maxWidth - lineWidth) / gapCount;
    let cursor = x;

    for (const word of line) {
      context.page.drawText(word.text, {
        x: cursor,
        y: baseline,
        size: word.size,
        font: word.font,
        color: word.color,
      });
      cursor += measure(word) + extra;
    }

    return;
  }

  if (align === "center") {
    drawWords(context, line, x + (maxWidth - lineWidth) / 2, baseline);
    return;
  }

  if (align === "right") {
    drawWords(context, line, x + maxWidth - lineWidth, baseline);
    return;
  }

  drawWords(context, line, x, baseline);
}

function newPage(context: Context) {
  context.page = context.doc.addPage([context.width, context.height]);
  context.y = context.height - context.marginTop;
}

function ensureSpace(context: Context, height: number) {
  if (context.y - height < context.marginBottom) {
    newPage(context);
  }
}

function layoutWords(
  context: Context,
  words: StyledWord[],
  options: {
    align?: Align;
    lineHeight: number;
    maxWidth?: number;
    spaceAfter?: number;
    spaceBefore?: number;
    x?: number;
  },
) {
  const align = options.align ?? "left";
  const x = options.x ?? context.marginLeft;
  const maxWidth = options.maxWidth ?? context.contentWidth;

  if (options.spaceBefore) {
    context.y -= options.spaceBefore;
  }

  const lines = wrapWords(words, maxWidth);

  for (const line of lines) {
    ensureSpace(context, options.lineHeight);
    context.y -= options.lineHeight;
    drawLine(
      context,
      line,
      x,
      context.y + options.lineHeight * 0.2,
      maxWidth,
      align,
    );
  }

  if (options.spaceAfter) {
    context.y -= options.spaceAfter;
  }
}

function layoutCodeBlock(context: Context, text: string) {
  const spec = context.spec;
  const size = spec.fonts.code.sizePt;
  const lineHeight = size * 1.4;
  const textColor = toRgb(spec.codeBlock.textColor);
  const background = toRgb(spec.codeBlock.background);

  context.y -= 6;

  for (const rawLine of text.split("\n")) {
    const words = wordsFromText(rawLine || " ", context.fonts.code.regular, size, textColor);
    const lines = wrapWords(words, context.contentWidth - CODE_INDENT * 2);

    for (const line of lines) {
      ensureSpace(context, lineHeight);
      context.y -= lineHeight;
      context.page.drawRectangle({
        x: context.marginLeft,
        y: context.y,
        width: context.contentWidth,
        height: lineHeight,
        color: background,
      });
      drawWords(
        context,
        line,
        context.marginLeft + CODE_INDENT,
        context.y + lineHeight * 0.2,
      );
    }
  }

  context.y -= 8;
}

function layoutTable(
  context: Context,
  table: Extract<DocumentBlock, { type: "table" }>,
) {
  const spec = context.spec;
  const size = spec.fonts.table.sizePt;
  const lineHeight = size * 1.3;
  const regular = context.fonts.table.regular;
  const bold = context.fonts.table.bold;
  const columns = Math.max(table.headers.length, 1);
  const columnWidth = context.contentWidth / columns;
  const rows: string[][] = [table.headers, ...table.rows];

  context.y -= 6;

  for (const [rowIndex, row] of rows.entries()) {
    const cellLines = row.map((cell) =>
      wrapWords(
        wordsFromText(cell ?? "", regular, size),
        columnWidth - TABLE_PADDING * 2,
      ),
    );
    const lineCount = Math.max(1, ...cellLines.map((lines) => lines.length));
    const rowHeight = lineCount * lineHeight + TABLE_PADDING * 2;

    ensureSpace(context, rowHeight);

    const rowTop = context.y;
    const rowBottom = context.y - rowHeight;

    if (rowIndex === 0) {
      context.page.drawRectangle({
        x: context.marginLeft,
        y: rowBottom,
        width: context.contentWidth,
        height: rowHeight,
        color: toRgb(spec.tables.headerBackground),
      });
    }

    context.page.drawRectangle({
      x: context.marginLeft,
      y: rowBottom,
      width: context.contentWidth,
      height: rowHeight,
      borderColor: toRgb(spec.tables.borderColor),
      borderWidth: 0.5,
      opacity: 0,
      borderOpacity: 1,
    });

    for (let column = 0; column < columns; column += 1) {
      const cellX = context.marginLeft + column * columnWidth;

      if (column > 0) {
        context.page.drawLine({
          start: { x: cellX, y: rowBottom },
          end: { x: cellX, y: rowTop },
          color: toRgb(spec.tables.borderColor),
          thickness: 0.5,
        });
      }

      const lines = cellLines[column] ?? [];

      lines.forEach((line, lineIndex) => {
        const baseline =
          rowTop - TABLE_PADDING - (lineIndex + 1) * lineHeight +
          lineHeight * 0.2;
        const styled =
          rowIndex === 0
            ? line.map((word) => ({
                ...word,
                font: spec.tables.headerBold ? bold : regular,
                color: toRgb(spec.tables.headerTextColor),
              }))
            : line;
        drawWords(context, styled, cellX + TABLE_PADDING, baseline);
      });
    }

    context.y = rowBottom;
  }

  context.y -= 8;
}

async function layoutImage(
  context: Context,
  block: Extract<DocumentBlock, { type: "image" }>,
  resolveImage?: (src: string) => Promise<Uint8Array>,
) {
  const spec = context.spec;
  const bytes = await resolveImageBytes(block.src, resolveImage);
  let embedded:

    | Awaited<ReturnType<PDFDocument["embedPng"]>>
    | Awaited<ReturnType<PDFDocument["embedJpg"]>>;

  const isPng =
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;

  if (isPng) {
    embedded = await context.doc.embedPng(bytes);
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    embedded = await context.doc.embedJpg(bytes);
  } else {
    throw new Error(
      `Cannot embed image "${block.src}": only PNG and JPEG images are supported in PDF output.`,
    );
  }

  const requestedWidth = block.widthPx
    ? block.widthPx * 0.75 // px at 96dpi -> points
    : spec.images.defaultWidthPt;
  let width = Math.min(requestedWidth, context.contentWidth);
  const aspect = embedded.width / Math.max(1, embedded.height);
  let height = width / aspect;

  if (height > spec.images.maxHeightPt) {
    height = spec.images.maxHeightPt;
    width = height * aspect;
  }

  ensureSpace(context, height + 12);

  context.y -= height + 8;

  context.page.drawImage(embedded, {
    x: context.marginLeft + (context.contentWidth - width) / 2,
    y: context.y,
    width,
    height,
  });

  context.y -= 4;
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

function headingStyleFor(
  spec: PdfSpec,
  level: number,
): PdfSpec["headingStyles"][1] {
  const key = (level >= 1 && level <= 6 ? level : 6) as 1 | 2 | 3 | 4 | 5 | 6;

  return spec.headingStyles[key];
}

function layoutBlock(
  context: Context,
  block: DocumentBlock,
) {
  const spec = context.spec;

  switch (block.type) {
    case "heading": {
      const style = headingStyleFor(spec, block.level);
      layoutWords(
        context,
        runsToWords(
          [{ text: block.text, bold: true }],
          context.fonts.headings,
          context.fonts.code,
          style.sizePt,
          toRgb(style.color),
        ),
        {
          lineHeight: style.sizePt * 1.35,
          spaceBefore: style.spacingBeforePt,
          spaceAfter: style.spacingAfterPt,
        },
      );
      break;
    }
    case "paragraph":
      layoutWords(
        context,
        runsToWords(
          block.runs,
          context.fonts.body,
          context.fonts.code,
          spec.fonts.body.sizePt,
          toRgb(spec.fonts.body.color),
        ),
        {
          align: spec.paragraphs.alignment,
          lineHeight: spec.fonts.body.sizePt * spec.paragraphs.lineSpacing,
          spaceAfter: spec.paragraphs.spacingAfterPt,
        },
      );
      break;
    case "list":
      block.items.forEach((item, itemIndex) => {
        const marker = block.ordered ? `${itemIndex + 1}. ` : "*  ";
        const words = [
          ...wordsFromText(
            marker,
            context.fonts.body.regular,
            spec.fonts.body.sizePt,
            toRgb("595959"),
          ),
          ...runsToWords(
            item,
            context.fonts.body,
            context.fonts.code,
            spec.fonts.body.sizePt,
            toRgb(spec.fonts.body.color),
          ),
        ];
        layoutWords(context, words, {
          align: spec.paragraphs.alignment,
          lineHeight: spec.fonts.body.sizePt * spec.paragraphs.lineSpacing,
          maxWidth: context.contentWidth - spec.lists.indentPt,
          spaceAfter: spec.lists.spacingAfterPt,
          x: context.marginLeft + spec.lists.indentPt,
        });
      });
      context.y -= 6;
      break;
    case "code":
      layoutCodeBlock(context, block.text);
      break;
    case "table":
      layoutTable(context, block);
      break;
    case "pageBreak":
      newPage(context);
      break;
    default:
      break;
  }
}

function pageNumberPositionAlign(
  position: PdfSpec["pageNumberPosition"],
): Align {
  if (position === "left" || position === "right") {
    return position;
  }

  return "center";
}

function drawRunningText(context: Context) {
  const spec = context.spec;
  const pageCount = context.doc.getPageCount();
  const align = pageNumberPositionAlign(spec.pageNumberPosition);

  for (let index = 0; index < pageCount; index += 1) {
    const page = context.doc.getPage(index);

    if (spec.header.text) {
      const size = spec.fonts.header.sizePt;
      const text = spec.header.text.replaceAll("{PAGE}", String(index + 1));

      if (text) {
        const words = wordsFromText(
          text,
          context.fonts.header.regular,
          size,
          toRgb(spec.fonts.header.color),
        );
        const lines = wrapWords(words, context.contentWidth);
        const line = lines[0] ?? words;

        drawLine(
          { ...context, page } as Context,
          line,
          context.marginLeft,
          context.height - context.marginTop + size * 1.6,
          context.contentWidth,
          align,
        );
      }
    }

    if (spec.footer.text) {
      const size = spec.fonts.footer.sizePt;
      const text = spec.footer.text.replaceAll("{PAGE}", String(index + 1));

      if (text) {
        const words = wordsFromText(
          text,
          context.fonts.footer.regular,
          size,
          toRgb(spec.fonts.footer.color),
        );
        const lines = wrapWords(words, context.contentWidth);
        const line = lines[0] ?? words;

        drawLine(
          { ...context, page } as Context,
          line,
          context.marginLeft,
          context.marginBottom - 8,
          context.contentWidth,
          align,
        );
      }
    }
  }
}

export async function buildPdf(input: {
  content: string;
  fileName: string;
  resolveImage?: (src: string) => Promise<Uint8Array>;
  spec?: PdfSpec;
}): Promise<Uint8Array> {
  const spec = input.spec ?? parsePdfSpec({});
  const blocks = parseMarkdownBlocks(input.content);
  const doc = await PDFDocument.create();
  const title = spec.title?.trim() || input.fileName;

  doc.setTitle(title);
  doc.setProducer("Mobile Agent");
  doc.setCreator("Mobile Agent");

  const fonts: Fonts = {
    body: await faceSet(doc, spec.fonts.body.family),
    headings: await faceSet(doc, spec.fonts.headings.family),
    code: await faceSet(doc, spec.fonts.code.family),
    table: await faceSet(doc, spec.fonts.table.family),
    header: await faceSet(doc, spec.fonts.header.family),
    footer: await faceSet(doc, spec.fonts.footer.family),
  };

  const size = pdfPageSizePt(spec);
  const context: Context = {
    doc,
    fonts,
    page: doc.addPage([size.width, size.height]),
    y: size.height - spec.page.marginTopPt,
    width: size.width,
    height: size.height,
    marginTop: spec.page.marginTopPt,
    marginRight: spec.page.marginRightPt,
    marginBottom: spec.page.marginBottomPt,
    marginLeft: spec.page.marginLeftPt,
    contentWidth: size.width - spec.page.marginLeftPt - spec.page.marginRightPt,
    spec,
  };

  for (const block of blocks) {
    // Images resolve asynchronously for their own parallel futures.
    if (block.type === "image") {
      await layoutImage(context, block, input.resolveImage);
      continue;
    }

    layoutBlock(context, block);
  }

  drawRunningText(context);

  return doc.save();
}