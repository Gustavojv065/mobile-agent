import { z } from "zod";

import { deepMerge } from "@/modules/documents/spec/merge";

export const DOCX_PAGE_SIZES = [
  "A3",
  "A4",
  "A5",
  "LETTER",
  "LEGAL",
  "TABLOID",
] as const;

export const DOCX_ORIENTATIONS = ["portrait", "landscape"] as const;

export const DOCX_ALIGNMENTS = ["left", "center", "right", "justified"] as const;

export const DOCX_PAGE_NUMBER_POSITIONS = ["left", "center", "right"] as const;

/** Twips (1/20 pt) per page size, portrait orientation. */
export const DOCX_PAGE_SIZE_TWIPS: Record<
  (typeof DOCX_PAGE_SIZES)[number],
  { height: number; width: number }
> = {
  A3: { width: 16838, height: 23811 },
  A4: { width: 11906, height: 16838 },
  A5: { width: 8391, height: 11906 },
  LETTER: { width: 12240, height: 15840 },
  LEGAL: { width: 12240, height: 20160 },
  TABLOID: { width: 15840, height: 24480 },
};

const colorSchema = z
  .string()
  .regex(
    /^#?[0-9a-fA-F]{6}$/,
    "must be a hex color like #RRGGBB or RRGGBB",
  )
  .transform((value) => value.replace(/^#/, "").toUpperCase());

const fontStyleSchema = z.object({
  /** Font family name as known to the target app (for example "Georgia"). */
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
  /** Optional per-level family; falls back to fonts.headings.family. */
  family: z.string().min(1).optional(),
});

/**
 * Full, validated docx formatting spec. Every field is required after
 * `parseDocxSpec` has merged the user input onto `defaultDocxSpec`, so the
 * builder can rely on the whole shape being present.
 */
export const docxSpecSchema = z.object({
  page: z.object({
    size: z.enum(DOCX_PAGE_SIZES),
    orientation: z.enum(DOCX_ORIENTATIONS),
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
    alignment: z.enum(DOCX_ALIGNMENTS),
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
  pageNumberPosition: z.enum(DOCX_PAGE_NUMBER_POSITIONS),
  includeToc: z.boolean(),
  tocTitle: z.string().min(1),
  tocHeadingRange: z.string(),
  images: z.object({
    /** Fallback width for images without an explicit size, in pixels. */
    defaultWidthPx: z.number().int().positive(),
  }),
  /** Optional document title; falls back to the file name. */
  title: z.string().min(1).optional(),
});

export type DocxSpec = z.infer<typeof docxSpecSchema>;

const DEFAULT_HEADING_COLORS: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "2E74B5",
  2: "2E74B5",
  3: "1F4D78",
  4: "1F4D78",
  5: "404040",
  6: "404040",
};

/** Built-in heading sizes in points, Word-like. */
const DEFAULT_HEADING_SIZES: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 20,
  2: 16,
  3: 14,
  4: 12,
  5: 12,
  6: 12,
};

export function defaultDocxSpec(): DocxSpec {
  const headingStyles = {} as DocxSpec["headingStyles"];

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
    includeToc: false,
    tocTitle: "Table of Contents",
    tocHeadingRange: "1-3",
    images: {
      defaultWidthPx: 400,
    },
  };
}

/**
 * Merge a (possibly partial) user docx spec onto the defaults and validate it.
 * Throws a clear error when the input does not match the documented shape, so
 * invalid specs never silently produce a default-looking document.
 */
export function parseDocxSpec(input: unknown): DocxSpec {
  const candidate = deepMerge(defaultDocxSpec(), input);

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Invalid docx spec: expected an object.");
  }

  const result = docxSpecSchema.safeParse(candidate);

  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") ?? "value";
    const message = issue?.message ?? "does not match the documented spec";
    throw new Error(
      `Invalid docx spec at ${path || "root"}: ${message}. Use createFile/updateDocument with a spec object or YAML front-matter 'format:' block.`,
    );
  }

  return result.data;
}