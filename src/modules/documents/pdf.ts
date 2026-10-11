import {
  type PDFFont,
  type PDFPage,
  PDFDocument,
  StandardFonts,
  rgb,
} from "pdf-lib";

import { parseMarkdownBlocks } from "@/modules/documents/markdown";
import type { DocumentBlock, InlineRun } from "@/modules/documents/types";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BODY_SIZE = 11;
const BODY_LINE_HEIGHT = BODY_SIZE * 1.5;
const CODE_SIZE = 9.5;
const CODE_LINE_HEIGHT = CODE_SIZE * 1.4;
const TABLE_SIZE = 9.5;
const TABLE_LINE_HEIGHT = TABLE_SIZE * 1.3;
const TABLE_PADDING = 4;

const HEADING_SIZES: Record<number, number> = {
  1: 22,
  2: 18,
  3: 15,
  4: 13,
  5: 12,
  6: 12,
};

const TEXT_COLOR = rgb(0.1, 0.1, 0.1);
const MUTED_COLOR = rgb(0.35, 0.35, 0.35);
const CODE_BACKGROUND = rgb(0.95, 0.95, 0.95);
const TABLE_HEADER_BACKGROUND = rgb(0.9, 0.9, 0.9);
const BORDER_COLOR = rgb(0.75, 0.75, 0.75);

type Fonts = {
  bold: PDFFont;
  boldItalic: PDFFont;
  code: PDFFont;
  italic: PDFFont;
  regular: PDFFont;
};

type StyledWord = {
  font: PDFFont;
  size: number;
  text: string;
  color: ReturnType<typeof rgb>;
};

type Context = {
  doc: PDFDocument;
  fonts: Fonts;
  page: PDFPage;
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

function measure(word: StyledWord): number {
  return word.font.widthOfTextAtSize(word.text, word.size);
}

function pickFont(run: InlineRun, fonts: Fonts): PDFFont {
  if (run.code) {
    return fonts.code;
  }

  if (run.bold && run.italic) {
    return fonts.boldItalic;
  }

  if (run.bold) {
    return fonts.bold;
  }

  if (run.italic) {
    return fonts.italic;
  }

  return fonts.regular;
}

function runsToWords(
  runs: InlineRun[],
  fonts: Fonts,
  size: number,
  color = TEXT_COLOR,
): StyledWord[] {
  const words: StyledWord[] = [];

  for (const run of runs) {
    const font = pickFont(run, fonts);
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
  color = TEXT_COLOR,
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

function newPage(context: Context) {
  context.page = context.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  context.y = PAGE_HEIGHT - MARGIN;
}

function ensureSpace(context: Context, height: number) {
  if (context.y - height < MARGIN) {
    newPage(context);
  }
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

function layoutWords(
  context: Context,
  words: StyledWord[],
  options: {
    lineHeight: number;
    maxWidth?: number;
    spaceAfter?: number;
    spaceBefore?: number;
    x?: number;
  },
) {
  const x = options.x ?? MARGIN;
  const maxWidth = options.maxWidth ?? CONTENT_WIDTH;

  if (options.spaceBefore) {
    context.y -= options.spaceBefore;
  }

  const lines = wrapWords(words, maxWidth);

  for (const line of lines) {
    ensureSpace(context, options.lineHeight);
    context.y -= options.lineHeight;
    drawWords(context, line, x, context.y + options.lineHeight * 0.2);
  }

  if (options.spaceAfter) {
    context.y -= options.spaceAfter;
  }
}

function layoutCodeBlock(context: Context, text: string) {
  context.y -= 6;

  for (const rawLine of text.split("\n")) {
    const words = wordsFromText(rawLine || " ", context.fonts.code, CODE_SIZE);
    const lines = wrapWords(words, CONTENT_WIDTH - 16);

    for (const line of lines) {
      ensureSpace(context, CODE_LINE_HEIGHT);
      context.y -= CODE_LINE_HEIGHT;
      context.page.drawRectangle({
        x: MARGIN,
        y: context.y,
        width: CONTENT_WIDTH,
        height: CODE_LINE_HEIGHT,
        color: CODE_BACKGROUND,
      });
      drawWords(context, line, MARGIN + 8, context.y + CODE_LINE_HEIGHT * 0.2);
    }
  }

  context.y -= 8;
}

function layoutTable(
  context: Context,
  table: Extract<DocumentBlock, { type: "table" }>,
) {
  const columns = Math.max(table.headers.length, 1);
  const columnWidth = CONTENT_WIDTH / columns;
  const rows: string[][] = [table.headers, ...table.rows];

  context.y -= 6;

  for (const [rowIndex, row] of rows.entries()) {
    const cellLines = row.map((cell) =>
      wrapWords(
        wordsFromText(cell ?? "", context.fonts.regular, TABLE_SIZE),
        columnWidth - TABLE_PADDING * 2,
      ),
    );
    const lineCount = Math.max(1, ...cellLines.map((lines) => lines.length));
    const rowHeight = lineCount * TABLE_LINE_HEIGHT + TABLE_PADDING * 2;

    ensureSpace(context, rowHeight);

    const rowTop = context.y;
    const rowBottom = context.y - rowHeight;

    if (rowIndex === 0) {
      context.page.drawRectangle({
        x: MARGIN,
        y: rowBottom,
        width: CONTENT_WIDTH,
        height: rowHeight,
        color: TABLE_HEADER_BACKGROUND,
      });
    }

    context.page.drawRectangle({
      x: MARGIN,
      y: rowBottom,
      width: CONTENT_WIDTH,
      height: rowHeight,
      borderColor: BORDER_COLOR,
      borderWidth: 0.5,
      opacity: 0,
      borderOpacity: 1,
    });

    for (let column = 0; column < columns; column += 1) {
      const cellX = MARGIN + column * columnWidth;

      if (column > 0) {
        context.page.drawLine({
          start: { x: cellX, y: rowBottom },
          end: { x: cellX, y: rowTop },
          color: BORDER_COLOR,
          thickness: 0.5,
        });
      }

      const lines = cellLines[column] ?? [];

      lines.forEach((line, lineIndex) => {
        const baseline =
          rowTop - TABLE_PADDING - (lineIndex + 1) * TABLE_LINE_HEIGHT +
          TABLE_LINE_HEIGHT * 0.2;
        drawWords(
          context,
          rowIndex === 0
            ? line.map((word) => ({ ...word, font: context.fonts.bold }))
            : line,
          cellX + TABLE_PADDING,
          baseline,
        );
      });
    }

    context.y = rowBottom;
  }

  context.y -= 8;
}

function layoutBlock(context: Context, block: DocumentBlock) {
  switch (block.type) {
    case "heading": {
      const size = HEADING_SIZES[block.level] ?? BODY_SIZE;
      layoutWords(
        context,
        runsToWords([{ text: block.text, bold: true }], context.fonts, size),
        {
          lineHeight: size * 1.35,
          spaceBefore: block.level === 1 ? 10 : 12,
          spaceAfter: 6,
        },
      );
      break;
    }
    case "paragraph":
      layoutWords(context, runsToWords(block.runs, context.fonts, BODY_SIZE), {
        lineHeight: BODY_LINE_HEIGHT,
        spaceAfter: 8,
      });
      break;
    case "list":
      block.items.forEach((item, itemIndex) => {
        const marker = block.ordered ? `${itemIndex + 1}. ` : "*  ";
        const words = [
          ...wordsFromText(marker, context.fonts.regular, BODY_SIZE, MUTED_COLOR),
          ...runsToWords(item, context.fonts, BODY_SIZE),
        ];
        layoutWords(context, words, {
          lineHeight: BODY_LINE_HEIGHT,
          x: MARGIN + 12,
          maxWidth: CONTENT_WIDTH - 12,
        });
      });
      context.y -= 8;
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

export async function buildPdf(input: {
  content: string;
  fileName: string;
}): Promise<Uint8Array> {
  const blocks = parseMarkdownBlocks(input.content);
  const doc = await PDFDocument.create();

  doc.setTitle(input.fileName);
  doc.setProducer("Mobile Agent");
  doc.setCreator("Mobile Agent");

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    code: await doc.embedFont(StandardFonts.Courier),
  };

  const context: Context = {
    doc,
    fonts,
    page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
  };

  for (const block of blocks) {
    layoutBlock(context, block);
  }

  return doc.save();
}
