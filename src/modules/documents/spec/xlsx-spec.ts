import { z } from "zod";

import { deepMerge } from "@/modules/documents/spec/merge";

export const XLSX_HORIZONTAL_ALIGNMENTS = [
  "general",
  "left",
  "center",
  "right",
  "fill",
  "justify",
  "centerContinuous",
  "distributed",
] as const;

export const XLSX_VERTICAL_ALIGNMENTS = [
  "top",
  "center",
  "bottom",
  "justify",
  "distributed",
] as const;

export const XLSX_BORDER_STYLES = [
  "none",
  "thin",
  "medium",
  "thick",
  "dashed",
  "dotted",
  "double",
  "hair",
  "dashDot",
  "dashDotDot",
  "mediumDashed",
  "mediumDashDot",
  "mediumDashDotDot",
  "slantDashDot",
] as const;

export const XLSX_PATTERN_TYPES = [
  "none",
  "solid",
  "gray125",
  "darkGray",
  "mediumGray",
  "lightGray",
  "lightUp",
  "lightDown",
] as const;

export const XLSX_ORIENTATIONS = ["portrait", "landscape"] as const;

export const XLSX_PAPER_SIZES = [
  "A3",
  "A4",
  "A5",
  "LETTER",
  "LEGAL",
  "TABLOID",
] as const;

/** OOXML `pageSetup/@paperSize` codes (1-based, ECMA-376). */
export const XLSX_PAPER_SIZE_CODES: Record<
  (typeof XLSX_PAPER_SIZES)[number],
  number
> = {
  A3: 8,
  A4: 9,
  A5: 11,
  LETTER: 1,
  LEGAL: 5,
  TABLOID: 3,
};

/**
 * Built-in number format codes mapped to their ECMA-376 `numFmtId`. Shared by
 * the writer (so it never registers a duplicate custom format) and the
 * snapshot engine (to turn a `numFmtId` back into a format code).
 */
export const XLSX_BUILTIN_NUMBER_FORMATS = new Map<string, number>([
  ["General", 0],
  ["0", 1],
  ["0.00", 2],
  ["#,##0", 3],
  ["#,##0.00", 4],
  ["0%", 9],
  ["0.00%", 10],
  ["0.00E+00", 11],
  ["# ?/?", 12],
  ["# ??/??", 13],
  ["mm-dd-yy", 14],
  ["d-mmm-yy", 15],
  ["d-mmm", 16],
  ["mmm-yy", 17],
  ["h:mm AM/PM", 18],
  ["h:mm:ss AM/PM", 19],
  ["h:mm", 20],
  ["h:mm:ss", 21],
  ["m/d/yy h:mm", 22],
  ["@", 49],
]);

const XLSX_NUMBER_FORMAT_CODES = new Map<number, string>(
  [...XLSX_BUILTIN_NUMBER_FORMATS].map(([code, id]) => [id, code]),
);

/** Return the built-in format code for a `numFmtId`, or undefined if unknown. */
export function xlsxNumberFormatCode(id: number): string | undefined {
  return XLSX_NUMBER_FORMAT_CODES.get(id);
}

const colorSchema = z
  .string()
  .regex(
    /^#?[0-9a-fA-F]{6}$/,
    "must be a hex color like #RRGGBB or RRGGBB",
  )
  .transform((value) => value.replace(/^#/, "").toUpperCase());

const fontSchema = z.object({
  /** Font family name as known to Excel (for example "Calibri"). */
  family: z.string().min(1),
  /** Font size in points. */
  sizePt: z.number().positive(),
  /** Hex color without or with leading #. */
  color: colorSchema,
  bold: z.boolean(),
  italic: z.boolean(),
  underline: z.boolean(),
  strike: z.boolean(),
});

const fillSchema = z.object({
  pattern: z.enum(XLSX_PATTERN_TYPES),
  /** Foreground color used by the pattern (solid fills use this). */
  color: colorSchema,
});

const borderSideSchema = z.object({
  style: z.enum(XLSX_BORDER_STYLES),
  color: colorSchema,
});

const borderSchema = z.object({
  top: borderSideSchema,
  bottom: borderSideSchema,
  left: borderSideSchema,
  right: borderSideSchema,
});

const alignmentSchema = z.object({
  horizontal: z.enum(XLSX_HORIZONTAL_ALIGNMENTS),
  vertical: z.enum(XLSX_VERTICAL_ALIGNMENTS),
  wrapText: z.boolean(),
  indent: z.number().int().min(0),
  /** 0-180; 1-90 rotates counter-clockwise, 91-180 clockwise. */
  textRotation: z.number().int().min(0).max(180),
});

const cellStyleSchema = z.object({
  font: fontSchema,
  fill: fillSchema,
  border: borderSchema,
  alignment: alignmentSchema,
  /** Excel number format code, for example "#,##0.00", "0%", "yyyy-mm-dd". */
  numberFormat: z.string().min(1),
});

/**
 * Per-column overrides. Every field is optional; unspecified values fall back
 * to the sheet's `body` (data cells) or `header` style, so columns can be
 * adjusted individually without restating the whole document style.
 */
const columnSchema = z.object({
  /** Column width in character units. */
  width: z.number().positive().optional(),
  numberFormat: z.string().min(1).optional(),
  horizontal: z.enum(XLSX_HORIZONTAL_ALIGNMENTS).optional(),
  vertical: z.enum(XLSX_VERTICAL_ALIGNMENTS).optional(),
  wrapText: z.boolean().optional(),
  /** Body cell fill (hex color, solid). */
  fill: colorSchema.optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: colorSchema.optional(),
  sizePt: z.number().positive().optional(),
  family: z.string().min(1).optional(),
  /** Header overrides. */
  headerFill: colorSchema.optional(),
  headerColor: colorSchema.optional(),
  headerBold: z.boolean().optional(),
});

/**
 * Full, validated xlsx formatting spec. Every field is required after
 * `parseXlsxSpec` has merged the user input onto `defaultXlsxSpec`, so the
 * writer can rely on the whole shape being present.
 */
export const xlsxSpecSchema = z.object({
  sheet: z.object({
    /** Default column width in character units. */
    defaultColumnWidth: z.number().positive(),
    /** Default row height in points. */
    defaultRowHeight: z.number().positive(),
    /** Header row height in points. */
    headerRowHeightPt: z.number().positive(),
    showGridLines: z.boolean(),
    /** Freeze the header row so it stays visible when scrolling. */
    freezeHeaderRow: z.boolean(),
    /** Extra frozen rows below the header (total frozen = max of the two). */
    freezeRows: z.number().int().min(0),
    /** Frozen leading columns. */
    freezeColumns: z.number().int().min(0),
    /** Add an auto-filter over the table range. */
    autoFilter: z.boolean(),
    /** Worksheet tab color (hex). */
    tabColor: colorSchema,
    orientation: z.enum(XLSX_ORIENTATIONS),
    paperSize: z.enum(XLSX_PAPER_SIZES),
    fitToWidth: z.boolean(),
    /** Cell ranges to merge, for example "A1:C1". */
    merges: z.array(z.string().min(1)),
  }),
  /** Style applied to header cells (tables and generated "Content" rows). */
  header: cellStyleSchema,
  /** Default style applied to data cells. */
  body: cellStyleSchema,
  /** Optional alternating-row shading for data rows. */
  stripes: z.object({
    enabled: z.boolean(),
    fill: fillSchema,
  }),
  /** Sparse per-column overrides, indexed by column position (0-based). */
  columns: z.array(columnSchema),
  /** Optional workbook title stored in the document properties. */
  title: z.string().min(1).optional(),
});

export type XlsxSpec = z.infer<typeof xlsxSpecSchema>;
export type XlsxCellStyle = z.infer<typeof cellStyleSchema>;
export type XlsxColumnSpec = z.infer<typeof columnSchema>;

export function defaultXlsxSpec(): XlsxSpec {
  const bodyFont = {
    family: "Calibri",
    sizePt: 11,
    color: "000000",
    bold: false,
    italic: false,
    underline: false,
    strike: false,
  };

  const headerFont = { ...bodyFont, bold: true };
  const thin = { style: "thin" as const, color: "BFBFBF" };
  const border = { top: thin, bottom: thin, left: thin, right: thin };

  return {
    sheet: {
      defaultColumnWidth: 12,
      defaultRowHeight: 15,
      headerRowHeightPt: 18,
      showGridLines: true,
      freezeHeaderRow: true,
      freezeRows: 0,
      freezeColumns: 0,
      autoFilter: true,
      tabColor: "4472C4",
      orientation: "portrait",
      paperSize: "A4",
      fitToWidth: false,
      merges: [],
    },
    header: {
      font: headerFont,
      fill: { pattern: "solid", color: "F2F2F2" },
      border,
      alignment: {
        horizontal: "left",
        vertical: "center",
        wrapText: false,
        indent: 0,
        textRotation: 0,
      },
      numberFormat: "General",
    },
    body: {
      font: bodyFont,
      fill: { pattern: "none", color: "FFFFFF" },
      border,
      alignment: {
        horizontal: "left",
        vertical: "top",
        wrapText: false,
        indent: 0,
        textRotation: 0,
      },
      numberFormat: "General",
    },
    stripes: {
      enabled: false,
      fill: { pattern: "solid", color: "F7F7F7" },
    },
    columns: [],
  };
}

/**
 * Merge a (possibly partial) user xlsx spec onto the defaults and validate it.
 * Throws a clear error when the input does not match the documented shape, so
 * invalid specs never silently produce a default-looking spreadsheet.
 */
export function parseXlsxSpec(input: unknown): XlsxSpec {
  const candidate = deepMerge(defaultXlsxSpec(), input);

  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new Error("Invalid xlsx spec: expected an object.");
  }

  const result = xlsxSpecSchema.safeParse(candidate);

  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") ?? "value";
    const message = issue?.message ?? "does not match the documented spec";
    throw new Error(
      `Invalid xlsx spec at ${path || "root"}: ${message}. Use createFile/updateDocument with a spec object or YAML front-matter 'format:' block.`,
    );
  }

  return result.data;
}
