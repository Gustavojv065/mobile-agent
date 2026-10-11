import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

import {
  parseXlsxSpec,
  XLSX_BORDER_STYLES,
  XLSX_HORIZONTAL_ALIGNMENTS,
  XLSX_PAPER_SIZE_CODES,
  XLSX_VERTICAL_ALIGNMENTS,
  xlsxNumberFormatCode,
  type XlsxSpec,
} from "@/modules/documents/spec/xlsx-spec";

/**
 * Style snapshot for imported `.xlsx` files. Reads the OOXML package and maps
 * the original formatting (default/body font, header style, cell fills,
 * borders, number formats, column widths, freeze panes, auto-filter, tab
 * colour and page setup) onto the validated `XlsxSpec`, so later updates keep
 * the original look. Anything that cannot be read reliably falls back to the
 * spec defaults, so the snapshot always yields a complete, valid spec.
 *
 * Fidelity notes: per-cell formatting that is not consistent across a column
 * is approximated by the column's first row; conditional formatting, themes
 * (only literal RGB colours are captured) and charts are not extracted.
 */

type XmlNode =
  | string
  | number
  | null
  | undefined
  | XmlNode[]
  | { [key: string]: XmlNode };

const HORIZONTAL_ALIGNMENTS = new Set<string>(XLSX_HORIZONTAL_ALIGNMENTS);
const VERTICAL_ALIGNMENTS = new Set<string>(XLSX_VERTICAL_ALIGNMENTS);
const BORDER_STYLES = new Set<string>(XLSX_BORDER_STYLES);
const PATTERN_TYPES = new Set<string>([
  "none",
  "solid",
  "gray125",
  "darkGray",
  "mediumGray",
  "lightGray",
  "lightUp",
  "lightDown",
]);

const PAPER_SIZE_NAMES = new Map<number, string>(
  Object.entries(XLSX_PAPER_SIZE_CODES).map(([name, code]) => [code, name]),
);

function makeParser(): XMLParser {
  const repeated = new Set([
    "font",
    "fill",
    "border",
    "xf",
    "numFmt",
    "col",
    "row",
    "c",
    "mergeCell",
    "Relationship",
  ]);

  return new XMLParser({
    attributeNamePrefix: "@_",
    ignoreAttributes: false,
    isArray: (name) => repeated.has(name),
    parseAttributeValue: false,
    parseTagValue: false,
    removeNSPrefix: true,
  });
}

function asObject(
  node: XmlNode | undefined,
): Record<string, unknown> | null {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    return node as Record<string, unknown>;
  }

  return null;
}

function attr(node: unknown, key: string): string | undefined {
  const object = asObject(node as XmlNode);

  if (!object) {
    return undefined;
  }

  const value = object[`@_${key}`];

  return typeof value === "string" ? value : undefined;
}

function hexColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^#?(?:[0-9a-fA-F]{2})?([0-9a-fA-F]{6})$/.exec(value.trim());

  return match ? match[1]!.toUpperCase() : undefined;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function intFrom(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function truthy(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "0" || normalized === "false" || normalized === "off") {
    return false;
  }

  return true;
}

/** Read an OOXML boolean flag element such as `<b/>` or `<b val="0"/>`. */
function flag(
  object: Record<string, unknown> | null,
  key: string,
): boolean | undefined {
  if (!object || !(key in object)) {
    return undefined;
  }

  const raw = attr(object[key], "val");

  return raw === undefined ? true : truthy(raw);
}

type FontInfo = {
  bold?: boolean;
  color?: string;
  family?: string;
  italic?: boolean;
  sizePt?: number;
  strike?: boolean;
  underline?: boolean;
};

type FillInfo = { color?: string; pattern: string };
type BorderSideInfo = { color?: string; style: string };
type BorderInfo = {
  bottom: BorderSideInfo;
  left: BorderSideInfo;
  right: BorderSideInfo;
  top: BorderSideInfo;
};
type AlignmentInfo = {
  horizontal?: string;
  vertical?: string;
  wrapText?: boolean;
};
type XfInfo = {
  alignment?: AlignmentInfo;
  borderId: number;
  fillId: number;
  fontId: number;
  numFmtId: number;
};

function parseFont(node: XmlNode): FontInfo {
  const object = asObject(node) ?? {};

  return {
    family: attr(asObject(object.name as XmlNode), "val"),
    sizePt: positiveNumber(attr(asObject(object.sz as XmlNode), "val")),
    color: hexColor(attr(asObject(object.color as XmlNode), "rgb")),
    bold: flag(object, "b"),
    italic: flag(object, "i"),
    underline: flag(object, "u"),
    strike: flag(object, "strike"),
  };
}

function parseFill(node: XmlNode): FillInfo {
  const object = asObject(node) ?? {};
  const patternFill = asObject(object.patternFill as XmlNode) ?? {};
  const pattern = attr(patternFill, "patternType") ?? "none";
  const color = hexColor(attr(asObject(patternFill.fgColor as XmlNode), "rgb"));

  return { pattern, color };
}

function parseBorderSide(node: XmlNode): BorderSideInfo {
  const object = asObject(node);

  if (!object) {
    return { style: "none" };
  }

  return {
    style: attr(object, "style") ?? "none",
    color: hexColor(attr(asObject(object.color as XmlNode), "rgb")),
  };
}

function parseBorder(node: XmlNode): BorderInfo {
  const object = asObject(node) ?? {};

  return {
    top: parseBorderSide(object.top as XmlNode),
    bottom: parseBorderSide(object.bottom as XmlNode),
    left: parseBorderSide(object.left as XmlNode),
    right: parseBorderSide(object.right as XmlNode),
  };
}

function parseXf(node: XmlNode): XfInfo {
  const object = asObject(node) ?? {};
  const alignmentObject = asObject(object.alignment as XmlNode);

  return {
    numFmtId: intFrom(attr(object, "numFmtId"), 0),
    fontId: intFrom(attr(object, "fontId"), 0),
    fillId: intFrom(attr(object, "fillId"), 0),
    borderId: intFrom(attr(object, "borderId"), 0),
    alignment: alignmentObject
      ? {
          horizontal: attr(alignmentObject, "horizontal"),
          vertical: attr(alignmentObject, "vertical"),
          wrapText: truthy(attr(alignmentObject, "wrapText")),
        }
      : undefined,
  };
}

type StyleTable = {
  borders: BorderInfo[];
  fills: FillInfo[];
  fonts: FontInfo[];
  numFmts: Map<number, string>;
  xfs: XfInfo[];
};

function parseStyles(stylesXml: string | null): StyleTable | null {
  if (stylesXml === null) {
    return null;
  }

  let tree: XmlNode;

  try {
    tree = makeParser().parse(stylesXml) as XmlNode;
  } catch {
    return null;
  }

  const styleSheet = asObject(asObject(tree)?.styleSheet as XmlNode);

  if (!styleSheet) {
    return null;
  }

  const fontsContainer = asObject(styleSheet.fonts as XmlNode);
  const fillsContainer = asObject(styleSheet.fills as XmlNode);
  const bordersContainer = asObject(styleSheet.borders as XmlNode);
  const cellXfsContainer = asObject(styleSheet.cellXfs as XmlNode);
  const numFmtsContainer = asObject(styleSheet.numFmts as XmlNode);

  const numFmts = new Map<number, string>();

  for (const entry of (numFmtsContainer?.numFmt as XmlNode[] | undefined) ?? []) {
    const id = intFrom(attr(entry, "numFmtId"), -1);
    const code = attr(entry, "formatCode");

    if (id >= 0 && code) {
      numFmts.set(id, code);
    }
  }

  return {
    fonts: ((fontsContainer?.font as XmlNode[] | undefined) ?? []).map(parseFont),
    fills: ((fillsContainer?.fill as XmlNode[] | undefined) ?? []).map(parseFill),
    borders: ((bordersContainer?.border as XmlNode[] | undefined) ?? []).map(
      parseBorder,
    ),
    xfs: ((cellXfsContainer?.xf as XmlNode[] | undefined) ?? []).map(parseXf),
    numFmts,
  };
}

type CellInfo = { column: number; styleId: number };

type RowInfo = {
  cells: CellInfo[];
  heightPt?: number;
  index: number;
};

type SheetInfo = {
  autoFilter: boolean;
  columns: Map<number, number>;
  fitToPage: boolean;
  merges: string[];
  orientation?: string;
  paperSizeCode?: number;
  rows: RowInfo[];
  showGridLines?: boolean;
  tabColor?: string;
  xSplit: number;
  ySplit: number;
};

function columnIndexFromRef(ref: string): number {
  const match = /^([A-Za-z]+)\d+$/.exec(ref.trim());

  if (!match) {
    return 0;
  }

  let index = 0;

  for (const character of match[1]!.toUpperCase()) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }

  return index - 1;
}

function parseWorksheet(sheetXml: string | null): SheetInfo | null {
  if (sheetXml === null) {
    return null;
  }

  let tree: XmlNode;

  try {
    tree = makeParser().parse(sheetXml) as XmlNode;
  } catch {
    return null;
  }

  const worksheet = asObject(asObject(tree)?.worksheet as XmlNode);

  if (!worksheet) {
    return null;
  }

  const sheetPr = asObject(worksheet.sheetPr as XmlNode);
  const sheetViews = asObject(worksheet.sheetViews as XmlNode);
  const sheetView = asObject(sheetViews?.sheetView as XmlNode);
  const pane = asObject(sheetView?.pane as XmlNode);
  const pageSetup = asObject(worksheet.pageSetup as XmlNode);
  const colsContainer = asObject(worksheet.cols as XmlNode);
  const sheetData = asObject(worksheet.sheetData as XmlNode);
  const mergeCells = asObject(worksheet.mergeCells as XmlNode);

  const columns = new Map<number, number>();

  for (const col of (colsContainer?.col as XmlNode[] | undefined) ?? []) {
    const min = intFrom(attr(col, "min"), 1);
    const max = intFrom(attr(col, "max"), min);
    const width = positiveNumber(attr(col, "width"));

    if (width === undefined) {
      continue;
    }

    for (let index = min; index <= Math.min(max, min + 256); index += 1) {
      columns.set(index - 1, width);
    }
  }

  const rows: RowInfo[] = ((sheetData?.row as XmlNode[] | undefined) ?? []).map(
    (row, fallbackIndex) => {
      const cells = ((asObject(row)?.c as XmlNode[] | undefined) ?? []).map(
        (cell) => ({
          column: columnIndexFromRef(attr(cell, "r") ?? "A1"),
          styleId: intFrom(attr(cell, "s"), 0),
        }),
      );

      return {
        index: intFrom(attr(row, "r"), fallbackIndex + 1),
        heightPt: positiveNumber(attr(row, "ht")),
        cells,
      };
    },
  );

  return {
    tabColor: hexColor(attr(asObject(sheetPr?.tabColor as XmlNode), "rgb")),
    showGridLines: truthy(attr(sheetView, "showGridLines")),
    xSplit: intFrom(attr(pane, "xSplit"), 0),
    ySplit: intFrom(attr(pane, "ySplit"), 0),
    fitToPage:
      truthy(attr(asObject(sheetPr?.pageSetUpPr as XmlNode), "fitToPage")) ===
      true,
    autoFilter: asObject(worksheet.autoFilter as XmlNode) !== null,
    orientation: attr(pageSetup, "orientation"),
    paperSizeCode: Number.parseInt(attr(pageSetup, "paperSize") ?? "", 10),
    merges: ((mergeCells?.mergeCell as XmlNode[] | undefined) ?? [])
      .map((node) => attr(node, "ref"))
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0),
    columns,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Spec assembly
// ---------------------------------------------------------------------------

function fontPartial(font: FontInfo | undefined): Record<string, unknown> | undefined {
  if (!font) {
    return undefined;
  }

  const partial: Record<string, unknown> = {};

  if (font.family) {
    partial.family = font.family;
  }

  if (font.sizePt !== undefined) {
    partial.sizePt = font.sizePt;
  }

  if (font.color) {
    partial.color = font.color;
  }

  for (const key of ["bold", "italic", "underline", "strike"] as const) {
    if (font[key] !== undefined) {
      partial[key] = font[key];
    }
  }

  return Object.keys(partial).length > 0 ? partial : undefined;
}

function fillPartial(fill: FillInfo | undefined): Record<string, unknown> {
  if (!fill) {
    return { pattern: "none", color: "FFFFFF" };
  }

  const pattern = PATTERN_TYPES.has(fill.pattern) ? fill.pattern : "none";
  const color = fill.color ?? "FFFFFF";

  return { pattern, color };
}

function borderPartial(border: BorderInfo | undefined): Record<string, unknown> {
  const side = (value: BorderSideInfo | undefined) => ({
    style:
      value && BORDER_STYLES.has(value.style) ? value.style : ("none" as const),
    color: value?.color ?? "000000",
  });

  return {
    top: side(border?.top),
    bottom: side(border?.bottom),
    left: side(border?.left),
    right: side(border?.right),
  };
}

function alignmentPartial(xf: XfInfo | undefined): Record<string, unknown> {
  const alignment = xf?.alignment;

  return {
    horizontal:
      alignment?.horizontal && HORIZONTAL_ALIGNMENTS.has(alignment.horizontal)
        ? alignment.horizontal
        : "general",
    vertical:
      alignment?.vertical && VERTICAL_ALIGNMENTS.has(alignment.vertical)
        ? alignment.vertical
        : "bottom",
    wrapText: alignment?.wrapText ?? false,
    indent: 0,
    textRotation: 0,
  };
}

function numberFormatFor(
  styles: StyleTable,
  numFmtId: number,
): string | undefined {
  if (numFmtId === 0) {
    return undefined;
  }

  return styles.numFmts.get(numFmtId) ?? xlsxNumberFormatCode(numFmtId);
}

function cellStylePartial(
  styles: StyleTable,
  xf: XfInfo,
): Record<string, unknown> {
  const partial: Record<string, unknown> = {
    fill: fillPartial(styles.fills[xf.fillId]),
    border: borderPartial(styles.borders[xf.borderId]),
    alignment: alignmentPartial(xf),
  };

  const font = fontPartial(styles.fonts[xf.fontId]);

  if (font) {
    partial.font = font;
  }

  const numberFormat = numberFormatFor(styles, xf.numFmtId);

  if (numberFormat) {
    partial.numberFormat = numberFormat;
  }

  return partial;
}

function mostCommonStyle(cells: CellInfo[]): number | undefined {
  const counts = new Map<number, number>();

  for (const cell of cells) {
    counts.set(cell.styleId, (counts.get(cell.styleId) ?? 0) + 1);
  }

  let best: number | undefined;
  let bestCount = -1;

  for (const [styleId, count] of counts) {
    if (count > bestCount) {
      best = styleId;
      bestCount = count;
    }
  }

  return best;
}

function xfAt(styles: StyleTable, styleId: number | undefined): XfInfo | undefined {
  if (styleId === undefined) {
    return undefined;
  }

  return styles.xfs[styleId];
}

function buildColumns(
  styles: StyleTable,
  sheet: SheetInfo,
  bodyXf: XfInfo | undefined,
): Record<string, unknown>[] {
  const dataRows = sheet.rows.slice(1);
  const columnIndices = new Set<number>();

  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      columnIndices.add(cell.column);
    }
  }

  const bodyHorizontal = bodyXf?.alignment?.horizontal;
  const columns: Record<string, unknown>[] = [];
  const maxColumn = Math.max(...columnIndices, 0);

  for (let column = 0; column <= maxColumn; column += 1) {
    const partial: Record<string, unknown> = {};
    const width = sheet.columns.get(column);

    if (width !== undefined) {
      partial.width = Math.round(width * 100) / 100;
    }

    const firstDataCell = dataRows.find((row) =>
      row.cells.some((cell) => cell.column === column),
    );
    const cell = firstDataCell?.cells.find((entry) => entry.column === column);
    const xf = xfAt(styles, cell?.styleId);

    if (xf) {
      const numberFormat = numberFormatFor(styles, xf.numFmtId);

      if (numberFormat) {
        partial.numberFormat = numberFormat;
      }

      const horizontal = xf.alignment?.horizontal;

      if (
        horizontal &&
        HORIZONTAL_ALIGNMENTS.has(horizontal) &&
        horizontal !== bodyHorizontal
      ) {
        partial.horizontal = horizontal;
      }

      if (xf.alignment?.wrapText) {
        partial.wrapText = true;
      }
    }

    if (Object.keys(partial).length > 0) {
      columns[column] = partial;
    } else {
      columns[column] = {};
    }
  }

  return columns;
}

function detectStripes(
  styles: StyleTable,
  sheet: SheetInfo,
): { enabled: boolean; fill: { pattern: string; color: string } } | undefined {
  const dataRows = sheet.rows.slice(1);

  if (dataRows.length < 2) {
    return undefined;
  }

  const firstStyle = mostCommonStyle(dataRows[0]!.cells);
  const secondStyle = mostCommonStyle(dataRows[1]!.cells);

  if (firstStyle === undefined || secondStyle === undefined || firstStyle === secondStyle) {
    return undefined;
  }

  const secondXf = xfAt(styles, secondStyle);
  const fill = secondXf ? styles.fills[secondXf.fillId] : undefined;

  if (fill?.pattern === "solid" && fill.color) {
    return { enabled: true, fill: { pattern: "solid", color: fill.color } };
  }

  return undefined;
}

function paperSizeName(code: number | undefined): string | undefined {
  if (code === undefined || Number.isNaN(code)) {
    return undefined;
  }

  return PAPER_SIZE_NAMES.get(code);
}

function decodeEntry(
  zip: Record<string, Uint8Array>,
  path: string,
): string | null {
  const entry = zip[path];

  return entry ? new TextDecoder().decode(entry) : null;
}

function firstWorksheetPath(zip: Record<string, Uint8Array>): string {
  const relsXml = decodeEntry(zip, "xl/_rels/workbook.xml.rels");

  if (relsXml === null) {
    return "xl/worksheets/sheet1.xml";
  }

  try {
    const tree = makeParser().parse(relsXml) as XmlNode;
    const relationships =
      (asObject(asObject(tree)?.Relationships as XmlNode)?.Relationship as
        | XmlNode[]
        | undefined) ?? [];
    const worksheet = relationships.find((relationship) =>
      (attr(relationship, "Type") ?? "").endsWith("/worksheet"),
    );
    const target = worksheet ? attr(worksheet, "Target") : undefined;

    if (target) {
      const normalized = target.replace(/^\//, "");
      return normalized.startsWith("xl/") ? normalized : `xl/${normalized}`;
    }
  } catch {
    // fall through to the default path
  }

  return "xl/worksheets/sheet1.xml";
}

function coreTitle(zip: Record<string, Uint8Array>): string | undefined {
  const coreXml = decodeEntry(zip, "docProps/core.xml");

  if (coreXml === null) {
    return undefined;
  }

  try {
    const tree = makeParser().parse(coreXml) as XmlNode;
    const core = asObject(asObject(tree)?.coreProperties as XmlNode);

    if (!core) {
      return undefined;
    }

    const title = core.title;
    const text = asObject(title as XmlNode)?.["#text"] ?? title;

    return typeof text === "string" && text.trim().length > 0
      ? text.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build an `XlsxSpec` from an imported workbook, or null when the bytes are
 * not a readable xlsx package.
 */
export async function snapshotXlsxSpec(
  bytes: Uint8Array,
): Promise<XlsxSpec | null> {
  let zip: Record<string, Uint8Array>;

  try {
    zip = unzipSync(bytes);
  } catch {
    return null;
  }

  const styles = parseStyles(decodeEntry(zip, "xl/styles.xml"));
  const sheet = parseWorksheet(
    decodeEntry(zip, firstWorksheetPath(zip)),
  );

  if (!styles || !sheet || sheet.rows.length === 0) {
    return null;
  }

  const headerStyleId = mostCommonStyle(sheet.rows[0]!.cells);
  const dataCells = sheet.rows.slice(1).flatMap((row) => row.cells);
  const bodyStyleId = mostCommonStyle(dataCells) ?? headerStyleId;
  const headerXf = xfAt(styles, headerStyleId);
  const bodyXf = xfAt(styles, bodyStyleId);

  const partial: Record<string, unknown> = {};

  if (headerXf) {
    partial.header = cellStylePartial(styles, headerXf);
  }

  if (bodyXf) {
    partial.body = cellStylePartial(styles, bodyXf);
  }

  const stripes = detectStripes(styles, sheet);

  if (stripes && bodyXf && styles.fills[bodyXf.fillId]?.pattern !== "solid") {
    partial.stripes = stripes;
  }

  const columns = buildColumns(styles, sheet, bodyXf);

  if (columns.length > 0) {
    partial.columns = columns;
  }

  const sheetPartial: Record<string, unknown> = {
    freezeHeaderRow: sheet.ySplit >= 1,
    autoFilter: sheet.autoFilter,
    showGridLines: sheet.showGridLines ?? true,
    fitToWidth: sheet.fitToPage,
  };

  if (sheet.ySplit > 1) {
    sheetPartial.freezeRows = sheet.ySplit;
  }

  if (sheet.xSplit > 0) {
    sheetPartial.freezeColumns = sheet.xSplit;
  }

  if (sheet.tabColor) {
    sheetPartial.tabColor = sheet.tabColor;
  }

  if (sheet.orientation === "landscape" || sheet.orientation === "portrait") {
    sheetPartial.orientation = sheet.orientation;
  }

  const paperSize = paperSizeName(sheet.paperSizeCode);

  if (paperSize) {
    sheetPartial.paperSize = paperSize;
  }

  if (sheet.merges.length > 0) {
    sheetPartial.merges = sheet.merges;
  }

  partial.sheet = sheetPartial;

  const title = coreTitle(zip);

  if (title) {
    partial.title = title;
  }

  try {
    return parseXlsxSpec(partial);
  } catch {
    return null;
  }
}
