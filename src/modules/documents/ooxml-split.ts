/**
 * Lossless split of imported (source-less) pptx and xlsx packages by slides and
 * sheets. The enumerated list in the main part (`ppt/presentation.xml`'s slide
 * list or `xl/workbook.xml`'s `sheets`) is pruned with a namespace-aware DOM
 * edit — matching tags by local name so any producer prefix works and
 * attribute text (sheet names may legally contain `>`) cannot corrupt the
 * parse. Every other package entry is copied byte-for-byte, so the selected
 * slides/sheets keep their exact styling, media and layouts. Unselected parts
 * stay in the package but are not listed, which OOXML consumers ignore.
 */

import { strToU8, unzipSync, zipSync } from "fflate";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

import { parseIndexRanges } from "@/modules/documents/ranges";

export type OoxmlSplitResult = {
  /** Total slides/sheets in the source package. */
  unitCount: number;
  /** Human-readable name for each unit (slide title / sheet name). */
  unitNames: string[];
  /** One zipped package per requested range. */
  parts: Uint8Array[];
};

type PackageParts = Record<string, Uint8Array>;
type IndexRange = { start: number; end: number };
type XmlObject = Record<string, unknown>;

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Local tag name, ignoring any namespace prefix. */
function localName(name: string): string {
  const separator = name.lastIndexOf(":");

  return separator >= 0 ? name.slice(separator + 1) : name;
}

/** Local attribute name, ignoring the parser prefix and namespace prefix. */
function attrLocal(key: string): string {
  const bare = key.startsWith("@_") ? key.slice(2) : key;

  return localName(bare);
}

/**
 * Tags that repeat inside the lists we edit. Forcing arrays keeps single-item
 * lists (one slide, one sheet, one section) addressable the same way.
 */
const REPEATED_TAGS = new Set(["sldId", "sheet", "section"]);

function makePackageParser(): XMLParser {
  return new XMLParser({
    attributeNamePrefix: "@_",
    ignoreAttributes: false,
    isArray: (name) => REPEATED_TAGS.has(localName(name)),
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
  });
}

function makePackageBuilder(): XMLBuilder {
  return new XMLBuilder({
    attributeNamePrefix: "@_",
    ignoreAttributes: false,
    suppressEmptyNode: true,
    format: false,
  });
}

function asObject(value: unknown): XmlObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as XmlObject)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Direct child keyed by local tag name, regardless of namespace prefix. */
function childKey(node: XmlObject, local: string): string | undefined {
  return Object.keys(node).find((key) => localName(key) === local);
}

function indicesFor(range: IndexRange): number[] {
  const indices: number[] = [];

  for (let index = range.start; index <= range.end; index += 1) {
    indices.push(index);
  }

  return indices;
}

function buildRanges(spec: string, unitCount: number, label: string): IndexRange[] {
  if (spec.trim().toLowerCase() === "each") {
    return Array.from({ length: unitCount }, (_value, index) => ({
      start: index,
      end: index,
    }));
  }

  return parseIndexRanges(spec, unitCount, label, { zeroBased: true });
}

function readPackage(bytes: Uint8Array, label: string): PackageParts {
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error(`The file is not a readable ${label} package.`);
  }
}

/**
 * Numeric slide id (`id`) and slide relationship id (`r:id`, any prefix).
 * The two share the local name `id`; the relationship id is the prefixed one.
 */
function slideIds(entry: unknown): { id?: string; relId?: string } {
  const node = asObject(entry);
  const result: { id?: string; relId?: string } = {};

  if (!node) {
    return result;
  }

  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith("@_") || typeof value !== "string") {
      continue;
    }

    if (attrLocal(key) !== "id") {
      continue;
    }

    if (key.includes(":")) {
      result.relId = value;
    } else {
      result.id = value;
    }  }

  return result;
}

function attributeByLocalName(entry: unknown, local: string): string | undefined {
  const node = asObject(entry);

  if (!node) {
    return undefined;
  }

  for (const [key, value] of Object.entries(node)) {
    if (
      key.startsWith("@_") &&
      attrLocal(key) === local &&
      typeof value === "string"
    ) {
      return value;
    }
  }

  return undefined;
}

/** Locate the editable list inside a parsed main part, or null. */
function findListItems(
  doc: unknown,
  rootLocal: string,
  listLocal: string,
  itemLocal: string,
): { rootKey: string; root: XmlObject; listKey: string; items: unknown[] } | null {
  const top = asObject(doc);

  if (!top) {
    return null;
  }

  const rootKey = childKey(top, rootLocal);
  const root = rootKey ? asObject(top[rootKey]) : null;

  if (!rootKey || !root) {
    return null;
  }

  const listKey = childKey(root, listLocal);
  const list = listKey ? asObject(root[listKey]) : null;

  if (!listKey || !list) {
    return null;
  }

  const itemKey = childKey(list, itemLocal);

  if (!itemKey) {
    return null;
  }

  return { rootKey, root, listKey, items: asArray(list[itemKey]) };
}

function missingListError(label: string): Error {
  return new Error(`The document does not contain a ${label} list to split.`);
}

/**
 * Replace the entries inside the wrapper list with the selected subset,
 * returning one rebuilt XML string per range. Each rebuild is re-parsed and
 * its list length asserted, so a serializer fault fails loudly here instead
 * of shipping a corrupt package.
 */
function pruneList(input: {
  xml: string;
  rootLocal: string;
  listLocal: string;
  itemLocal: string;
  spec: string;
  label: string;
  describe: (entry: unknown, index: number) => string;
  adjust?: (root: XmlObject, kept: unknown[]) => void;
}): {
  parts: { indices: number[]; xml: string }[];
  unitCount: number;
  unitNames: string[];
} {
  const parser = makePackageParser();
  const builder = makePackageBuilder();

  let doc: unknown;

  try {
    doc = parser.parse(input.xml);
  } catch {
    throw missingListError(input.label);
  }

  const found = findListItems(doc, input.rootLocal, input.listLocal, input.itemLocal);

  if (!found || found.items.length === 0) {
    if (!found) {
      throw missingListError(input.label);
    }

    throw new Error(`The document has no ${input.label}s to split.`);
  }

  const { items } = found;
  const unitNames = items.map((entry, index) => input.describe(entry, index));
  const ranges = buildRanges(input.spec, items.length, input.label);

  const parts = ranges.map((range) => {
    const indices = indicesFor(range);
    const kept = indices.map((index) => items[index]!);

    const listKey = childKey(found.root, input.listLocal)!;
    const list = asObject(found.root[listKey])!;
    const itemKey = childKey(list, input.itemLocal)!;
    const nextRoot: XmlObject = {
      ...found.root,
      [listKey]: { ...list, [itemKey]: kept },
    };

    input.adjust?.(nextRoot, kept);

    const xml = builder.build({ ...(asObject(doc) ?? {}), [found.rootKey]: nextRoot });

    assertRebuiltList(xml, input, kept.length);

    return { indices, xml };
  });

  return { parts, unitCount: items.length, unitNames };
}

function assertRebuiltList(
  xml: string,
  input: { rootLocal: string; listLocal: string; itemLocal: string; label: string },
  expected: number,
): void {
  let doc: unknown;

  try {
    doc = makePackageParser().parse(xml);
  } catch {
    throw new Error(
      `Failed to rebuild the ${input.label} list while splitting; the source file was left untouched.`,
    );
  }

  const found = findListItems(doc, input.rootLocal, input.listLocal, input.itemLocal);

  if (!found || found.items.length !== expected) {
    throw new Error(
      `Failed to rebuild the ${input.label} list while splitting; the source file was left untouched.`,
    );
  }
}

function firstRunText(slideXml: string): string | undefined {
  const match = /<a:t>([\s\S]*?)<\/a:t>/.exec(slideXml);
  const text = match?.[1]?.replace(/\s+/g, " ").trim();

  return text ? text : undefined;
}

function relationshipTargets(relsXml: string, baseDir: string): Map<string, string> {
  const targets = new Map<string, string>();

  for (const tag of relsXml.match(/<Relationship\b[^>]*\/>/g) ?? []) {
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];

    if (id && target) {
      targets.set(id, target.startsWith("/") ? target.slice(1) : `${baseDir}${target}`);
    }
  }

  return targets;
}

/**
 * Drop section references to slides that were split away, and sections left
 * empty. Section entries address slides by numeric id (no relationship id).
 */
function filterPresentationSections(root: XmlObject, kept: unknown[]): void {
  const keptIds = new Set<string>();

  for (const entry of kept) {
    const id = slideIds(entry).id;

    if (id !== undefined) {
      keptIds.add(id);
    }
  }

  const sectionListKey = childKey(root, "sectionLst");
  const sectionList = sectionListKey ? asObject(root[sectionListKey]) : null;

  if (!sectionListKey || !sectionList) {
    return;
  }

  const sectionKey = childKey(sectionList, "section");
  const sections = sectionKey ? asArray(sectionList[sectionKey]) : [];

  const remaining = sections
    .map((section) => {
      const node = asObject(section);

      if (!node) {
        return null;
      }

      const listKey = childKey(node, "sldIdLst");
      const list = listKey ? asObject(node[listKey]) : null;

      if (!listKey || !list) {
        return section;
      }

      const itemKey = childKey(list, "sldId");

      if (!itemKey) {
        return section;
      }

      const ids = asArray(list[itemKey]).filter((entry) =>
        keptIds.has(slideIds(entry).id ?? ""),
      );

      return { ...node, [listKey]: { ...list, [itemKey]: ids } };
    })
    .filter((section) => {
      if (!section) {
        return false;
      }

      const node = asObject(section)!;
      const listKey = childKey(node, "sldIdLst");
      const list = listKey ? asObject(node[listKey]) : null;
      const itemKey = list ? childKey(list, "sldId") : undefined;
      const ids = itemKey && list ? asArray(list[itemKey]) : null;

      // Sections without a slide list carry no slide references; keep them.
      return ids === null || ids.length > 0;
    });

  if (sectionKey) {
    root[sectionListKey] = { ...sectionList, [sectionKey]: remaining };
  }
}

/**
 * Split a pptx package by slide ranges (0-based, matching the slide order in
 * `ppt/presentation.xml`). Accepts "each" for one part per slide.
 */
export function splitPptxSlides(input: {
  bytes: Uint8Array;
  spec: string;
}): OoxmlSplitResult {
  const zip = readPackage(input.bytes, "pptx");
  const presentation = zip["ppt/presentation.xml"];

  if (!presentation) {
    throw new Error("The pptx package has no presentation part.");
  }

  const rels = decode(zip["ppt/_rels/presentation.xml.rels"] ?? new Uint8Array());
  const targets = relationshipTargets(rels, "ppt/");

  const { parts, unitCount, unitNames } = pruneList({
    xml: decode(presentation),
    rootLocal: "presentation",
    listLocal: "sldIdLst",
    itemLocal: "sldId",
    spec: input.spec,
    label: "slide",
    describe: (entry, index) => {
      const relId = slideIds(entry).relId;
      const target = relId ? targets.get(relId) : undefined;
      const slideXml = target ? zip[target] : undefined;
      const title = slideXml ? firstRunText(decode(slideXml)) : undefined;

      return title ?? `Slide ${index + 1}`;
    },
    adjust: (root, kept) => filterPresentationSections(root, kept),
  });

  return {
    unitCount,
    unitNames,
    parts: parts.map((part) =>
      zipSync({ ...zip, "ppt/presentation.xml": strToU8(part.xml) }, { level: 6 }),
    ),
  };
}

/**
 * Split an xlsx package by sheet ranges (0-based, matching the sheet order in
 * `xl/workbook.xml`). Accepts "each" for one part per sheet.
 */
export function splitXlsxSheets(input: {
  bytes: Uint8Array;
  spec: string;
}): OoxmlSplitResult {
  const zip = readPackage(input.bytes, "xlsx");
  const workbook = zip["xl/workbook.xml"];

  if (!workbook) {
    throw new Error("The xlsx package has no workbook part.");
  }

  const { parts, unitCount, unitNames } = pruneList({
    xml: decode(workbook),
    rootLocal: "workbook",
    listLocal: "sheets",
    itemLocal: "sheet",
    spec: input.spec,
    label: "sheet",
    describe: (entry, index) =>
      attributeByLocalName(entry, "name") ?? `Sheet ${index + 1}`,
  });

  return {
    unitCount,
    unitNames,
    parts: parts.map((part) =>
      zipSync({ ...zip, "xl/workbook.xml": strToU8(part.xml) }, { level: 6 }),
    ),
  };
}
