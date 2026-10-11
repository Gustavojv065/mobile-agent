import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TableOfContents,
  TextRun,
  WidthType,
} from "docx";

import { parseMarkdownBlocks } from "@/modules/documents/markdown";
import {
  DOCX_PAGE_SIZE_TWIPS,
  parseDocxSpec,
  type DocxSpec,
} from "@/modules/documents/spec/docx-spec";
import type { DocumentBlock, InlineRun } from "@/modules/documents/types";

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const TABLE_BORDER_EDGES = [
  "top",
  "bottom",
  "left",
  "right",
  "insideHorizontal",
  "insideVertical",
] as const;

// ---------------------------------------------------------------------------
// Unit helpers (docx uses twips for geometry and half-points for font sizes)
// ---------------------------------------------------------------------------

function halfPoints(points: number): number {
  return Math.round(points * 2);
}

function twips(points: number): number {
  return Math.round(points * 20);
}

function lineSpacing(factor: number): number {
  return Math.round(240 * factor);
}

function docxAlignment(
  alignment: DocxSpec["paragraphs"]["alignment"],
): (typeof AlignmentType)[keyof typeof AlignmentType] {
  switch (alignment) {
    case "center":
      return AlignmentType.CENTER;
    case "right":
      return AlignmentType.RIGHT;
    case "justified":
      return AlignmentType.JUSTIFIED;
    default:
      return AlignmentType.LEFT;
  }
}

function headingAlignment(
  position: DocxSpec["pageNumberPosition"],
): (typeof AlignmentType)[keyof typeof AlignmentType] {
  switch (position) {
    case "left":
      return AlignmentType.LEFT;
    case "right":
      return AlignmentType.RIGHT;
    default:
      return AlignmentType.CENTER;
  }
}

// ---------------------------------------------------------------------------
// Inline runs
// ---------------------------------------------------------------------------

type RunStyle = {
  bold?: boolean;
  color: string;
  font: string;
  italic?: boolean;
  size: number;
};

function runsToChildren(
  runs: InlineRun[],
  base: RunStyle,
  codeStyle: RunStyle,
): (ExternalHyperlink | TextRun)[] {
  const children = runs.map((run) => {
    const style: RunStyle = run.code ? codeStyle : base;
    const textRun = new TextRun({
      text: run.text,
      font: style.font,
      size: style.size,
      color: style.color,
      bold: run.bold ?? style.bold ?? false,
      italics: run.italic ?? style.italic ?? false,
    });

    return run.href
      ? new ExternalHyperlink({ children: [textRun], link: run.href })
      : textRun;
  });

  return children.length > 0
    ? children
    : [new TextRun({ text: "", font: base.font, size: base.size })];
}

function bodyRunStyle(spec: DocxSpec): RunStyle {
  return {
    font: spec.fonts.body.family,
    size: halfPoints(spec.fonts.body.sizePt),
    color: spec.fonts.body.color,
    bold: spec.fonts.body.bold,
    italic: spec.fonts.body.italic,
  };
}

function codeRunStyle(spec: DocxSpec): RunStyle {
  return {
    font: spec.fonts.code.family,
    size: halfPoints(spec.fonts.code.sizePt),
    color: spec.codeBlock.textColor,
  };
}

function tableRunStyle(spec: DocxSpec): RunStyle {
  return {
    font: spec.fonts.table.family,
    size: halfPoints(spec.fonts.table.sizePt),
    color: spec.fonts.table.color,
  };
}

// ---------------------------------------------------------------------------
// Image embedding
// ---------------------------------------------------------------------------

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  );
}

function jpegDimensions(bytes: Uint8Array): {
  height: number;
  width: number;
} | null {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  ) {
    return null;
  }

  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];

    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd9)
    ) {
      offset += 2;
      continue;
    }

    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);

    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
      };
    }

    offset += 2 + length;
  }

  return null;
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

  const jpeg = jpegDimensions(bytes);

  if (jpeg) {
    return jpeg;
  }

  // Unknown format: assume a typical 4:3 image so embedding still works.
  return { width: 400, height: 300 };
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
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

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function headingParagraph(
  block: Extract<DocumentBlock, { type: "heading" }>,
  spec: DocxSpec,
): Paragraph {
  const level = Math.min(Math.max(block.level, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
  const style = spec.headingStyles[level];
  const children = runsToChildren(
    [{ text: block.text }],
    {
      font: style.family ?? spec.fonts.headings.family,
      size: halfPoints(style.sizePt),
      color: style.color,
      bold: style.bold,
    },
    codeRunStyle(spec),
  );

  return new Paragraph({
    heading: HEADING_LEVELS[level - 1],
    children,
    keepNext: true,
    spacing: {
      before: twips(style.spacingBeforePt),
      after: twips(style.spacingAfterPt),
      line: lineSpacing(spec.paragraphs.lineSpacing),
      lineRule: "auto" as const,
    },
  });
}

function paragraphBlock(
  block: Extract<DocumentBlock, { type: "paragraph" }>,
  spec: DocxSpec,
): Paragraph {
  return new Paragraph({
    children: runsToChildren(block.runs, bodyRunStyle(spec), codeRunStyle(spec)),
    spacing: {
      after: twips(spec.paragraphs.spacingAfterPt),
      line: lineSpacing(spec.paragraphs.lineSpacing),
      lineRule: "auto" as const,
    },
    alignment: docxAlignment(spec.paragraphs.alignment),
  });
}

function listParagraphs(
  block: Extract<DocumentBlock, { type: "list" }>,
  spec: DocxSpec,
): Paragraph[] {
  return block.items.map((item) =>
    new Paragraph({
      children: runsToChildren(item, bodyRunStyle(spec), codeRunStyle(spec)),
      ...(block.ordered
        ? { numbering: { reference: "ordered-list", level: 0 } }
        : { bullet: { level: 0 } }),
      indent: { left: twips(spec.lists.indentPt) },
      spacing: {
        after: twips(spec.lists.spacingAfterPt),
        line: lineSpacing(spec.paragraphs.lineSpacing),
        lineRule: "auto" as const,
      },
    }),
  );
}

function codeParagraphs(
  block: Extract<DocumentBlock, { type: "code" }>,
  spec: DocxSpec,
): Paragraph[] {
  const codeStyle = codeRunStyle(spec);

  return block.text.split("\n").map(
    (line) =>
      new Paragraph({
        children: [
          new TextRun({
            text: line || " ",
            font: codeStyle.font,
            size: codeStyle.size,
            color: codeStyle.color,
          }),
        ],
        shading: { type: ShadingType.CLEAR, fill: spec.codeBlock.background },
        spacing: { after: 0 },
      }),
  );
}

function tableBlock(
  block: Extract<DocumentBlock, { type: "table" }>,
  spec: DocxSpec,
): Table {
  const border = {
    style: BorderStyle.SINGLE,
    size: 4,
    color: spec.tables.borderColor,
  };

  const bodyStyle = tableRunStyle(spec);

  const headerRow = new TableRow({
    tableHeader: true,
    children: block.headers.map(
      (header) =>
        new TableCell({
          shading: {
            type: ShadingType.CLEAR,
            fill: spec.tables.headerBackground,
          },
          children: [
            new Paragraph({
              children: runsToChildren(
                [{ text: header, bold: spec.tables.headerBold }],
                {
                  ...bodyStyle,
                  color: spec.tables.headerTextColor,
                  bold: spec.tables.headerBold,
                },
                codeRunStyle(spec),
              ),
              spacing: { after: 40 },
            }),
          ],
        }),
    ),
  });

  const bodyRows = block.rows.map(
    (row) =>
      new TableRow({
        children: block.headers.map(
          (_header, columnIndex) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: runsToChildren(
                    [{ text: row[columnIndex]?.trim() ?? "" }],
                    bodyStyle,
                    codeRunStyle(spec),
                  ),
                  spacing: { after: 40 },
                }),
              ],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: Object.fromEntries(
      TABLE_BORDER_EDGES.map((edge) => [edge, border]),
    ),
    rows: [headerRow, ...bodyRows],
  });
}

async function imageParagraph(
  block: Extract<DocumentBlock, { type: "image" }>,
  spec: DocxSpec,
  resolveImage?: (src: string) => Promise<Uint8Array>,
): Promise<Paragraph> {
  const bytes = await resolveImageBytes(block.src, resolveImage);
  const dimensions = imageDimensions(bytes);
  const targetWidth = block.widthPx ?? spec.images.defaultWidthPx;
  const targetHeight = Math.max(
    1,
    Math.round((targetWidth * dimensions.height) / Math.max(1, dimensions.width)),
  );

  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new ImageRun({
        type: isPng(bytes) ? "png" : "jpg",
        data: bytes,
        transformation: { width: targetWidth, height: targetHeight },
      }),
    ],
    spacing: { before: twips(6), after: twips(6) },
  });
}

function pageBreakParagraph(): Paragraph {
  return new Paragraph({ children: [new PageBreak()] });
}

async function blockToChildren(
  block: DocumentBlock,
  spec: DocxSpec,
  resolveImage?: (src: string) => Promise<Uint8Array>,
): Promise<(Paragraph | Table)[]> {
  switch (block.type) {
    case "heading":
      return [headingParagraph(block, spec)];
    case "paragraph":
      return [paragraphBlock(block, spec)];
    case "list":
      return listParagraphs(block, spec);
    case "code":
      return codeParagraphs(block, spec);
    case "table":
      return [tableBlock(block, spec)];
    case "image":
      return [await imageParagraph(block, spec, resolveImage)];
    case "pageBreak":
      return [pageBreakParagraph()];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Headers, footers and page numbers
// ---------------------------------------------------------------------------

function headerFooterParagraph(
  text: string,
  spec: DocxSpec,
  kind: "header" | "footer",
): Paragraph {
  const font = kind === "header" ? spec.fonts.header : spec.fonts.footer;
  const parts: string[] = [];

  text.split("{PAGE}").forEach((chunk, index, all) => {
    if (chunk) {
      parts.push(chunk);
    }

    if (index < all.length - 1) {
      parts.push(PageNumber.CURRENT);
    }
  });

  if (parts.length === 0) {
    parts.push(" ");
  }

  return new Paragraph({
    alignment: headingAlignment(spec.pageNumberPosition),
    children: [
      new TextRun({
        children: parts,
        font: font.family,
        size: halfPoints(font.sizePt),
        color: font.color,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function headingParagraphStyles(
  spec: DocxSpec,
): {
  basedOn: string;
  id: string;
  name: string;
  next: string;
  paragraph: { keepNext: boolean; spacing: { after: number; before: number } };
  quickFormat: boolean;
  run: { bold: boolean; color: string; font: string; size: number };
}[] {
  return [1, 2, 3, 4, 5, 6].map((level) => {
    const style = spec.headingStyles[level as 1 | 2 | 3 | 4 | 5 | 6];

    return {
      id: `Heading${level}`,
      name: `Heading ${level}`,
      basedOn: "Normal",
      next: "Normal",
      quickFormat: true,
      run: {
        font: style.family ?? spec.fonts.headings.family,
        size: halfPoints(style.sizePt),
        color: style.color,
        bold: style.bold,
      },
      paragraph: {
        spacing: {
          before: twips(style.spacingBeforePt),
          after: twips(style.spacingAfterPt),
        },
        keepNext: true,
      },
    };
  });
}

function documentStyles(spec: DocxSpec) {
  const body = spec.fonts.body;

  return {
    default: {
      document: {
        run: {
          font: body.family,
          size: halfPoints(body.sizePt),
          color: body.color,
        },
        paragraph: {
          spacing: {
            after: twips(spec.paragraphs.spacingAfterPt),
            line: lineSpacing(spec.paragraphs.lineSpacing),
            lineRule: "auto" as const,
          },
          alignment: docxAlignment(spec.paragraphs.alignment),
        },
      },
    },
    paragraphStyles: [
      {
        id: "Normal",
        name: "Normal",
        run: {
          font: body.family,
          size: halfPoints(body.sizePt),
          color: body.color,
        },
      },
      ...headingParagraphStyles(spec),
    ],
  };
}

function numberingConfig() {
  return {
    config: [
      {
        reference: "ordered-list",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.START,
          },
        ],
      },
    ],
  };
}

function pageDimensions(
  spec: DocxSpec,
): { height: number; width: number } {
  const base = DOCX_PAGE_SIZE_TWIPS[spec.page.size];

  return spec.page.orientation === "landscape"
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildDocx(input: {
  content: string;
  fileName: string;
  resolveImage?: (src: string) => Promise<Uint8Array>;
  spec?: DocxSpec;
}): Promise<Uint8Array> {
  const spec = input.spec ?? parseDocxSpec({});
  const blocks = parseMarkdownBlocks(input.content);

  const nested = await Promise.all(
    blocks.map((block) => blockToChildren(block, spec, input.resolveImage)),
  );
  const children = nested.flat();

  if (spec.includeToc) {
    children.unshift(
      new Paragraph({
        children: [
          new TableOfContents(spec.tocTitle, {
            hyperlink: true,
            headingStyleRange: spec.tocHeadingRange,
          }),
        ],
      }),
      pageBreakParagraph(),
    );
  }

  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
  }

  const headers = spec.header.text
    ? { default: new Header({ children: [headerFooterParagraph(spec.header.text, spec, "header")] }) }
    : null;
  const footers = spec.footer.text
    ? { default: new Footer({ children: [headerFooterParagraph(spec.footer.text, spec, "footer")] }) }
    : null;

  const document = new Document({
    title: spec.title ?? input.fileName,
    styles: documentStyles(spec),
    numbering: numberingConfig(),
    sections: [
      {
        children,
        properties: {
          page: {
            size: pageDimensions(spec),
            margin: {
              top: twips(spec.page.marginTopPt),
              right: twips(spec.page.marginRightPt),
              bottom: twips(spec.page.marginBottomPt),
              left: twips(spec.page.marginLeftPt),
            },
          },
        },
        ...(headers ? { headers } : {}),
        ...(footers ? { footers } : {}),
      },
    ],
  });

  const output = await Packer.toArrayBuffer(document);

  return output instanceof Uint8Array
    ? output
    : new Uint8Array(output as ArrayBuffer);
}