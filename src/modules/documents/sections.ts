/**
 * Heading-delimited sectioning for document source Markdown. Large documents
 * (for example 150 pages) are split into ordered, independently editable
 * pieces so the agent never has to read or rewrite the whole source at once.
 *
 * Splitting is lossless: `assembleDocumentSections(splitDocumentSections(x))`
 * returns `x` with CRLF normalized to LF.
 */

export type DocumentSectionDraft = {
  /** Heading text without the leading `#` markers. */
  title: string;
  /** Heading level 1-6. */
  level: number;
  /** Exact Markdown slice for the section, including its heading line. */
  body: string;
};

export type SplitDocument = {
  /**
   * Everything before the first heading (YAML front-matter plus any preamble).
   * Ends with a newline when non-empty, so it can be concatenated directly with
   * the section bodies.
   */
  prefix: string;
  sections: DocumentSectionDraft[];
};

const HEADING_PATTERN = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const FENCE_PATTERN = /^[ \t]*(`{3,}|~{3,})/;

export function splitDocumentSections(content: string): SplitDocument {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const headingStarts: number[] = [];
  let fence: { char: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = FENCE_PATTERN.exec(line);

    // Skip everything inside fenced code blocks so `# comments` are not
    // mistaken for headings.
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.char &&
        fenceMatch[1]!.length >= fence.length
      ) {
        fence = null;
      }

      continue;
    }

    if (fenceMatch) {
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }

    if (HEADING_PATTERN.test(line)) {
      headingStarts.push(index);
    }
  }

  if (headingStarts.length === 0) {
    return {
      prefix:
        normalized.length > 0 && !normalized.endsWith("\n")
          ? `${normalized}\n`
          : normalized,
      sections: [],
    };
  }

  const firstStart = headingStarts[0]!;
  const prefix =
    firstStart > 0 ? `${lines.slice(0, firstStart).join("\n")}\n` : "";

  const sections: DocumentSectionDraft[] = [];

  for (let index = 0; index < headingStarts.length; index += 1) {
    const start = headingStarts[index]!;
    const end =
      index + 1 < headingStarts.length ? headingStarts[index + 1]! : lines.length;
    const heading = HEADING_PATTERN.exec(lines[start] ?? "");

    sections.push({
      title: heading ? heading[2]!.trim() : "",
      level: heading ? heading[1]!.length : 1,
      body: lines.slice(start, end).join("\n"),
    });
  }

  return { prefix, sections };
}

export function assembleDocumentSections(split: SplitDocument): string {
  const body = split.sections.map((section) => section.body).join("\n");

  return split.prefix + body;
}

/**
 * Parse agent-provided replacement text for one section. The content must start
 * with a Markdown heading so the section keeps a title and level.
 */
export function parseSectionContent(content: string): DocumentSectionDraft {
  const normalized = content.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const firstLine = normalized.split("\n", 1)[0] ?? "";
  const heading = HEADING_PATTERN.exec(firstLine);

  if (!heading) {
    throw new Error(
      'Section content must start with a Markdown heading (for example "## Title").',
    );
  }

  return {
    title: heading[2]!.trim(),
    level: heading[1]!.length,
    body: normalized,
  };
}

/** Short single-line preview of a section's prose, used in section listings. */
export function sectionPreview(body: string, maxChars = 140): string {
  const withoutHeading = body.replace(/^#{1,6}[ \t]+.*\n?/, "");
  const flat = withoutHeading.replace(/\s+/g, " ").trim();

  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}
