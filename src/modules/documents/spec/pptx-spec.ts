import { z } from "zod";

import { deepMerge } from "@/modules/documents/spec/merge";

export const PPTX_LAYOUTS = ["16x9", "16x10", "4x3", "wide", "custom"] as const;

export const PPTX_ALIGNMENTS = [
  "left",
  "center",
  "right",
  "justify",
] as const;

export const PPTX_VERTICAL_ALIGNMENTS = ["top", "middle", "bottom"] as const;

/** Slide dimensions in inches for each built-in layout preset. */
export const PPTX_LAYOUT_SIZES: Record<
  (typeof PPTX_LAYOUTS)[number],
  { heightIn: number; widthIn: number }
> = {
  "16x9": { widthIn: 10, heightIn: 5.625 },
  "16x10": { widthIn: 10, heightIn: 6.25 },
  "4x3": { widthIn: 10, heightIn: 7.5 },
  wide: { widthIn: 13.333, heightIn: 7.5 },
  custom: { widthIn: 10, heightIn: 5.625 },
};

const colorSchema = z
  .string()
  .regex(
    /^#?[0-9a-fA-F]{6}$/,
    "must be a hex color like #RRGGBB or RRGGBB",
  )
  .transform((value) => value.replace(/^#/, "").toUpperCase());

const fontSchema = z.object({
  family: z.string().min(1),
  sizePt: z.number().positive(),
  color: colorSchema,
  bold: z.boolean(),
  italic: z.boolean(),
  underline: z.boolean(),
});

/**
 * Full, validated pptx formatting spec. Every field is required after
 * `parsePptxSpec` has merged the user input onto `defaultPptxSpec`, so the
 * writer can rely on the whole shape being present. Positions/sizes are in
 * inches; font sizes are in points.
 */
export const pptxSpecSchema = z.object({
  presentation: z.object({
    layout: z.enum(PPTX_LAYOUTS),
    /** Slide width for `layout: custom` (inches). */
    widthIn: z.number().positive(),
    /** Slide height for `layout: custom` (inches). */
    heightIn: z.number().positive(),
    /** Deck title; defaults to the file name. */
    title: z.string().optional(),
    author: z.string().optional(),
    company: z.string().optional(),
    subject: z.string().optional(),
    rtlMode: z.boolean(),
  }),
  theme: z.object({
    /** Heading font face used by the theme. */
    headFontFace: z.string().min(1),
    /** Body font face used by the theme. */
    bodyFontFace: z.string().min(1),
  }),
  background: z.object({
    color: colorSchema,
    /** Optional full-slide background image (workspace path or data URI). */
    image: z.string().min(1).optional(),
  }),
  /** Optional title/cover slide generated before the content slides. */
  cover: z.object({
    enabled: z.boolean(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
  }),
  /** Slide heading text box. */
  title: z.object({
    font: fontSchema,
    align: z.enum(PPTX_ALIGNMENTS),
    xIn: z.number(),
    yIn: z.number(),
    wIn: z.number().positive(),
    hIn: z.number().positive(),
    /** Optional title box fill / outline. */
    fill: colorSchema.optional(),
    lineColor: colorSchema.optional(),
  }),
  /** Body content text box and default body text style. */
  body: z.object({
    font: fontSchema,
    align: z.enum(PPTX_ALIGNMENTS),
    valign: z.enum(PPTX_VERTICAL_ALIGNMENTS),
    xIn: z.number(),
    yIn: z.number(),
    wIn: z.number().positive(),
    hIn: z.number().positive(),
    /** Line spacing multiple (1 = single). */
    lineSpacing: z.number().positive(),
    paraSpaceAfterPt: z.number().min(0),
    bullet: z.object({
      enabled: z.boolean(),
      color: colorSchema,
      /** Bullet glyph, for example "•". */
      character: z.string().min(1),
    }),
    /** Shrink body text automatically on dense slides. */
    autoFit: z.boolean(),
    minFontSizePt: z.number().positive(),
  }),
  /** Headings rendered inside the body text box. */
  heading: z.object({
    sizePt: z.number().positive(),
    color: colorSchema,
    bold: z.boolean(),
    spaceBeforePt: z.number().min(0),
  }),
  code: z.object({
    fontFamily: z.string().min(1),
    sizePt: z.number().positive(),
    color: colorSchema,
    fill: colorSchema.optional(),
  }),
  table: z.object({
    font: fontSchema,
    headerFill: colorSchema,
    headerColor: colorSchema,
    headerBold: z.boolean(),
    stripeFill: colorSchema.optional(),
    borderColor: colorSchema,
    borderPt: z.number().positive(),
    align: z.enum(PPTX_ALIGNMENTS),
    xIn: z.number(),
    yIn: z.number(),
    wIn: z.number().positive(),
    rowHeightIn: z.number().positive(),
    autoPage: z.boolean(),
  }),
  footer: z.object({
    text: z.string(),
    color: colorSchema,
    sizePt: z.number().positive(),
    align: z.enum(PPTX_ALIGNMENTS),
  }),
  slideNumber: z.object({
    show: z.boolean(),
    color: colorSchema,
    sizePt: z.number().positive(),
    align: z.enum(PPTX_ALIGNMENTS),
  }),
  images: z.object({
    defaultWidthIn: z.number().positive(),
    maxHeightIn: z.number().positive(),
  }),
});

export type PptxSpec = z.infer<typeof pptxSpecSchema>;
export type PptxFont = z.infer<typeof fontSchema>;

const WHITE = "FFFFFF";

function defaultFont(overrides: Partial<PptxFont>): PptxFont {
  return {
    family: "Calibri",
    sizePt: 18,
    color: "333333",
    bold: false,
    italic: false,
    underline: false,
    ...overrides,
  };
}

export function defaultPptxSpec(): PptxSpec {
  return {
    presentation: {
      layout: "16x9",
      widthIn: PPTX_LAYOUT_SIZES["16x9"].widthIn,
      heightIn: PPTX_LAYOUT_SIZES["16x9"].heightIn,
      rtlMode: false,
    },
    theme: {
      headFontFace: "Calibri Light",
      bodyFontFace: "Calibri",
    },
    background: {
      color: WHITE,
    },
    cover: {
      enabled: false,
    },
    title: {
      font: defaultFont({
        family: "Calibri Light",
        sizePt: 28,
        color: "1A1A1A",
        bold: true,
      }),
      align: "left",
      xIn: 0.5,
      yIn: 0.3,
      wIn: 9,
      hIn: 0.9,
    },
    body: {
      font: defaultFont({}),
      align: "left",
      valign: "top",
      xIn: 0.6,
      yIn: 1.35,
      wIn: 8.8,
      hIn: 4,
      lineSpacing: 1,
      paraSpaceAfterPt: 6,
      bullet: {
        enabled: true,
        color: "333333",
        character: "•",
      },
      autoFit: true,
      minFontSizePt: 10,
    },
    heading: {
      sizePt: 20,
      color: "1A1A1A",
      bold: true,
      spaceBeforePt: 8,
    },
    code: {
      fontFamily: "Courier New",
      sizePt: 12,
      color: "1F1F1F",
      fill: "F2F2F2",
    },
    table: {
      font: defaultFont({ sizePt: 12 }),
      headerFill: "E8E8E8",
      headerColor: "1A1A1A",
      headerBold: true,
      borderColor: "BFBFBF",
      borderPt: 0.5,
      align: "left",
      xIn: 0.5,
      yIn: 1.3,
      wIn: 9,
      rowHeightIn: 0.3,
      autoPage: true,
    },
    footer: {
      text: "",
      color: "808080",
      sizePt: 10,
      align: "left",
    },
    slideNumber: {
      show: false,
      color: "808080",
      sizePt: 10,
      align: "right",
    },
    images: {
      defaultWidthIn: 5,
      maxHeightIn: 4,
    },
  };
}

/**
 * Merge a (possibly partial) user pptx spec onto the defaults and validate it.
 * Throws a clear error when the input does not match the documented shape, so
 * invalid specs never silently produce a default-looking deck.
 */
export function parsePptxSpec(input: unknown): PptxSpec {
  const candidate = deepMerge(defaultPptxSpec(), input);

  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new Error("Invalid pptx spec: expected an object.");
  }

  const result = pptxSpecSchema.safeParse(candidate);

  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") ?? "value";
    const message = issue?.message ?? "does not match the documented spec";
    throw new Error(
      `Invalid pptx spec at ${path || "root"}: ${message}. Use createFile/updateDocument with a spec object or YAML front-matter 'format:' block.`,
    );
  }

  return result.data;
}

/** Resolve the effective slide dimensions for a spec (inches). */
export function pptxSlideSize(spec: PptxSpec): {
  heightIn: number;
  widthIn: number;
} {
  if (spec.presentation.layout === "custom") {
    return {
      widthIn: spec.presentation.widthIn,
      heightIn: spec.presentation.heightIn,
    };
  }

  return PPTX_LAYOUT_SIZES[spec.presentation.layout];
}
