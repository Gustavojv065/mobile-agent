import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

import {
  parsePptxSpec,
  PPTX_LAYOUT_SIZES,
  type PptxSpec,
} from "@/modules/documents/spec/pptx-spec";

/**
 * Approximate style snapshot for imported `.pptx` files. Reads the OOXML
 * package and maps the original look (slide layout, theme fonts and the first
 * placeholders' title/body font size, colour and boldness) onto the validated
 * `PptxSpec`, so later updates keep the deck recognisably similar.
 *
 * Fidelity notes: this is deliberately approximate. Only literal RGB colours
 * are captured (theme/scheme colours are skipped), per-shape styling collapses
 * to a single title/body pair, and bullets, table styles, backgrounds,
 * footers and slide numbers are not extracted — those keep the spec defaults.
 */

type XmlNode =
  | string
  | number
  | null
  | undefined
  | XmlNode[]
  | { [key: string]: XmlNode };

type RunStyle = { bold: boolean; color?: string; sizePt: number };
type ShapeInfo = { isTitle: boolean; runs: RunStyle[] };

const EMU_PER_INCH = 914400;

function makeParser(): XMLParser {
  return new XMLParser({
    attributeNamePrefix: "@_",
    ignoreAttributes: false,
    isArray: (name) => name === "sp" || name === "pic" || name === "sldSz",
    parseAttributeValue: false,
    parseTagValue: false,
    removeNSPrefix: true,
  });
}

function decodeEntry(
  zip: Record<string, Uint8Array>,
  path: string,
): string | null {
  const bytes = zip[path];

  if (!bytes) {
    return null;
  }

  return new TextDecoder().decode(bytes);
}

function slidePaths(zip: Record<string, Uint8Array>): string[] {
  return Object.keys(zip)
    .filter((key) => /^ppt\/slides\/slide\d+\.xml$/.test(key))
    .sort((a, b) => {
      const aIndex = Number.parseInt(a.match(/slide(\d+)\.xml$/)![1]!, 10);
      const bIndex = Number.parseInt(b.match(/slide(\d+)\.xml$/)![1]!, 10);
      return aIndex - bIndex;
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

/** Find the first object anywhere in the tree with the given key. */
function findNode(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findNode(item, key);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  if (!node || typeof node !== "object") {
    return undefined;
  }

  const object = node as Record<string, unknown>;

  if (key in object) {
    return object[key];
  }

  for (const value of Object.values(object)) {
    const found = findNode(value, key);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function fontSchemeTypeface(
  themeXml: string | null,
  kind: "majorFont" | "minorFont",
): string | undefined {
  if (!themeXml) {
    return undefined;
  }

  const parsed = makeParser().parse(themeXml);
  const scheme = findNode(parsed, "fontScheme");
  const node = asObject(scheme as XmlNode);
  const kindNode = asObject((node?.[kind] as XmlNode) ?? undefined);
  const latin = asObject((kindNode?.latin as XmlNode) ?? undefined);

  return attr(latin, "typeface") || undefined;
}

function presentationSize(
  presentationXml: string | null,
): { heightIn?: number; widthIn?: number } {
  if (!presentationXml) {
    return {};
  }

  const parsed = makeParser().parse(presentationXml);
  const sizeNode = findNode(parsed, "sldSz");
  const size = asObject(
    (Array.isArray(sizeNode) ? sizeNode[0] : sizeNode) as XmlNode,
  );

  if (!size) {
    return {};
  }

  const cx = positiveNumber(attr(size, "cx"));
  const cy = positiveNumber(attr(size, "cy"));

  if (cx === undefined || cy === undefined) {
    return {};
  }

  return {
    widthIn: cx / EMU_PER_INCH,
    heightIn: cy / EMU_PER_INCH,
  };
}

function placeholderIsTitle(shape: unknown): boolean {
  const nvPr = findNode(shape, "nvPr");
  const placeholders = (() => {
    const object = asObject(nvPr as XmlNode);

    if (!object) {
      return [];
    }

    const ph = object.ph;

    if (ph === undefined) {
      return [];
    }

    return Array.isArray(ph) ? ph : [ph];
  })();

  for (const ph of placeholders) {
    const type = attr(ph, "type");

    if (type === "title" || type === "ctrTitle") {
      return true;
    }

    if (attr(ph, "idx") === "0") {
      return true;
    }
  }

  return false;
}

function solidFillColor(node: unknown): string | undefined {
  const solidFill = findNode(node, "solidFill");
  const srgbClr = findNode(solidFill, "srgbClr");

  return hexColor(attr(srgbClr, "val"));
}

function collectRuns(node: unknown, runs: RunStyle[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRuns(item, runs);
    }

    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  const object = node as Record<string, unknown>;
  const sizeHundredths = positiveNumber(attr(object, "sz"));

  if (sizeHundredths !== undefined) {
    runs.push({
      sizePt: sizeHundredths / 100,
      bold: attr(object, "b") === "1",
      color: solidFillColor(object),
    });

    return;
  }

  for (const value of Object.values(object)) {
    collectRuns(value, runs);
  }
}

function collectShapes(node: unknown, shapes: ShapeInfo[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectShapes(item, shapes);
    }

    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  const object = node as Record<string, unknown>;

  for (const [key, value] of Object.entries(object)) {
    if (key === "sp" || key === "pic") {
      const items = Array.isArray(value) ? value : [value];

      for (const item of items) {
        if (!item || typeof item !== "object") {
          continue;
        }

        const runs: RunStyle[] = [];
        collectRuns(item, runs);

        if (runs.length > 0) {
          shapes.push({ isTitle: placeholderIsTitle(item), runs });
        }
      }

      continue;
    }

    collectShapes(value, shapes);
  }
}

function modeOf(values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;

  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }

  return best;
}

function modeOfNumbers(values: number[]): number | undefined {
  const rounded = values.map((value) => Math.round(value * 10) / 10);
  const uniques = [...new Set(rounded)].sort((a, b) => a - b);
  let best:
    | { count: number; value: number }
    | undefined;

  for (const value of uniques) {
    const count = rounded.filter((candidate) => candidate === value).length;

    if (!best || count > best.count) {
      best = { count, value };
    }
  }

  return best?.value;
}

function aggregateFont(runs: RunStyle[]): Record<string, unknown> | null {
  if (runs.length === 0) {
    return null;
  }

  const sizePt = modeOfNumbers(runs.map((run) => run.sizePt)) ?? runs[0]!.sizePt;
  const colors = runs
    .map((run) => run.color)
    .filter((color): color is string => Boolean(color));
  const font: Record<string, unknown> = { sizePt };

  const color = modeOf(colors);

  if (color) {
    font.color = color;
  }

  font.bold = runs.filter((run) => run.bold).length >= Math.ceil(runs.length / 2);

  return font;
}

function splitTitleBody(shapes: ShapeInfo[]): {
  bodyRuns: RunStyle[];
  titleRuns: RunStyle[];
} {
  const titleRuns = shapes
    .filter((shape) => shape.isTitle)
    .flatMap((shape) => shape.runs);
  const bodyRuns = shapes
    .filter((shape) => !shape.isTitle)
    .flatMap((shape) => shape.runs);

  if (titleRuns.length > 0) {
    return { bodyRuns, titleRuns };
  }

  // No placeholders (e.g. generated decks): the biggest run is the slide title.
  const all = [...bodyRuns];

  if (all.length === 0) {
    return { bodyRuns: all, titleRuns: [] };
  }

  let maxIndex = 0;

  for (let index = 1; index < all.length; index += 1) {
    if (all[index]!.sizePt > all[maxIndex]!.sizePt) {
      maxIndex = index;
    }
  }

  return {
    titleRuns: [all[maxIndex]!],
    bodyRuns: all.filter((_run, index) => index !== maxIndex),
  };
}

function layoutFor(widthIn: number, heightIn: number): {
  heightIn?: number;
  layout: string;
  widthIn?: number;
} {
  for (const [name, size] of Object.entries(PPTX_LAYOUT_SIZES)) {
    if (
      Math.abs(size.widthIn - widthIn) < 0.05 &&
      Math.abs(size.heightIn - heightIn) < 0.05
    ) {
      return { layout: name };
    }
  }

  return {
    layout: "custom",
    widthIn: Math.round(widthIn * 100) / 100,
    heightIn: Math.round(heightIn * 100) / 100,
  };
}

/**
 * Build an approximate `PptxSpec` from an imported presentation, or null when
 * the bytes are not a readable pptx package.
 */
export async function snapshotPptxSpec(
  bytes: Uint8Array,
): Promise<PptxSpec | null> {
  let zip: Record<string, Uint8Array>;

  try {
    zip = unzipSync(bytes);
  } catch {
    return null;
  }

  const themeMajor = fontSchemeTypeface(
    decodeEntry(zip, "ppt/theme/theme1.xml"),
    "majorFont",
  );
  const themeMinor = fontSchemeTypeface(
    decodeEntry(zip, "ppt/theme/theme1.xml"),
    "minorFont",
  );
  const size = presentationSize(decodeEntry(zip, "ppt/presentation.xml"));

  const shapes: ShapeInfo[] = [];

  for (const path of slidePaths(zip).slice(0, 50)) {
    const xml = decodeEntry(zip, path);

    if (xml) {
      collectShapes(makeParser().parse(xml), shapes);
    }
  }

  const partial: Record<string, unknown> = {};

  if (size.widthIn !== undefined && size.heightIn !== undefined) {
    partial.presentation = layoutFor(size.widthIn, size.heightIn);
  }

  const themePartial: Record<string, unknown> = {};

  if (themeMajor) {
    themePartial.headFontFace = themeMajor;
  }

  if (themeMinor) {
    themePartial.bodyFontFace = themeMinor;
  }

  if (Object.keys(themePartial).length > 0) {
    partial.theme = themePartial;
  }

  const { bodyRuns, titleRuns } = splitTitleBody(shapes);
  const titleFont = aggregateFont(titleRuns);

  if (titleFont) {
    partial.title = { font: titleFont };
  }

  const bodyFont = aggregateFont(bodyRuns);

  if (bodyFont) {
    partial.body = { font: bodyFont };
  }

  // Any deck is at least as snapshottable as its defaults; `null` is reserved
  // for unreadable packages.
  return parsePptxSpec(partial);
}