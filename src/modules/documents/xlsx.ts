import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx";

import { inlineRunsToPlainText, parseMarkdownBlocks } from "@/modules/documents/markdown";
import {
  parseXlsxSpec,
  XLSX_BUILTIN_NUMBER_FORMATS,
  XLSX_PAPER_SIZE_CODES,
  type XlsxCellStyle,
  type XlsxColumnSpec,
  type XlsxSpec,
} from "@/modules/documents/spec/xlsx-spec";
import type { DocumentBlock } from "@/modules/documents/types";

const MAX_COLUMN_WIDTH = 100;
const MIN_COLUMN_WIDTH = 8;
const MAX_SHEET_NAME_LENGTH = 31;

/** First custom (non-built-in) number format id, per ECMA-376. */
const FIRST_CUSTOM_NUM_FMT_ID = 164;

const MAIN_NS =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const EXTENDED_PROPS_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const VT_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";

const BUILTIN_NUMBER_FORMATS = XLSX_BUILTIN_NUMBER_FORMATS;

const NUMBER_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const THOUSANDS_PATTERN = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
const PERCENT_PATTERN = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*%$/;
const DATE_PATTERNS = [
  /^(\d{4})-(\d{2})-(\d{2})$/,
  /^(\d{4})\/(\d{2})\/(\d{2})$/,
];

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

type CellValue =
  | { type: "empty" }
  | { type: "string"; text: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean };

function excelSerialFromIso(text: string): number | null {
  for (const pattern of DATE_PATTERNS) {
    const match = pattern.exec(text);

    if (!match) {
      continue;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }

    const utc = Date.UTC(year, month - 1, day);

    if (Number.isNaN(utc)) {
      return null;
    }

    // Excel's day 1 is 1900-01-01; 1970-01-01 is serial 25569.
    return utc / 86_400_000 + 25_569;
  }

  return null;
}

function isDateFormat(numberFormat: string): boolean {
  return /[ymd]/i.test(numberFormat) && !/general/i.test(numberFormat);
}

function parseCellText(text: string, numberFormat?: string): CellValue {
  const trimmed = text.trim();

  if (!trimmed) {
    return { type: "empty" };
  }

  if (numberFormat && numberFormat.includes("%")) {
    const percent = PERCENT_PATTERN.exec(trimmed);

    if (percent) {
      return { type: "number", value: Number(percent[1]) / 100 };
    }
  }

  if (numberFormat && isDateFormat(numberFormat)) {
    const serial = excelSerialFromIso(trimmed);

    if (serial !== null) {
      return { type: "number", value: serial };
    }
  }

  if (THOUSANDS_PATTERN.test(trimmed)) {
    return { type: "number", value: Number(trimmed.replace(/,/g, "")) };
  }

  if (NUMBER_PATTERN.test(trimmed)) {
    const value = Number(trimmed);

    if (Number.isFinite(value)) {
      return { type: "number", value };
    }
  }

  if (/^(true|false)$/i.test(trimmed)) {
    return { type: "boolean", value: trimmed.toLowerCase() === "true" };
  }

  return { type: "string", text: trimmed };
}

function cellTextValue(text: string): CellValue {
  return text.trim() ? { type: "string", text } : { type: "empty" };
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0-based column index to its Excel letter(s): 0 -> A, 26 -> AA. */
function columnLetter(index: number): string {
  let value = index + 1;
  let letters = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }

  return letters;
}

function cellReference(column: number, row: number): string {
  return `${columnLetter(column)}${row}`;
}

// ---------------------------------------------------------------------------
// Style registry
// ---------------------------------------------------------------------------

type FontDef = XlsxCellStyle["font"];
type FillDef = XlsxCellStyle["fill"];
type BorderDef = XlsxCellStyle["border"];
type AlignmentDef = XlsxCellStyle["alignment"];

type XfDef = {
  alignment: AlignmentDef | null;
  borderId: number;
  fillId: number;
  fontId: number;
  numFmtId: number;
};

function fontKey(font: FontDef): string {
  return JSON.stringify(font);
}

function fillKey(fill: FillDef): string {
  return JSON.stringify(fill);
}

function borderKey(border: BorderDef | null): string {
  return border ? JSON.stringify(border) : "none";
}

function fontXml(font: FontDef): string {
  const parts = [`<sz val="${font.sizePt}"/>`];
  parts.push(`<color rgb="FF${font.color}"/>`);
  parts.push(`<name val="${escapeXml(font.family)}"/>`);
  parts.push(`<family val="2"/>`);

  if (font.bold) {
    parts.push("<b/>");
  }

  if (font.italic) {
    parts.push("<i/>");
  }

  if (font.underline) {
    parts.push("<u/>");
  }

  if (font.strike) {
    parts.push("<strike/>");
  }

  return `<font>${parts.join("")}</font>`;
}

function fillXml(fill: FillDef): string {
  if (fill.pattern === "none") {
    return `<fill><patternFill patternType="none"/></fill>`;
  }

  if (fill.pattern === "solid") {
    return `<fill><patternFill patternType="solid"><fgColor rgb="FF${fill.color}"/><bgColor indexed="64"/></patternFill></fill>`;
  }

  if (fill.pattern === "gray125") {
    return `<fill><patternFill patternType="gray125"/></fill>`;
  }

  return `<fill><patternFill patternType="${fill.pattern}"><fgColor rgb="FF${fill.color}"/><bgColor indexed="64"/></patternFill></fill>`;
}

function borderSideXml(
  tag: "top" | "bottom" | "left" | "right",
  side: BorderDef["top"],
): string {
  if (side.style === "none") {
    return `<${tag}/>`;
  }

  return `<${tag} style="${side.style}"><color rgb="FF${side.color}"/></${tag}>`;
}

function borderXml(border: BorderDef | null): string {
  if (!border) {
    return `<border><left/><right/><top/><bottom/><diagonal/></border>`;
  }

  return [
    "<border>",
    borderSideXml("left", border.left),
    borderSideXml("right", border.right),
    borderSideXml("top", border.top),
    borderSideXml("bottom", border.bottom),
    "<diagonal/>",
    "</border>",
  ].join("");
}

function alignmentXml(alignment: AlignmentDef): string {
  const attributes: string[] = [];

  if (alignment.horizontal !== "general") {
    attributes.push(`horizontal="${alignment.horizontal}"`);
  }

  attributes.push(`vertical="${alignment.vertical}"`);

  if (alignment.wrapText) {
    attributes.push(`wrapText="1"`);
  }

  if (alignment.indent > 0) {
    attributes.push(`indent="${alignment.indent}"`);
  }

  if (alignment.textRotation > 0) {
    attributes.push(`textRotation="${alignment.textRotation}"`);
  }

  return `<alignment ${attributes.join(" ")}/>`;
}

class StyleRegistry {
  readonly fonts: FontDef[] = [];
  readonly fills: FillDef[] = [];
  readonly borders: (BorderDef | null)[] = [];
  readonly xfs: XfDef[] = [];

  private readonly fontIds = new Map<string, number>();
  private readonly fillIds = new Map<string, number>();
  private readonly borderIds = new Map<string, number>();
  private readonly xfIds = new Map<string, number>();
  private readonly numFmts: { code: string; id: number }[] = [];
  private nextNumFmtId = FIRST_CUSTOM_NUM_FMT_ID;

  constructor(defaultFont: FontDef) {
    this.addFont(defaultFont);
    this.addFill({ pattern: "none", color: "FFFFFF" });
    this.addFill({ pattern: "gray125", color: "000000" });
    this.addBorder(null);
    this.addXf({
      alignment: null,
      borderId: 0,
      fillId: 0,
      fontId: 0,
      numFmtId: 0,
    });
  }

  register(style: {
    alignment: AlignmentDef;
    border: BorderDef;
    fill: FillDef;
    font: FontDef;
    numberFormat: string;
  }): number {
    const fontId = this.addFont(style.font);
    const fillId = this.addFill(style.fill);
    const borderId = this.addBorder(style.border);
    const numFmtId = this.numberFormatId(style.numberFormat);

    return this.addXf({
      alignment: style.alignment,
      borderId,
      fillId,
      fontId,
      numFmtId,
    });
  }

  private addFont(font: FontDef): number {
    const key = fontKey(font);
    const existing = this.fontIds.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.fonts.length;
    this.fonts.push(font);
    this.fontIds.set(key, id);
    return id;
  }

  private addFill(fill: FillDef): number {
    const key = fillKey(fill);
    const existing = this.fillIds.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.fills.length;
    this.fills.push(fill);
    this.fillIds.set(key, id);
    return id;
  }

  private addBorder(border: BorderDef | null): number {
    const key = borderKey(border);
    const existing = this.borderIds.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.borders.length;
    this.borders.push(border);
    this.borderIds.set(key, id);
    return id;
  }

  private numberFormatId(code: string): number {
    const builtin = BUILTIN_NUMBER_FORMATS.get(code);

    if (builtin !== undefined) {
      return builtin;
    }

    const existing = this.numFmts.find((entry) => entry.code === code);

    if (existing) {
      return existing.id;
    }

    const id = this.nextNumFmtId;
    this.nextNumFmtId += 1;
    this.numFmts.push({ code, id });
    return id;
  }

  private addXf(xf: XfDef): number {
    const key = [
      xf.numFmtId,
      xf.fontId,
      xf.fillId,
      xf.borderId,
      xf.alignment ? JSON.stringify(xf.alignment) : "none",
    ].join("|");

    const existing = this.xfIds.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.xfs.length;
    this.xfs.push(xf);
    this.xfIds.set(key, id);
    return id;
  }

  toXml(): string {
    const numFmtsXml = this.numFmts.length
      ? `<numFmts count="${this.numFmts.length}">${this.numFmts
          .map(
            (entry) =>
              `<numFmt numFmtId="${entry.id}" formatCode="${escapeXml(entry.code)}"/>`,
          )
          .join("")}</numFmts>`
      : "";

    const fontsXml = `<fonts count="${this.fonts.length}">${this.fonts
      .map(fontXml)
      .join("")}</fonts>`;

    const fillsXml = `<fills count="${this.fills.length}">${this.fills
      .map(fillXml)
      .join("")}</fills>`;

    const bordersXml = `<borders count="${this.borders.length}">${this.borders
      .map(borderXml)
      .join("")}</borders>`;

    const cellXfsXml = `<cellXfs count="${this.xfs.length}">${this.xfs
      .map((xf) => {
        const attributes = [
          `numFmtId="${xf.numFmtId}"`,
          `fontId="${xf.fontId}"`,
          `fillId="${xf.fillId}"`,
          `borderId="${xf.borderId}"`,
          `xfId="0"`,
          `applyNumberFormat="1"`,
          `applyFont="1"`,
          `applyFill="1"`,
          `applyBorder="1"`,
          `applyAlignment="1"`,
        ];
        const alignment = xf.alignment
          ? alignmentXml(xf.alignment)
          : "";

        return `<xf ${attributes.join(" ")}>${alignment}</xf>`;
      })
      .join("")}</cellXfs>`;

    return [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
      `<styleSheet xmlns="${MAIN_NS}">`,
      numFmtsXml,
      fontsXml,
      fillsXml,
      bordersXml,
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`,
      cellXfsXml,
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`,
      `<dxfs count="0"/>`,
      `<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>`,
      `</styleSheet>`,
    ]
      .filter(Boolean)
      .join("");
  }
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

type SheetModel = {
  hasHeader: boolean;
  name: string;
  rows: CellValue[][];
};

function sanitizeSheetName(name: string, fallbackIndex: number): string {
  const cleaned = (name || `Sheet${fallbackIndex}`)
    .replace(/[\\/?*[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SHEET_NAME_LENGTH);

  return cleaned || `Sheet${fallbackIndex}`;
}

function uniqueSheetName(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;

  while (used.has(candidate.toLowerCase())) {
    const suffixText = ` (${suffix})`;
    candidate = `${base.slice(0, MAX_SHEET_NAME_LENGTH - suffixText.length)}${suffixText}`;
    suffix += 1;
  }

  used.add(candidate.toLowerCase());
  return candidate;
}

function tableToSheet(
  table: Extract<DocumentBlock, { type: "table" }>,
  name: string,
  numberFormatFor: (column: number) => string,
): SheetModel {
  const columnCount = Math.max(
    table.headers.length,
    ...table.rows.map((row) => row.length),
    1,
  );

  const headerRow: CellValue[] = Array.from(
    { length: columnCount },
    (_value, index) => cellTextValue(table.headers[index] ?? ""),
  );

  const dataRows = table.rows.map((row) =>
    Array.from({ length: columnCount }, (_value, index) =>
      parseCellText(row[index] ?? "", numberFormatFor(index)),
    ),
  );

  return { name, rows: [headerRow, ...dataRows], hasHeader: true };
}

function textToSheet(content: string, name: string): SheetModel {
  const rows: CellValue[][] = [[cellTextValue("Content")]];

  for (const line of content.split("\n")) {
    rows.push([cellTextValue(line)]);
  }

  return { name, rows, hasHeader: true };
}

function isDelimited(content: string): boolean {
  const firstLine =
    content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  if (!firstLine || /^[#>*\-|]/.test(firstLine)) {
    return false;
  }

  return firstLine.includes(",") || firstLine.includes("\t");
}

function valueToCell(
  value: unknown,
  numberFormat: string,
): CellValue {
  if (value === null || value === undefined) {
    return { type: "empty" };
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? { type: "number", value } : { type: "empty" };
  }

  if (typeof value === "boolean") {
    return { type: "boolean", value };
  }

  return parseCellText(String(value), numberFormat);
}

function delimitedToSheet(
  content: string,
  name: string,
  numberFormatFor: (column: number) => string,
): SheetModel | null {
  const delimiter = content.includes("\t") ? "\t" : ",";
  const parsed = XLSX.read(content, { type: "string", FS: delimiter });
  const firstSheetName = parsed.SheetNames[0];
  const sheet = firstSheetName ? parsed.Sheets[firstSheetName] : undefined;

  if (!sheet) {
    return null;
  }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
  });

  const columnCount = aoa.reduce((max, row) => Math.max(max, row.length), 1);
  const rows = aoa.map((row) =>
    Array.from({ length: columnCount }, (_value, index) =>
      valueToCell(row[index], numberFormatFor(index)),
    ),
  );

  return { name, rows, hasHeader: true };
}

function nonTableText(blocks: DocumentBlock[]): string {
  return blocks
    .flatMap((block) => {
      if (block.type === "heading") {
        return [`${"#".repeat(block.level)} ${block.text}`];
      }

      if (block.type === "paragraph") {
        return [inlineRunsToPlainText(block.runs)];
      }

      if (block.type === "list") {
        return block.items.map((item) => inlineRunsToPlainText(item));
      }

      return [];
    })
    .filter(Boolean)
    .join("\n");
}

function buildSheetModels(
  content: string,
  blocks: DocumentBlock[],
  baseName: string,
  numberFormatFor: (column: number) => string,
): SheetModel[] {
  const used = new Set<string>();
  const sheets: SheetModel[] = [];
  const tables = blocks.filter(
    (block): block is Extract<DocumentBlock, { type: "table" }> =>
      block.type === "table",
  );

  if (tables.length > 0) {
    tables.forEach((table, index) => {
      const base =
        tables.length === 1 ? baseName : `${baseName} ${index + 1}`;
      sheets.push(
        tableToSheet(table, sanitizeSheetName(base, index + 1), numberFormatFor),
      );
    });

    const prose = nonTableText(blocks);

    if (prose.trim()) {
      sheets.push({
        ...textToSheet(prose, "Notes"),
        name: sanitizeSheetName("Notes", tables.length + 1),
      });
    }
  } else if (isDelimited(content)) {
    const delimited = delimitedToSheet(
      content,
      sanitizeSheetName(baseName, 1),
      numberFormatFor,
    );

    if (delimited) {
      sheets.push(delimited);
    }
  }

  if (sheets.length === 0) {
    sheets.push(textToSheet(content, sanitizeSheetName(baseName, 1)));
  }

  // Deduplicate names across sheets.
  return sheets.map((sheet) => ({
    ...sheet,
    name: uniqueSheetName(sheet.name, used),
  }));
}

// ---------------------------------------------------------------------------
// Per-cell style resolution
// ---------------------------------------------------------------------------

function resolveBodyStyle(
  spec: XlsxSpec,
  column: XlsxColumnSpec | undefined,
  striped: boolean,
): {
  alignment: AlignmentDef;
  border: BorderDef;
  fill: FillDef;
  font: FontDef;
  numberFormat: string;
} {
  const base = spec.body;

  const font: FontDef = {
    ...base.font,
    family: column?.family ?? base.font.family,
    sizePt: column?.sizePt ?? base.font.sizePt,
    color: column?.color ?? base.font.color,
    bold: column?.bold ?? base.font.bold,
    italic: column?.italic ?? base.font.italic,
  };

  const fill: FillDef = column?.fill
    ? { pattern: "solid", color: column.fill }
    : striped && spec.stripes.enabled
      ? spec.stripes.fill
      : base.fill;

  const alignment: AlignmentDef = {
    ...base.alignment,
    horizontal: column?.horizontal ?? base.alignment.horizontal,
    vertical: column?.vertical ?? base.alignment.vertical,
    wrapText: column?.wrapText ?? base.alignment.wrapText,
  };

  return {
    alignment,
    border: base.border,
    fill,
    font,
    numberFormat: column?.numberFormat ?? base.numberFormat,
  };
}

function resolveHeaderStyle(
  spec: XlsxSpec,
  column: XlsxColumnSpec | undefined,
): {
  alignment: AlignmentDef;
  border: BorderDef;
  fill: FillDef;
  font: FontDef;
  numberFormat: string;
} {
  const base = spec.header;

  const font: FontDef = {
    ...base.font,
    bold: column?.headerBold ?? base.font.bold,
    color: column?.headerColor ?? base.font.color,
  };

  return {
    alignment: base.alignment,
    border: base.border,
    fill: column?.headerFill
      ? { pattern: "solid", color: column.headerFill }
      : base.fill,
    font,
    numberFormat: base.numberFormat,
  };
}

// ---------------------------------------------------------------------------
// Worksheet / workbook serialization
// ---------------------------------------------------------------------------

function cellXml(
  column: number,
  row: number,
  value: CellValue,
  styleIndex: number,
): string {
  const ref = cellReference(column, row);
  const style = styleIndex > 0 ? ` s="${styleIndex}"` : "";

  switch (value.type) {
    case "string":
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(
        value.text,
      )}</t></is></c>`;
    case "number":
      return `<c r="${ref}"${style}><v>${value.value}</v></c>`;
    case "boolean":
      return `<c r="${ref}"${style} t="b"><v>${value.value ? 1 : 0}</v></c>`;
    default:
      return `<c r="${ref}"${style}/>`;
  }
}

function sheetXml(
  model: SheetModel,
  spec: XlsxSpec,
  registry: StyleRegistry,
): string {
  const columnCount = model.rows.reduce(
    (max, row) => Math.max(max, row.length),
    0,
  );

  const styleForCell = (rowIndex: number, column: number): number => {
    const isHeader = model.hasHeader && rowIndex === 0;
    const dataIndex = model.hasHeader ? rowIndex - 1 : rowIndex;
    const striped = !isHeader && dataIndex % 2 === 1;

    return isHeader
      ? registry.register(resolveHeaderStyle(spec, spec.columns[column]))
      : registry.register(resolveBodyStyle(spec, spec.columns[column], striped));
  };

  const rowsXml = model.rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const isHeader = model.hasHeader && rowIndex === 0;
      const heightAttribute = isHeader
        ? ` ht="${spec.sheet.headerRowHeightPt}" customHeight="1"`
        : "";
      const cells = Array.from({ length: columnCount }, (_value, column) =>
        cellXml(
          column,
          rowNumber,
          row[column] ?? { type: "empty" },
          styleForCell(rowIndex, column),
        ),
      ).join("");

      return `<row r="${rowNumber}"${heightAttribute}>${cells}</row>`;
    })
    .join("");

  const lastColumn = columnCount > 0 ? columnLetter(columnCount - 1) : "A";
  const lastRow = Math.max(model.rows.length, 1);
  const dimension = `A1:${lastColumn}${lastRow}`;

  const columnsXml: string[] = [];

  for (let column = 0; column < columnCount; column += 1) {
    const override = spec.columns[column]?.width;

    if (override !== undefined) {
      const width = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, override));
      columnsXml.push(
        `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`,
      );
    }
  }

  const cols = columnsXml.length ? `<cols>${columnsXml.join("")}</cols>` : "";

  const ySplit = Math.max(
    spec.sheet.freezeRows,
    spec.sheet.freezeHeaderRow && model.hasHeader ? 1 : 0,
  );
  const xSplit = spec.sheet.freezeColumns;
  let pane = "";

  if (ySplit > 0 || xSplit > 0) {
    const topLeft = `${columnLetter(xSplit)}${ySplit + 1}`;
    const activePane =
      xSplit > 0 && ySplit > 0
        ? "bottomRight"
        : xSplit > 0
          ? "topRight"
          : "bottomLeft";
    const paneAttributes = [
      xSplit > 0 ? `xSplit="${xSplit}"` : "",
      ySplit > 0 ? `ySplit="${ySplit}"` : "",
      `topLeftCell="${topLeft}"`,
      `activePane="${activePane}"`,
      `state="frozen"`,
    ]
      .filter(Boolean)
      .join(" ");

    pane = `<pane ${paneAttributes}/><selection pane="${activePane}"/>`;
  }

  const gridLines = spec.sheet.showGridLines ? "" : ` showGridLines="0"`;
  const sheetPr = `<sheetPr><tabColor rgb="FF${spec.sheet.tabColor}"/>${
    spec.sheet.fitToWidth ? `<pageSetUpPr fitToPage="1"/>` : ""
  }</sheetPr>`;

  const autoFilter =
    spec.sheet.autoFilter && model.hasHeader && columnCount > 0 && model.rows.length > 0
      ? `<autoFilter ref="A1:${columnLetter(columnCount - 1)}${model.rows.length}"/>`
      : "";

  const merges = spec.sheet.merges.length
    ? `<mergeCells count="${spec.sheet.merges.length}">${spec.sheet.merges
        .map((range) => `<mergeCell ref="${escapeXml(range)}"/>`)
        .join("")}</mergeCells>`
    : "";

  const pageSetupAttributes = [
    `orientation="${spec.sheet.orientation}"`,
    `paperSize="${XLSX_PAPER_SIZE_CODES[spec.sheet.paperSize]}"`,
    spec.sheet.fitToWidth ? `fitToWidth="1" fitToHeight="0"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const sheetFormatPr = `<sheetFormatPr defaultRowHeight="${spec.sheet.defaultRowHeight}" defaultColWidth="${spec.sheet.defaultColumnWidth}"/>`;

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`,
    sheetPr,
    `<dimension ref="${dimension}"/>`,
    `<sheetViews><sheetView workbookViewId="0"${gridLines}>${pane}</sheetView></sheetViews>`,
    sheetFormatPr,
    cols,
    `<sheetData>${rowsXml}</sheetData>`,
    autoFilter,
    merges,
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`,
    `<pageSetup ${pageSetupAttributes}/>`,
    `</worksheet>`,
  ].join("");
}

function workbookXml(model: SheetModel[]): string {
  const sheets = model
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`,
    `<workbookPr/>`,
    `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16384" windowHeight="8192"/></bookViews>`,
    `<sheets>${sheets}</sheets>`,
    `<calcPr calcId="0"/>`,
    `</workbook>`,
  ].join("");
}

function workbookRelsXml(sheetCount: number): string {
  const relationships = Array.from(
    { length: sheetCount },
    (_value, index) =>
      `<Relationship Id="rId${index + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${
        index + 1
      }.xml"/>`,
  );

  relationships.push(
    `<Relationship Id="rId${sheetCount + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`,
  );

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<Relationships xmlns="${PACKAGE_REL_NS}">${relationships.join("")}</Relationships>`,
  ].join("");
}

function contentTypesXml(sheetCount: number): string {
  const sheetOverrides = Array.from(
    { length: sheetCount },
    (_value, index) =>
      `<Override PartName="/xl/worksheets/sheet${
        index + 1
      }.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<Types xmlns="${CONTENT_TYPES_NS}">`,
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
    sheetOverrides,
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`,
    `</Types>`,
  ].join("");
}

function rootRelsXml(): string {
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<Relationships xmlns="${PACKAGE_REL_NS}">`,
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>`,
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>`,
    `<Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/>`,
    `</Relationships>`,
  ].join("");
}

function corePropsXml(title: string): string {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    `<dc:title>${escapeXml(title)}</dc:title>`,
    `<dc:creator>Mobile Agent</dc:creator>`,
    `<cp:lastModifiedBy>Mobile Agent</cp:lastModifiedBy>`,
    `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>`,
    `</cp:coreProperties>`,
  ].join("");
}

function appPropsXml(model: SheetModel[]): string {
  const titles = model
    .map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`)
    .join("");

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<Properties xmlns="${EXTENDED_PROPS_NS}" xmlns:vt="${VT_NS}">`,
    `<Application>Mobile Agent</Application>`,
    `<DocSecurity>0</DocSecurity>`,
    `<ScaleCrop>false</ScaleCrop>`,
    `<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${model.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>`,
    `<TitlesOfParts><vt:vector size="${model.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>`,
    `<Company></Company>`,
    `<LinksUpToDate>false</LinksUpToDate>`,
    `<SharedDoc>false</SharedDoc>`,
    `<HyperlinksChanged>false</HyperlinksChanged>`,
    `<AppVersion>16.0300</AppVersion>`,
    `</Properties>`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildXlsx(input: {
  content: string;
  fileName: string;
  spec?: XlsxSpec;
}): Promise<Uint8Array> {
  const spec = input.spec ?? parseXlsxSpec({});
  const baseName = input.fileName.replace(/\.xlsx$/i, "");
  const blocks = parseMarkdownBlocks(input.content);
  const numberFormatFor = (column: number) =>
    spec.columns[column]?.numberFormat ?? spec.body.numberFormat;
  const model = buildSheetModels(
    input.content,
    blocks,
    baseName || "Sheet1",
    numberFormatFor,
  );

  // Styles are collected in one shared registry so every worksheet can
  // reference the same cellXfs table.
  const registry = new StyleRegistry(spec.body.font);
  const worksheetXml = model.map((sheet) => sheetXml(sheet, spec, registry));

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypesXml(model.length)),
    "_rels/.rels": strToU8(rootRelsXml()),
    "docProps/core.xml": strToU8(corePropsXml(spec.title ?? input.fileName)),
    "docProps/app.xml": strToU8(appPropsXml(model)),
    "xl/workbook.xml": strToU8(workbookXml(model)),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRelsXml(model.length)),
    "xl/styles.xml": strToU8(registry.toXml()),
  };

  worksheetXml.forEach((xml, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(xml);
  });

  return zipSync(files, { level: 6 });
}
