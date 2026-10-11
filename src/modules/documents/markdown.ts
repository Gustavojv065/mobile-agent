import type { DocumentBlock, InlineRun } from "@/modules/documents/types";

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const UNORDERED_LIST_PATTERN = /^\s*[-*+]\s+(.*)$/;
const ORDERED_LIST_PATTERN = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_SEPARATOR_PATTERN =
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HORIZONTAL_RULE_PATTERN = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE_PATTERN = /^\s*```/;
const IMAGE_PATTERN =
  /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"(\d+(?:\.\d+)?)(?:px)?")?\)\s*$/;

/**
 * Split inline markdown into styled runs. Supports `**bold**`, `__bold__`,
 * `*italic*`, `_italic_`, `` `code` `` and `[label](target)` links (rendered
 * as a run with a `href`).
 */
export function parseInlineRuns(input: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern =
    /(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(_([^_]+)_)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const push = (text: string, style?: Omit<InlineRun, "text">) => {
    if (!text) {
      return;
    }

    const previous = runs[runs.length - 1];

    if (
      previous &&
      previous.bold === style?.bold &&
      previous.italic === style?.italic &&
      previous.code === style?.code &&
      previous.href === style?.href
    ) {
      previous.text += text;
      return;
    }

    runs.push({ text, ...style });
  };

  while ((match = pattern.exec(input)) !== null) {
    push(input.slice(lastIndex, match.index));

    if (match[2] !== undefined) {
      push(match[2], { bold: true });
    } else if (match[4] !== undefined) {
      push(match[4], { bold: true });
    } else if (match[6] !== undefined) {
      push(match[6], { italic: true });
    } else if (match[8] !== undefined) {
      push(match[8], { italic: true });
    } else if (match[10] !== undefined) {
      push(match[10], { code: true });
    } else if (match[12] !== undefined) {
      push(match[12], { href: match[13] });
    }

    lastIndex = pattern.lastIndex;
  }

  push(input.slice(lastIndex));

  if (runs.length === 0) {
    runs.push({ text: "" });
  }

  return runs;
}

export function inlineRunsToPlainText(runs: InlineRun[]): string {
  return runs.map((run) => run.text).join("");
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");

  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableHeader(lines: string[], index: number): boolean {
  const current = lines[index];
  const next = lines[index + 1];

  return (
    current !== undefined &&
    next !== undefined &&
    current.includes("|") &&
    TABLE_SEPARATOR_PATTERN.test(next)
  );
}

/**
 * Parse a practical subset of Markdown into document blocks. The goal is not
 * full CommonMark compliance but a faithful structure that maps cleanly onto
 * docx, pdf, pptx and xlsx output.
 */
export function parseMarkdownBlocks(markdown: string): DocumentBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocumentBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (FENCE_PATTERN.test(line)) {
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !FENCE_PATTERN.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }

      index += 1;
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    if (isTableHeader(lines, index)) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        const row = splitTableRow(lines[index] ?? "");

        if (row.length === 1 && !(lines[index] ?? "").trim()) {
          break;
        }

        rows.push(row);
        index += 1;
      }

      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);

    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        text: heading[2]!.trim(),
      });
      index += 1;
      continue;
    }

    const image = IMAGE_PATTERN.exec(line);

    if (image) {
      const widthRaw = image[3];

      blocks.push({
        type: "image",
        alt: image[1] ?? "",
        src: image[2]!,
        ...(widthRaw !== undefined
          ? { widthPx: Math.round(Number.parseFloat(widthRaw)) }
          : {}),
      });
      index += 1;
      continue;
    }

    if (HORIZONTAL_RULE_PATTERN.test(line)) {
      blocks.push({ type: "pageBreak" });
      index += 1;
      continue;
    }

    if (UNORDERED_LIST_PATTERN.test(line) || ORDERED_LIST_PATTERN.test(line)) {
      const ordered = ORDERED_LIST_PATTERN.test(line);
      const items: InlineRun[][] = [];

      while (index < lines.length) {
        const item = lines[index] ?? "";
        const match = ordered
          ? ORDERED_LIST_PATTERN.exec(item)
          : UNORDERED_LIST_PATTERN.exec(item);

        if (!match) {
          break;
        }

        items.push(parseInlineRuns(match[1]!.trim()));
        index += 1;
      }

      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];

    while (index < lines.length) {
      const paragraphLine = lines[index] ?? "";

      if (
        !paragraphLine.trim() ||
        FENCE_PATTERN.test(paragraphLine) ||
        HEADING_PATTERN.test(paragraphLine) ||
        IMAGE_PATTERN.test(paragraphLine) ||
        HORIZONTAL_RULE_PATTERN.test(paragraphLine) ||
        isTableHeader(lines, index) ||
        UNORDERED_LIST_PATTERN.test(paragraphLine) ||
        ORDERED_LIST_PATTERN.test(paragraphLine)
      ) {
        break;
      }

      paragraphLines.push(paragraphLine.trim());
      index += 1;
    }

    blocks.push({
      type: "paragraph",
      runs: parseInlineRuns(paragraphLines.join(" ")),
    });
  }

  return blocks;
}
