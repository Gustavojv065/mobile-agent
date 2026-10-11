import { z } from "zod";

import { deepMerge } from "@/modules/documents/spec/merge";

export const PDF_PAGE_SIZES = [
  "A3",
  "A4",
  "A5",
  "LETTER",
  "LEGAL",
  "TABLOID",
] as const;

export const PDF_ORIENTATIONS = ["portrait", "landscape"] as const;

export const PDF_ALIGNMENTS = ["left", "center", "right", "justified"] as const;

/** Page dimensions in points, portrait orientation. */
export const PDF_PAGE_SIZE_PT: Record<
  (typeof PDF_PAGE_SIZES)[number],
  { height: number; width: number }
> = {
  A3: { width: 841.89, height: 1190.55 },
  A4: { width: 595.28, height: 841.89 },
  A5: { width: 419.53, height: 595.28 },
  LETTER: { width: 612, height: 792 },
  LEGAL: { width: 612, height: 1008 },
  TABLOID: { width: 792, height: 1224 },
};

const colorSchema = z
  .string()
  .regex(
    /^#?[0-9a-fA-F]{6}$/,
    "must be a hex color like #RRGGBB or RRGGBB",
  )
  .transform((value) => value.replace(/^#/, "").toUpperCase());

const fontStyleSchema = z.object({
  /**
   * Font family name. The PDF writer uses the standard PDF faces, so families
   * are approximated: sans-serif families render as Helvetica, serif families
   * (times, Georgia, ...) as Times, monospace families (courier, consolas, ...)
   * as Courier. Embedded custom fonts are not supported.
   */
  family: z.string().min(1),
  /** Font size in points. */
  sizePt: z.number().positive(),
  /** Hex color without or with leading #. */
  color: colorSchema,
  bold: z.boolean(),
  italic: z.boolean(),
});

const headingStyleSchema = z.object({
  sizePt: z.number().positive(),
  color: colorSchema,
  bold: z.boolean(),
  spacingBeforePt: z.number().min(0),
  spacingAfterPt: z.number().min(0),
});

/**
 * Full, validated pdf formatting spec. Every field is required after
 * `parsePdfSpec` has merged the user input onto `defaultPdfSpec`, so the
 * builder can rely on the whole shape being present. All sizes are points;
 * page sizes come from the fixed preset list.
 */
export const pdfSpecSchema = z.object({
  page: z.object({
    size: z.enum(PDF_PAGE_SIZES),
    orientation: z.enum(PDF_ORIENTATIONS),
    marginTopPt: z.number().min(0),
    marginRightPt: z.number().min(0),
    marginBottomPt: z.number().min(0),
    marginLeftPt: z.number().min(0),
  }),
  fonts: z.object({
    body: fontStyleSchema,
    headings: z.object({
      family: z.string().min(1),
    }),
    code: fontStyleSchema,
    table: fontStyleSchema,
    header: fontStyleSchema,
    footer: fontStyleSchema,
  }),
  paragraphs: z.object({
    /** Default spacing after every paragraph, in points. */
    spacingAfterPt: z.number().min(0),
    /** Multiplier of single line height, for example 1.15. */
    lineSpacing: z.number().min(1).max(3),
    alignment: z.enum(PDF_ALIGNMENTS),
  }),
  headings: z.object({
    /** Spacing before headings without an explicit per-level value, points. */
    spacingBeforePt: z.number().min(0),
    /** Spacing after headings without an explicit per-level value, points. */
    spacingAfterPt: z.number().min(0),
  }),
  headingStyles: z.object({
    1: headingStyleSchema,
    2: headingStyleSchema,
    3: headingStyleSchema,
    4: headingStyleSchema,
    5: headingStyleSchema,
    6: headingStyleSchema,
  }),
  codeBlock: z.object({
    background: colorSchema,
    textColor: colorSchema,
  }),
  lists: z.object({
    /** Indentation of wrapped list body lines, in points. */
    indentPt: z.number().min(0),
    spacingAfterPt: z.number().min(0),
  }),
  tables: z.object({
    headerBackground: colorSchema,
    headerTextColor: colorSchema,
    headerBold: z.boolean(),
    borderColor: colorSchema,
  }),
  header: z.object({
    /** Header text; "{PAGE}" renders the current page number. Empty = none. */
    text: z.string(),
  }),
  footer: z.object({
    /** Footer text; "{PAGE}" renders the current page number. Empty = none. */
    text: z.string(),
  }),
  pageNumberPosition: z.enum(["left", "center", "right"]),
  images: z.object({
    /** Fallback width for images without an explicit size, in points. */
    defaultWidthPt: z.number().positive(),
    /** Largest rendered image height, in points. */
    maxHeightPt: z.number().positive(),
  }),
  /** Optional document title; falls back to the file name. */
  title: z.string().min(1).optional(),
});

export type PdfSpec = z.infer<typeof pdfSpecSchema>;

const DEFAULT_HEADING_COLORS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "2E74B5",
  2: "2E74B5",
  3: "1F4D78",
  4: "1F4D78",
  5: "404040",
  6: "404040",
};

/** Word-like heading sizes in points. */
const DEFAULT_HEADING_SIZES: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 20,
  2: 16,
  3: 14,
  4: 12,
  5: 12,
  6: 12,
};

export function defaultPdfSpec(): PdfSpec {
  const headingStyles = {} as PdfSpec["headingStyles"];

  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    headingStyles[level] = {
      sizePt: DEFAULT_HEADING_SIZES[level],
      color: DEFAULT_HEADING_COLORS[level],
      bold: true,
      spacingBeforePt: level <= 3 ? 12 : 6,
      spacingAfterPt: level <= 3 ? 8 : 4,
    };
  }

  return {
    page: {
      size: "A4",
      orientation: "portrait",
      marginTopPt: 72,
      marginRightPt: 72,
      marginBottomPt: 72,
      marginLeftPt: 72,
    },
    fonts: {
      body: {
        family: "Calibri",
        sizePt: 11,
        color: "000000",
        bold: false,
        italic: false,
      },
      headings: { family: "Calibri" },
      code: {
        family: "Courier New",
        sizePt: 9.5,
        color: "404040",
        bold: false,
        italic: false,
      },
      table: {
        family: "Calibri",
        sizePt: 10,
        color: "000000",
        bold: false,
        italic: false,
      },
      header: {
        family: "Calibri",
        sizePt: 9,
        color: "666666",
        bold: false,
        italic: false,
      },
      footer: {
        family: "Calibri",
        sizePt: 9,
        color: "666666",
        bold: false,
        italic: false,
      },
    },
    paragraphs: {
      spacingAfterPt: 8,
      lineSpacing: 1.15,
      alignment: "left",
    },
    headings: {
      spacingBeforePt: 12,
      spacingAfterPt: 8,
    },
    headingStyles,
    codeBlock: {
      background: "F2F2F2",
      textColor: "404040",
    },
    lists: {
      indentPt: 28,
      spacingAfterPt: 2,
    },
    tables: {
      headerBackground: "E8E8E8",
      headerTextColor: "000000",
      headerBold: true,
      borderColor: "BFBFBF",
    },
    header: { text: "" },
    footer: { text: "" },
    pageNumberPosition: "center",
    images: {
      defaultWidthPt: 320,
      maxHeightPt: 440,
    },
  };
}

/** Resolve effective page size in points, respecting orientation. */
export function pdfPageSizePt(spec: PdfSpec): {
  height: number;
  width: number;
} {
  const base = PDF_PAGE_SIZE_PT[spec.page.size];

  if (spec.page.orientation === "landscape") {
    return { width: base.height, height: base.width };
  }

  return base;
}

/**
 * Merge a (possibly partial) user pdf spec onto the defaults and validate it.
 * Throws a clear error when the input does not match the documented shape, so
 * invalid specs never silently produce a default-looking document.
 */
export function parsePdfSpec(input: unknown): PdfSpec {
  const candidate = deepMerge(defaultPdfSpec(), input);

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Invalid pdf spec: expected an object.");
  }

  const result = pdfSpecSchema.safeParse(candidate);

  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") ?? "value";
    const message = issue?.message ?? "does not match the documented spec";
    throw new Error(
      `Invalid pdf spec at ${path || "root"}: ${message}. Use createFile/updateDocument with a spec object or YAML front-matter 'format:' block.`,
    );
  }

  return result.data;
}