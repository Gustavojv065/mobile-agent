import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

import {
  DOCX_PAGE_SIZE_TWIPS,
  parseDocxSpec,
  type DocxSpec,
} from "@/modules/documents/spec/docx-spec";

/**
 * Style snapshot for imported `.docx` files. Reads the OOXML package and maps
 * the original formatting (default fonts/sizes/colors, page size/margins,
 * per-level heading styles, mono code font, header/footer text with page
 * numbers, TOC presence) onto the validated `DocxSpec`. Values that cannot be
 * extracted reliably are left to the spec defaults, so the snapshot always
 * yields a complete, valid spec. High fidelity for text/layout; tables use
 * defaults (approximate).
 */

type XmlNode =
  | string
  | number
  | null
  | undefined
  | XmlNode[]
  | { [key: string]: XmlNode };

function asObject(node: XmlNode | undefined): Record<string, unknown> | null {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    return node as Record<string, unknown>;
  }

  return null;
}

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function makeParser(): XMLParser {
  return new XMLParser({
    attributeNamePrefix: "@_",
    ignoreAttributes: false,
    isArray: (name) => name === "style" || name === "sectPr",
    parseAttributeValue: false,
    parseTagValue: false,
    removeNSPrefix: true,
  });
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

  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());

  return match ? match[1]!.toUpperCase() : undefined;
}

function sizePtFromHalfPoints(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const halfPoints = Number.parseFloat(value);

  if (!Number.isFinite(halfPoints) || halfPoints <= 0) {
    return undefined;
  }

  return halfPoints / 2;
}

function pointsFromTwips(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const twipsValue = Number.parseFloat(value);

  if (!Number.isFinite(twipsValue)) {
    return undefined;
  }

  return Math.round((twipsValue / 20) * 10) / 10;
}

function fromBool(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "on" || normalized === "true" || normalized === "1") {
    return true;
  }

  if (normalized === "off" || normalized === "false" || normalized === "0") {
    return false;
  }

  return undefined;
}

const MONO_FAMILIES = new Set([
  "andale mono",
  "consolas",
  "courier",
  "courier new",
  "dejavu sans mono",
  "liberation mono",
  "menlo",
  "monaco",
  "monospace",
  "sf mono",
]);

type RunProperties = {
  bold?: boolean;
  color?: string;
  family?: string;
  italic?: boolean;
  sizePt?: number;
};

function readRunProperties(rPr: unknown): RunProperties {
  const object = asObject(rPr as XmlNode);

  if (!object) {
    return {};
  }

  const rFonts = asObject(object.rFonts as XmlNode);
  const family =
    attr(rFonts, "ascii") ?? attr(rFonts, "hAnsi") ?? attr(rFonts, "cs");
  const sizePt = sizePtFromHalfPoints(attr(object.sz, "val"));
  const color = hexColor(attr(object.color, "val"));
  const bold = fromBool(attr(object.b, "val"));
  const italic = fromBool(attr(object.i, "val"));

  return { bold, color, family, italic, sizePt };
}

function extractFieldAndText(xml: string): string {
  const parts: string[] = [];
  const tokenPattern =
    /<w:fldChar[^>]*w:fldCharType="(begin|separate|end)"[^>]*\/>|<w:instrText[^>]*>([^<]*)<\/w:instrText>|<w:t[^>]*>([^<]*)<\/w:t>/g;
  let inPageField = false;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(xml)) !== null) {
    const [, fieldType, instrText, text] = match;

    if (fieldType !== undefined) {
      if (fieldType === "end") {
        inPageField = false;
      }
    } else if (instrText !== undefined) {
      if (/\bPAGE\b/.test(instrText.trim())) {
        parts.push("{PAGE}");
        inPageField = true;
      }
    } else if (text !== undefined && !inPageField) {
      parts.push(text);
    }
  }

  return parts.join("").replace(/\s+/g, " ").trim();
}

function hasTocField(documentXml: string): boolean {
  const instrPattern = /<w:instrText[^>]*>([^<]*)<\/w:instrText>/g;
  let match: RegExpExecArray | null;

  while ((match = instrPattern.exec(documentXml)) !== null) {
    if (/\bTOC\b/i.test(match[1] ?? "")) {
      return true;
    }
  }

  return false;
}

function snapshotPage(
  documentXml: string,
  partial: Record<string, unknown>,
): void {
  const lastStart = documentXml.lastIndexOf("<w:sectPr");

  if (lastStart < 0) {
    return;
  }

  const closeTag = "</w:sectPr>";
  const lastEnd = documentXml.indexOf(closeTag, lastStart);

  if (lastEnd < 0) {
    return;
  }

  let section: XmlNode;

  try {
    section = makeParser().parse(
      documentXml.slice(lastStart, lastEnd + closeTag.length),
    );
  } catch {
    return;
  }

  const rawSectPr = (section as { sectPr?: XmlNode }).sectPr;
  const sectPr = asObject(normalizeArray(rawSectPr)[0]);

  if (!sectPr) {
    return;
  }

  const page: Record<string, unknown> = {};

  const pgSz = asObject(sectPr.pgSz as XmlNode);

  if (pgSz) {
    const width = Number.parseInt(attr(pgSz, "w") ?? "", 10);
    const height = Number.parseInt(attr(pgSz, "h") ?? "", 10);

    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      for (const [name, dimensions] of Object.entries(DOCX_PAGE_SIZE_TWIPS)) {
        if (width === dimensions.width && height === dimensions.height) {
          page.size = name;
          page.orientation = "portrait";
          break;
        }

        if (width === dimensions.height && height === dimensions.width) {
          page.size = name;
          page.orientation = "landscape";
          break;
        }
      }
    }
  }

  const pgMar = asObject(sectPr.pgMar as XmlNode);

  if (pgMar) {
    const top = pointsFromTwips(attr(pgMar, "top"));
    const right = pointsFromTwips(attr(pgMar, "right"));
    const bottom = pointsFromTwips(attr(pgMar, "bottom"));
    const left = pointsFromTwips(attr(pgMar, "left"));

    if (top !== undefined) {
      page.marginTopPt = top;
    }

    if (right !== undefined) {
      page.marginRightPt = right;
    }

    if (bottom !== undefined) {
      page.marginBottomPt = bottom;
    }

    if (left !== undefined) {
      page.marginLeftPt = left;
    }
  }

  if (Object.keys(page).length > 0) {
    partial.page = page;
  }
}

function snapshotParagraphDefaults(
  stylesTree: XmlNode,
  partial: Record<string, unknown>,
): void {
  const styles = asObject(stylesTree);

  if (!styles) {
    return;
  }

  const docDefaults = asObject(styles.docDefaults as XmlNode);
  const pPr = asObject(
    asObject(docDefaults?.pPrDefault as XmlNode)?.pPr as XmlNode,
  );

  if (!pPr) {
    return;
  }

  const paragraphs: Record<string, unknown> = {};

  const spacing = asObject(pPr.spacing as XmlNode);

  if (spacing) {
    const afterPt = pointsFromTwips(attr(spacing, "after"));
    const lineRaw = attr(spacing, "line");
    const lineRule = attr(spacing, "lineRule")?.toLowerCase();

    if (afterPt !== undefined) {
      paragraphs.spacingAfterPt = afterPt;
    }

    if (
      lineRaw !== undefined &&
      (lineRule === undefined || lineRule === "auto")
    ) {
      const line = Number.parseFloat(lineRaw);

      if (Number.isFinite(line) && line > 0) {
        const factor = Math.round((line / 240) * 100) / 100;

        if (factor >= 1 && factor <= 3) {
          paragraphs.lineSpacing = factor;
        }
      }
    }
  }

  const jc = attr(pPr.jc, "val")?.toLowerCase();

  if (jc === "left" || jc === "center" || jc === "right" || jc === "both") {
    paragraphs.alignment = jc === "both" ? "justified" : jc;
  }

  if (Object.keys(paragraphs).length > 0) {
    partial.paragraphs = paragraphs;
  }
}

function snapshotFontsAndHeadings(
  stylesTree: XmlNode,
  partial: Record<string, unknown>,
): void {
  const styles = asObject(stylesTree);

  if (!styles) {
    return;
  }

  const docDefaults = asObject(styles.docDefaults as XmlNode);
  const defaultRun = readRunProperties(
    asObject(docDefaults?.rPrDefault as XmlNode)?.rPr,
  );

  const fonts: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  let normalRun: RunProperties = {};

  const styleNodes = normalizeArray(styles.style as XmlNode);

  // Normal style.
  const normal = styleNodes.find(
    (style) =>
      attr(style, "styleId")?.toLowerCase() === "normal" ||
      attr(style, "styleId")?.toLowerCase() === "a",
  );

  if (normal) {
    normalRun = readRunProperties(
      asObject(normal as XmlNode)?.rPr,
    );
  }

  const bodyRun: RunProperties = {
    bold: defaultRun.bold ?? normalRun.bold,
    color: (defaultRun.color ?? normalRun.color) || undefined,
    family: defaultRun.family ?? normalRun.family,
    italic: defaultRun.italic ?? normalRun.italic,
    sizePt: defaultRun.sizePt ?? normalRun.sizePt,
  };

  if (bodyRun.family) {
    body.family = bodyRun.family;
  }

  if (bodyRun.sizePt !== undefined) {
    body.sizePt = bodyRun.sizePt;
  }

  if (bodyRun.color) {
    body.color = bodyRun.color;
  }

  if (bodyRun.bold !== undefined) {
    body.bold = bodyRun.bold;
  }

  if (bodyRun.italic !== undefined) {
    body.italic = bodyRun.italic;
  }

  if (Object.keys(body).length > 0) {
    fonts.body = body;
  }

  const headingStyles: Record<string, unknown> = {};
  let headingsFamily: string | undefined;

  for (let level = 1; level <= 6; level += 1) {
    const style = styleNodes.find((candidate) => {
      const object = asObject(candidate as XmlNode);

      if (!object) {
        return false;
      }

      const id = String(attr(candidate, "styleId") ?? "").toLowerCase();
      const name = String(attr(candidate, "name") ?? "").toLowerCase();

      return (
        id === `heading${level}` ||
        id === `heading${level}char` ||
        name === `heading ${level}` ||
        name === `heading${level}`
      );
    });

    if (!style) {
      continue;
    }

    const run = readRunProperties(asObject(style as XmlNode)?.rPr);
    const pPr = asObject(asObject(style as XmlNode)?.pPr as XmlNode);
    const spacing = asObject(pPr?.spacing as XmlNode);
    const override: Record<string, unknown> = {};
    let hasValue = false;

    if (run.sizePt !== undefined) {
      override.sizePt = run.sizePt;
      hasValue = true;
    }

    if (run.color) {
      override.color = run.color;
      hasValue = true;
    }

    if (run.bold !== undefined) {
      override.bold = run.bold;
      hasValue = true;
    }

    if (run.family) {
      override.family = run.family;
      hasValue = true;
    }

    if (spacing) {
      const before = pointsFromTwips(attr(spacing, "before"));
      const after = pointsFromTwips(attr(spacing, "after"));

      if (before !== undefined) {
        override.spacingBeforePt = before;
        hasValue = true;
      }

      if (after !== undefined) {
        override.spacingAfterPt = after;
        hasValue = true;
      }
    }

    if (hasValue) {
      headingStyles[String(level)] = override;
    }

    if (run.family && !headingsFamily) {
      headingsFamily = run.family;
    }
  }

  if (Object.keys(headingStyles).length > 0) {
    partial.headingStyles = headingStyles;
  }

  if (headingsFamily) {
    fonts.headings = { family: headingsFamily };
  }

  // Code font: first monospace family found in any style's run properties.
  for (const style of styleNodes) {
    const run = readRunProperties(asObject(style as XmlNode)?.rPr);

    if (run.family && MONO_FAMILIES.has(run.family.toLowerCase())) {
      const code: Record<string, unknown> = { family: run.family };

      if (run.sizePt !== undefined) {
        code.sizePt = run.sizePt;
      }

      if (run.color) {
        code.color = run.color;
      }

      fonts.code = code;
      break;
    }
  }

  if (Object.keys(fonts).length > 0) {
    partial.fonts = fonts;
  }
}

/**
 * Extract a validated `DocxSpec` from an existing `.docx` file, or null when
 * the bytes are not a readable docx package. Used on import so later updates
 * of an imported document keep its original look.
 */
export async function snapshotDocxSpec(bytes: Uint8Array): Promise<DocxSpec | null> {
  let zip: Record<string, Uint8Array>;

  try {
    zip = unzipSync(bytes);
  } catch {
    return null;
  }

  const decode = (path: string): string | null => {
    const entry = zip[path];

    return entry ? new TextDecoder().decode(entry) : null;
  };

  const stylesXml = decode("word/styles.xml");
  const documentXml = decode("word/document.xml");

  if (stylesXml === null && documentXml === null) {
    return null;
  }

  const partial: Record<string, unknown> = {};

  if (stylesXml !== null) {
    let stylesTree: XmlNode;

    try {
      stylesTree = makeParser().parse(stylesXml) as XmlNode;
    } catch {
      stylesTree = {};
    }

    const stylesInner = asObject(stylesTree)?.styles;

    if (stylesInner !== undefined) {
      snapshotFontsAndHeadings(stylesInner as XmlNode, partial);
      snapshotParagraphDefaults(stylesInner as XmlNode, partial);
    }
  }

  if (documentXml !== null) {
    snapshotPage(documentXml, partial);

    if (hasTocField(documentXml)) {
      partial.includeToc = true;
    }
  }

  const headerXml = decode("word/header1.xml");
  const footerXml = decode("word/footer1.xml");

  if (headerXml !== null) {
    const text = extractFieldAndText(headerXml);

    if (text.length > 0) {
      partial.header = { text };
    }
  }

  if (footerXml !== null) {
    const text = extractFieldAndText(footerXml);

    if (text.length > 0) {
      partial.footer = { text };
    }
  }

  return parseDocxSpec(partial);
}