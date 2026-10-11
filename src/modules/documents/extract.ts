import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import * as XLSX from "xlsx";

import { extractPdf } from "@/modules/documents/pdf-extract";
import type { DocumentFormat } from "@/modules/documents/types";

/**
 * Structured result of reading a binary document so the agent can work with
 * its content (docx/xlsx/pptx/pdf).
 */
export type ExtractedDocument = {
  format: DocumentFormat;
  text: string;
  pageCount?: number;
  /** Per-page text for pdf previews (page 1 first). */
  pages?: string[];
  sheetNames?: string[];
  /** Structured cells per sheet, used to render spreadsheet previews. */
  sheets?: XlsxSheet[];
  slideCount?: number;
};

export type XlsxSheet = {
  name: string;
  rows: string[][];
};

type XmlNode =
  | string
  | number
  | null
  | undefined
  | XmlNode[]
  | { [key: string]: XmlNode };

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function parseXml(xml: string): XmlNode {
  const parser = new XMLParser({
    attributeNamePrefix: "@_",
    ignoreAttributes: false,
    isArray: (name) => ["p", "tbl", "tc", "tr"].includes(name),
    parseAttributeValue: false,
    parseTagValue: false,
    removeNSPrefix: true,
  });

  return parser.parse(xml) as XmlNode;
}

/** Concatenate the text content of an XML tree, skipping attributes. */
function xmlText(node: XmlNode | undefined): string {
  if (node === undefined || node === null) {
    return "";
  }

  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((entry) => xmlText(entry)).join("");
  }

  const parts: string[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (key === "#text") {
      parts.push(String(value));
    } else if (!key.startsWith("@_")) {
      parts.push(xmlText(value));
    }
  }

  return parts.join("");
}

function asObject(node: XmlNode | undefined): { [key: string]: XmlNode } | null {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    return node as { [key: string]: XmlNode };
  }

  return null;
}

/** Collapse runs of whitespace, preserving single spaces between words. */
function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

function extractDocxParagraph(paragraph: XmlNode, out: string[]) {
  const object = asObject(paragraph);

  if (!object) {
    return;
  }

  const pPr = asObject(object.pPr);
  const pStyle = asObject(pPr?.pStyle)?.["@_val"];
  const styleName = typeof pStyle === "string" ? pStyle : "";

  const text = normalizeWhitespace(xmlText(paragraph));

  if (!text) {
    return;
  }

  if (/^heading/i.test(styleName)) {
    const level = Number.parseInt(styleName.replace(/\D+/g, ""), 10) || 1;
    out.push(`${"#".repeat(Math.min(level, 6))} ${text}`);
  } else if (pPr?.numPr) {
    out.push(`- ${text}`);
  } else {
    out.push(text);
  }
}

function extractDocxTable(table: XmlNode, out: string[]) {
  const object = asObject(table);

  if (!object) {
    return;
  }

  const lines: string[] = [];

  for (const row of normalizeArray(object.tr)) {
    const cells = normalizeArray(asObject(row)?.tc).map((cell) =>
      normalizeWhitespace(xmlText(cell)),
    );

    if (cells.length > 0) {
      lines.push(`| ${cells.join(" | ")} |`);
    }
  }

  if (lines.length > 0) {
    out.push(lines.join("\n"));
  }
}

function extractDocxBody(body: XmlNode, out: string[]) {
  const object = asObject(body);

  if (!object) {
    return;
  }

  for (const [key, value] of Object.entries(object)) {
    if (key.startsWith("@_") || key === "#text") {
      continue;
    }

    if (key === "sectPr") {
      continue;
    }

    if (key === "p") {
      for (const paragraph of normalizeArray(value)) {
        extractDocxParagraph(paragraph, out);
      }
    } else if (key === "tbl") {
      for (const table of normalizeArray(value)) {
        extractDocxTable(table, out);
      }
    }
  }
}

function getXmlEntryText(
  zip: Record<string, Uint8Array>,
  path: string,
): string | null {
  const entry = zip[path];

  if (!entry) {
    return null;
  }

  return new TextDecoder().decode(entry);
}

export async function extractDocx(bytes: Uint8Array): Promise<string> {
  let zip: Record<string, Uint8Array>;

  try {
    zip = unzipSync(bytes);
  } catch (error) {
    throw new Error(
      `Invalid docx archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const xml = getXmlEntryText(zip, "word/document.xml");

  if (xml === null) {
    throw new Error("Invalid docx: missing word/document.xml.");
  }

  const parsed = asObject(parseXml(xml));
  const document = asObject(parsed?.document);
  const body = document?.body;

  const out: string[] = [];
  extractDocxBody(body, out);

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

export async function extractXlsx(bytes: Uint8Array): Promise<{
  text: string;
  sheetNames: string[];
  sheets: XlsxSheet[];
}> {
  const isZipArchive =
    bytes.length > 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isCfbArchive =
    bytes.length > 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0;

  if (!isZipArchive && !isCfbArchive) {
    throw new Error("Invalid xlsx workbook: not a spreadsheet archive.");
  }

  let workbook: XLSX.WorkBook;

  try {
    workbook = XLSX.read(bytes, { type: "array" });
  } catch (error) {
    throw new Error(
      `Invalid xlsx workbook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sheetNames = workbook.SheetNames ?? [];
  const sheets: XlsxSheet[] = [];

  if (sheetNames.length === 0) {
    throw new Error("Invalid xlsx workbook: no sheets found.");
  }

  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];

    if (!sheet) {
      continue;
    }

    const jsonRows = XLSX.utils.sheet_to_json(sheet, {
      blankrows: false,
      header: 1,
    }) as unknown[][];

    sheets.push({
      name,
      rows: jsonRows.map((row) =>
        row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))),
      ),
    });
  }

  const parts: string[] = [];

  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    const csv = sheet ? XLSX.utils.sheet_to_csv(sheet) : "";

    if (csv.trim().length === 0) {
      continue;
    }

    parts.push(`## Sheet: ${name}\n${csv.trimEnd()}`);
  }

  return {
    text: parts.join("\n\n"),
    sheetNames,
    sheets,
  };
}

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------

function slideNumberFromName(name: string): number {
  const match = name.match(/slide(\d+)\.xml$/);

  return match ? Number.parseInt(match[1]!, 10) : 0;
}

/** Collect every paragraph's text from a slide XML tree, in document order. */
function collectSlideLines(root: XmlNode): string[] {
  const lines: string[] = [];

  const visit = (node: XmlNode | undefined) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry);
      }

      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "p") {
        for (const paragraph of normalizeArray(value)) {
          const text = normalizeWhitespace(xmlText(paragraph));

          if (text) {
            lines.push(text);
          }
        }
      } else if (!key.startsWith("@_") && key !== "#text" && key !== "pPr") {
        visit(value);
      }
    }
  };

  visit(root);

  return lines;
}

export async function extractPptx(bytes: Uint8Array): Promise<{
  text: string;
  slideCount: number;
}> {
  let zip: Record<string, Uint8Array>;

  try {
    zip = unzipSync(bytes);
  } catch (error) {
    throw new Error(
      `Invalid pptx archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const slideNames = Object.keys(zip)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumberFromName(a) - slideNumberFromName(b));

  if (slideNames.length === 0) {
    throw new Error("Invalid pptx: no slides found.");
  }

  const parts: string[] = [];

  for (const name of slideNames) {
    const xml = getXmlEntryText(zip, name);

    if (xml === null) {
      continue;
    }

    const lines = collectSlideLines(parseXml(xml));

    if (lines.length === 0) {
      continue;
    }

    parts.push(`## Slide ${slideNumberFromName(name)}\n${lines.join("\n")}`);
  }

  return {
    text: parts.join("\n\n"),
    slideCount: slideNames.length,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function extractDocument(
  format: DocumentFormat,
  bytes: Uint8Array,
): Promise<ExtractedDocument> {
  switch (format) {
    case "docx":
      return {
        format,
        text: await extractDocx(bytes),
      };
    case "xlsx":
      return {
        format,
        ...(await extractXlsx(bytes)),
      };
    case "pptx":
      return {
        format,
        ...(await extractPptx(bytes)),
      };
    case "pdf": {
      const pdf = await extractPdf(bytes);

      return {
        format,
        pageCount: pdf.pageCount,
        pages: pdf.pages,
        text: pdf.text,
      };
    }
    default:
      throw new Error(`Unsupported document format: ${String(format)}`);
  }
}