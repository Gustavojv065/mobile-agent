import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import { parseMarkdownBlocks } from "@/modules/documents/markdown";
import type { DocumentBlock, InlineRun } from "@/modules/documents/types";

const CODE_FONT = "Courier New";
const CODE_SHADING = "F2F2F2";
const TABLE_HEADER_SHADING = "E8E8E8";

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function headingForLevel(level: number) {
  const clamped = Math.min(Math.max(level, 1), HEADING_LEVELS.length);
  return HEADING_LEVELS[clamped - 1]!;
}

function runsToTextRuns(runs: InlineRun[]): TextRun[] {
  const textRuns = runs.map(
    (run) =>
      new TextRun({
        text: run.text,
        bold: run.bold,
        italics: run.italic,
        font: run.code ? CODE_FONT : undefined,
        shading: run.code
          ? { type: ShadingType.CLEAR, fill: CODE_SHADING }
          : undefined,
      }),
  );

  return textRuns.length > 0 ? textRuns : [new TextRun({ text: "" })];
}

function blockToChildren(block: DocumentBlock): (Paragraph | Table)[] {
  switch (block.type) {
    case "heading":
      return [
        new Paragraph({
          heading: headingForLevel(block.level),
          children: runsToTextRuns([{ text: block.text }]),
        }),
      ];
    case "paragraph":
      return [
        new Paragraph({
          children: runsToTextRuns(block.runs),
          spacing: { after: 160 },
        }),
      ];
    case "list":
      return block.items.map((item) =>
        new Paragraph({
          children: runsToTextRuns(item),
          ...(block.ordered
            ? { numbering: { reference: "ordered-list", level: 0 } }
            : { bullet: { level: 0 } }),
        }),
      );
    case "code":
      return block.text.split("\n").map(
        (line) =>
          new Paragraph({
            children: [
              new TextRun({ text: line || " ", font: CODE_FONT, size: 20 }),
            ],
            shading: { type: ShadingType.CLEAR, fill: CODE_SHADING },
            spacing: { after: 0 },
          }),
      );
    case "table":
      return [tableToDocx(block)];
    case "pageBreak":
      return [new Paragraph({ children: [new PageBreak()] })];
    default:
      return [];
  }
}

function tableToDocx(block: Extract<DocumentBlock, { type: "table" }>) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: block.headers.map(
      (header) =>
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: TABLE_HEADER_SHADING },
          children: [
            new Paragraph({
              children: [new TextRun({ text: header, bold: true })],
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
                  children: [
                    new TextRun({ text: row[columnIndex]?.trim() ?? "" }),
                  ],
                }),
              ],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}

export async function buildDocx(input: {
  content: string;
  fileName: string;
}): Promise<Uint8Array> {
  const blocks = parseMarkdownBlocks(input.content);
  const children = blocks.flatMap(blockToChildren);

  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
  }

  const document = new Document({
    title: input.fileName,
    numbering: {
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
    },
    sections: [{ children }],
  });

  const output = await Packer.toArrayBuffer(document);

  return output instanceof Uint8Array
    ? output
    : new Uint8Array(output as ArrayBuffer);
}
