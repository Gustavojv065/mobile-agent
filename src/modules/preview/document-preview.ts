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
blockquote{margin:.6em 0;padding:.1em 0 .1em .9em;border-left:3px solid #d4d4d8}
blockquote p{margin:.25em 0}
.preview-note{max-width:920px;margin:12px auto 0;padding:10px 14px;border:1px solid #facc15;background:#fefce8;color:#713f12;border-radius:10px;font-size:13px}
.stack{display:flex;flex-direction:column;gap:14px;max-width:920px;margin:0 auto;padding:16px}
.slide,.page,.sheet{
  background:#ffffff;color:#18181b;border:1px solid #e4e4e7;border-radius:12px;
  padding:16px 18px;box-shadow:0 1px 2px rgba(0,0,0,.06);
}
.slide-number
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
  blockquote{border-left-color:#3a3a3c}
  .preview-note{background:#29290b;color:#fde68a;border-color:#713f12}
}
`;

const HEADING_MATCH = /^(#{1,6})\s+(.*)$/;
const UNORDERED_LIST_MATCH = /^[-*+]\s+(.*)$/;
const ORDERED_LIST_MATCH = /^\d+[.)]\s+(.*)$/;
const HORIZONTAL_RULE_MATCH = /^(-{3,}|\*{3,})$/;
const FENCE_MATCH = /^```(\S*)\s*$/;
const QUOTE_MATCH = /^>\s?(.*)$/;
/** Pipe table row, e.g. `| a | b |`. */
const TABLE_ROW_MATCH = /^\|.*\|\s*$/;
/** Pipe table separator row, e.g. `| --- | --- |`; rendered but skipped. */
const TABLE_SEPARATOR_MATCH =
  /^\|?\s*:?-{2,}:?(\s*\|?\s*:?-{2,}:?)*\|?\s*$/;

/**
 * Bounds keep very large documents (for example 150-page reports) from
 * producing multi-megabyte WebView HTML. Truncated previews get a visible
 * note so the user knows to open or download the file for the rest.
 */
const MAX_TEXT_CHARS = 200_000;
const MAX_RENDER_SECTIONS = 200;
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLUMNS = 50;

const CODE_PLACEHOLDER = "\uE000";

function capText(
  text: string,
  limit: number = MAX_TEXT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }

  const slice = text.slice(0, limit);
  const cut = slice.lastIndexOf("\n");

  return {
    text: cut > limit / 2 ? slice.slice(0, cut) : slice,
    truncated: true,
  };
}

/**
 * Renders one line of light Markdown inline: code spans, bold, italic and
 * links. Everything is HTML-escaped first, and only safe link schemes are
 * turned into anchors so document text can never inject markup or scripts.
 */
export function renderInlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  const protectedText = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_PLACEHOLDER}${codeSpans.length - 1}${CODE_PLACEHOLDER}`;
  });

  let html = escapeHtml(protectedText);

  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (match, label: string, url: string) => {
      const decoded = url.replace(/&amp;/g, "&");

      return /^(https?:|mailto:|\/|#)/i.test(decoded)
        ? `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`
        : match;
    },
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  html = html.replace(
    new RegExp(`${CODE_PLACEHOLDER}(\\d+)${CODE_PLACEHOLDER}`, "g"),
    (_match, index: string) => codeSpans[Number(index)] ?? "",
  );

  return html;
}

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
  let quoteBuffer: string[] | null = null;
  let codeLanguage: string | null = null;

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

  const flushQuote = () => {
    if (quoteBuffer) {
      const paragraphs = quoteBuffer
        .map((entry) => `<p>${renderInlineMarkdown(entry)}</p>`)
        .join("");
      out.push(`<blockquote>${paragraphs}</blockquote>`);
      quoteBuffer = null;
    }
  };

  const closeCodeFence = () => {
    out.push("</code></pre>");
    codeLanguage = null;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      flushList();
      flushTable();
      flushQuote();
      continue;
    }

    if (codeLanguage !== null) {
      if (line.startsWith("```")) {
        closeCodeFence();
      } else {
        out.push(escapeHtml(line));
      }
      continue;
    }

    const fence = line.match(FENCE_MATCH);

    if (fence) {
      flushList();
      flushTable();
      flushQuote();
      codeLanguage = fence[1] ?? "";
      out.push(
        codeLanguage
          ? `<pre><code class="language-${escapeHtml(codeLanguage)}">`
          : "<pre><code>",
      );
      continue;
    }

    const heading = line.match(HEADING_MATCH);

    if (heading) {
      flushList();
      flushTable();
      flushQuote();
      const level = heading[1]!.length;
      out.push(
        `<h${level}>${renderInlineMarkdown(heading[2]!)}</h${level}>`,
      );
      continue;
    }

    if (TABLE_ROW_MATCH.test(line)) {
      flushList();
      flushQuote();
      tableBuffer ??= [];
      tableBuffer.push(line);
      continue;
    }

    if (tableBuffer) {
      flushTable();
    }

    if (HORIZONTAL_RULE_MATCH.test(line)) {
      flushQuote();
      out.push("<hr>");
      continue;
    }

    const quote = line.match(QUOTE_MATCH);

    if (quote) {
      flushList();
      quoteBuffer ??= [];
      quoteBuffer.push(quote[1] ?? "");
      continue;
    }

    flushQuote();

    const unordered = line.match(UNORDERED_LIST_MATCH);

    if (unordered) {
      if (listBuffer && listBuffer.kind !== "ul") {
        flushList();
      }
      listBuffer ??= { items: [], kind: "ul" };
      listBuffer.items.push(renderInlineMarkdown(unordered[1]!));
      continue;
    }

    const ordered = line.match(ORDERED_LIST_MATCH);

    if (ordered) {
      if (listBuffer && listBuffer.kind !== "ol") {
        flushList();
      }
      listBuffer ??= { items: [], kind: "ol" };
      listBuffer.items.push(renderInlineMarkdown(ordered[1]!));
      continue;
    }

    flushList();
    out.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  flushList();
  flushTable();
  flushQuote();

  if (codeLanguage !== null) {
    closeCodeFence();
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
      .map((cell) => renderInlineMarkdown(cell.trim())),
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

type RenderedSection = { body: string; truncated: boolean };

function renderDocx(extracted: ExtractedDocument): RenderedSection {
  const capped = capText(extracted.text);

  return {
    body: `<article class="document">${renderMarkdownishText(capped.text)}</article>`,
    truncated: capped.truncated,
  };
}

function renderPptx(extracted: ExtractedDocument): RenderedSection {
  const slides = extracted.text
    .split(/\n(?=## Slide \d+)/g)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const limited =
    slides.length > MAX_RENDER_SECTIONS
      ? slides.slice(0, MAX_RENDER_SECTIONS)
      : slides;

  let truncated = slides.length > limited.length;

  const sections =
    limited.length > 0
      ? limited.map((slideText) => {
          const match = slideText.match(/^## Slide (\d+)\n?([\s\S]*)$/);

          if (!match) {
            const capped = capText(slideText);
            truncated = truncated || capped.truncated;
            return `<section class="slide">${renderMarkdownishText(capped.text)}</section>`;
          }

          const capped = capText(match[2] ?? "");
          truncated = truncated || capped.truncated;
          const body = renderMarkdownishText(capped.text);

          return `<section class="slide"><div class="slide-number">Slide ${escapeHtml(
            match[1]!,
          )}</div><div class="slide-body">${body}</div></section>`;
        })
      : [`<section class="slide">${renderMarkdownishText(extracted.text)}</section>`];

  return { body: `<div class="stack">${sections.join("")}</div>`, truncated };
}

function renderPdf(extracted: ExtractedDocument): RenderedSection {
  const pages =
    extracted.pages && extracted.pages.length > 0
      ? extracted.pages
      : [extracted.text];
  const limited =
    pages.length > MAX_RENDER_SECTIONS
      ? pages.slice(0, MAX_RENDER_SECTIONS)
      : pages;

  let truncated = pages.length > limited.length;

  const sections = limited.map((page, index) => {
    const capped = capText(page);
    truncated = truncated || capped.truncated;
    const body = renderMarkdownishText(capped.text);

    return `<section class="page"><div class="page-label">Page ${
      index + 1
    }</div><div class="page-body">${body}</div></section>`;
  });

  return { body: `<div class="stack">${sections.join("")}</div>`, truncated };
}

function capSheet(sheet: XlsxSheet): { sheet: XlsxSheet; truncated: boolean } {
  const rows = sheet.rows
    .slice(0, MAX_SHEET_ROWS)
    .map((row) => row.slice(0, MAX_SHEET_COLUMNS));
  const truncated =
    sheet.rows.length > rows.length ||
    sheet.rows.some((row, index) => row.length > (rows[index]?.length ?? 0));

  return { sheet: { name: sheet.name, rows }, truncated };
}

function renderXlsxSheets(sheets: XlsxSheet[]): RenderedSection {
  const limited =
    sheets.length > MAX_RENDER_SECTIONS
      ? sheets.slice(0, MAX_RENDER_SECTIONS)
      : sheets;

  let truncated = sheets.length > limited.length;

  const body = limited
    .map((sheet) => {
      const capped = capSheet(sheet);
      truncated = truncated || capped.truncated;
      const rows = capped.sheet.rows
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

      return `<section class="sheet"><h2>${escapeHtml(capped.sheet.name)}</h2><div class="table-wrap"><table>${rows}</table></div></section>`;
    })
    .join("");

  return { body, truncated };
}

const EMPTY_BODY =
  '<section class="slide"><div class="slide-body"><p>No readable text in this preview.</p></div></section>';

const TRUNCATED_NOTE =
  '<p class="preview-note">Preview truncated — open or download the file to see the rest.</p>';

function hasReadableContent(extracted: ExtractedDocument): boolean {
  if (extracted.text.trim().length > 0) {
    return true;
  }

  if (extracted.pages?.some((page) => page.trim().length > 0)) {
    return true;
  }

  return (
    extracted.sheets?.some((sheet) =>
      sheet.rows.some((row) => row.some((cell) => cell.trim().length > 0)),
    ) ?? false
  );
}

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

  let rendered: RenderedSection;

  switch (extracted.format) {
    case "docx":
      rendered = renderDocx(extracted);
      break;
    case "pdf":
      rendered = renderPdf(extracted);
      break;
    case "pptx":
      rendered = renderPptx(extracted);
      break;
    case "xlsx":
      rendered =
        extracted.sheets && extracted.sheets.length > 0
          ? renderXlsxSheets(extracted.sheets)
          : renderDocx(extracted);
      break;
    default:
      rendered = { body: EMPTY_BODY, truncated: false };
  }

  let body = rendered.body;

  if (!hasReadableContent(extracted) || body.length === 0) {
    body = EMPTY_BODY;
  } else if (rendered.truncated) {
    body = `${body}${TRUNCATED_NOTE}`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title || "Document preview")}</title><style>${BASE_STYLES}${DOCUMENT_STYLES}</style></head><body>${body}</body></html>`;
}
