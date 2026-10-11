import { BASE_STYLES, escapeHtml } from "@/modules/preview/html-document";
import type {
  ExtractedDocument,
  XlsxSheet,
} from "@/modules/documents/extract";

/**
 * Styles layered on top of the shared base preview styles. The `.stack`
 * pattern renders each page/slide as its own card so multi-part documents are
 * easy to scroll through.
 */
const DOCUMENT_STYLES = `
.document{max-width:760px;margin:0 auto;padding:16px 18px 40px}
h1{font-size:1.6em;margin:1.3em 0 .5em;padding-bottom:6px;border-bottom:2px solid #d4d4d8}
h2{font-size:1.25em;margin:1.2em 0 .4em}
h3{font-size:1.08em;margin:1em 0 .3em}
p{margin:.4em 0 .8em}
ul,ol{margin:.4em 0 .9em;padding-left:1.5em}
li{margin:.12em 0}
pre{white-space:pre-wrap}
hr{border:0;border-top:1px solid #d4d4d8;margin:1.2em 0}
.stack{display:flex;flex-direction:column;gap:14px;max-width:920px;margin:0 auto;padding:16px}
.slide,.page,.sheet{
  background:#ffffff;color:#18181b;border:1px solid #e4e4e7;border-radius:12px;
  padding:16px 18px;box-shadow:0 1px 2px rgba(0,0,0,.06);
}
.slide-number,.page-label,.sheet h2{
  font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#71717a;
  margin:0 0 8px;padding-bottom:8px;border-bottom:1px solid #f2f2f3;font-weight:700;
}
.sheet h2{font-size:1em}
.slide-body:empty{display:none}
.slide-body h1,.page-body h1{font-size:1.25em;border-bottom:0;margin:.2em 0 .5em}
.table-wrap{overflow-x:auto}
table{display:table;width:100%}
@media (prefers-color-scheme:dark){
  .slide,.page,.sheet{background:#1a1a1c;color:#ededed;border-color:#2e2e31;box-shadow:none}
  h1{border-bottom-color:#3a3a3c}
  .slide-number,.page-label,.sheet h2{color:#a1a1aa;border-bottom-color:#2e2e31}
}
`;

const HEADING_MATCH = /^(#{1,6})\s+(.*)$/;
const UNORDERED_LIST_MATCH = /^[-*+]\s+(.*)$/;
const ORDERED_LIST_MATCH = /^\d+[.)]\s+(.*)$/;
const HORIZONTAL_RULE_MATCH = /^(-{3,}|\*{3,})$/;
/** Pipe table row, e.g. `| a | b |`. */
const TABLE_ROW_MATCH = /^\|.*\|\s*$/;
/** Pipe table separator row, e.g. `| --- | --- |`; rendered but skipped. */
const TABLE_SEPARATOR_MATCH =
  /^\|?\s*:?-{2,}:?(\s*\|?\s*:?-{2,}:?)*\|?\s*$/;

type ListKind = "ol" | "ul";

/**
 * Renders the flattened extraction text into HTML. The docx extractor already
 * emits light Markdown (`#` headings, `- ` items, `| a | b |` tables), so one
 * small block renderer serves every format.
 */
export function renderMarkdownishText(text: string): string {
  const out: string[] = [];
  let listBuffer: { kind: ListKind; items: string[] } | null = null;
  let tableBuffer: string[] | null = null;
  let inCodeFence = false;

  const flushList = () => {
    if (listBuffer) {
      const { items, kind } = listBuffer;
      out.push(`<${kind}>${items.map((item) => `<li>${item}</li>`).join("")}</${kind}>`);
      listBuffer = null;
    }
  };

  const flushTable = () => {
    if (tableBuffer) {
      out.push(renderPipeTable(tableBuffer));
      tableBuffer = null;
    }
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      flushList();
      flushTable();
      continue;
    }

    if (inCodeFence) {
      if (line.startsWith("```")) {
        inCodeFence = false;
        out.push("</pre>");
      } else {
        out.push(escapeHtml(line));
      }
      continue;
    }

    if (line.startsWith("```")) {
      flushList();
      flushTable();
      inCodeFence = true;
      out.push("<pre>");
      continue;
    }

    const heading = line.match(HEADING_MATCH);

    if (heading) {
      flushList();
      flushTable();
      const level = heading[1]!.length;
      out.push(`<h${level}>${escapeHtml(heading[2]!)}</h${level}>`);
      continue;
    }

    if (TABLE_ROW_MATCH.test(line)) {
      flushList();
      tableBuffer ??= [];
      tableBuffer.push(line);
      continue;
    }

    if (tableBuffer) {
      flushTable();
    }

    if (HORIZONTAL_RULE_MATCH.test(line)) {
      out.push("<hr>");
      continue;
    }

    const unordered = line.match(UNORDERED_LIST_MATCH);

    if (unordered) {
      if (listBuffer && listBuffer.kind !== "ul") {
        flushList();
      }
      listBuffer ??= { items: [], kind: "ul" };
      listBuffer.items.push(escapeHtml(unordered[1]!));
      continue;
    }

    const ordered = line.match(ORDERED_LIST_MATCH);

    if (ordered) {
      if (listBuffer && listBuffer.kind !== "ol") {
        flushList();
      }
      listBuffer ??= { items: [], kind: "ol" };
      listBuffer.items.push(escapeHtml(ordered[1]!));
      continue;
    }

    flushList();
    out.push(`<p>${escapeHtml(line)}</p>`);
  }

  flushList();
  flushTable();

  if (inCodeFence) {
    out.push("</pre>");
  }

  return out.join("\n");
}

function renderPipeTable(rows: string[]): string {
  const dataRows = rows.filter((row) => !TABLE_SEPARATOR_MATCH.test(row));
  const cells = dataRows.map((row) =>
    row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => escapeHtml(cell.trim())),
  );

  if (cells.length === 0) {
    return "";
  }

  const [header, ...body] = cells;

  const head = `<thead><tr>${header!
    .map((cell) => `<th>${cell}</th>`)
    .join("")}</tr></thead>`;
  const rowsHtml =
    body.length > 0
      ? `<tbody>${body
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`,
          )
          .join("")}</tbody>`
      : "";

  return `<table>${head}${rowsHtml}</table>`;
}

function renderDocx(extracted: ExtractedDocument): string {
  return `<article class="document">${renderMarkdownishText(extracted.text)}</article>`;
}

function renderPptx(extracted: ExtractedDocument): string {
  const slides = extracted.text
    .split(/\n(?=## Slide \d+)/g)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const sections =
    slides.length > 0
      ? slides.map((slideText) => {
          const match = slideText.match(/^## Slide (\d+)\n?([\s\S]*)$/);

          if (!match) {
            return `<section class="slide">${renderMarkdownishText(slideText)}</section>`;
          }

          const body = renderMarkdownishText(match[2] ?? "");

          return `<section class="slide"><div class="slide-number">Slide ${escapeHtml(
            match[1]!,
          )}</div><div class="slide-body">${body}</div></section>`;
        })
      : [`<section class="slide">${renderMarkdownishText(extracted.text)}</section>`];

  return `<div class="stack">${sections.join("")}</div>`;
}

function renderPdf(extracted: ExtractedDocument): string {
  const pages =
    extracted.pages && extracted.pages.length > 0
      ? extracted.pages
      : [extracted.text];

  const sections = pages.map((page, index) => {
    const body = renderMarkdownishText(page);

    return `<section class="page"><div class="page-label">Page ${
      index + 1
    }</div><div class="page-body">${body}</div></section>`;
  });

  return `<div class="stack">${sections.join("")}</div>`;
}

function renderXlsxSheets(sheets: XlsxSheet[]): string {
  return sheets
    .map((sheet) => {
      const rows = sheet.rows
        .map((row, rowIndex) => {
          const cells = row
            .map((cell) =>
              rowIndex === 0
                ? `<th>${escapeHtml(cell)}</th>`
                : `<td>${escapeHtml(cell)}</td>`,
            )
            .join("");

          return `<tr>${cells}</tr>`;
        })
        .join("");

      return `<section class="sheet"><h2>${escapeHtml(sheet.name)}</h2><div class="table-wrap"><table>${rows}</table></div></section>`;
    })
    .join("");
}

const EMPTY_BODY =
  '<section class="slide"><div class="slide-body"><p>No readable text in this preview.</p></div></section>';

/**
 * Builds a standalone HTML document that renders an extracted document in a
 * format-appropriate way: Word text as a document, PDFs page by page,
 * slides as cards, spreadsheets as per-sheet tables.
 */
export function buildDocumentPreviewHtml(input: {
  extracted: ExtractedDocument;
  title: string;
}): string {
  const { extracted, title } = input;

  let body: string;

  switch (extracted.format) {
    case "docx":
      body = renderDocx(extracted);
      break;
    case "pdf":
      body = renderPdf(extracted);
      break;
    case "pptx":
      body = renderPptx(extracted);
      break;
    case "xlsx":
      body =
        extracted.sheets && extracted.sheets.length > 0
          ? renderXlsxSheets(extracted.sheets)
          : renderDocx(extracted);
      break;
    default:
      body = EMPTY_BODY;
  }

  if (body.length === 0) {
    body = EMPTY_BODY;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title || "Document preview")}</title><style>${BASE_STYLES}${DOCUMENT_STYLES}</style></head><body>${body}</body></html>`;
}