/**
 * Split and merge document source Markdown for the OOXML formats (docx, xlsx,
 * pptx). Unlike pdf, these formats have no fixed pages in the file, so they are
 * split and merged at the source level: the same editable Markdown that
 * `createFile`/`updateDocument` use. This keeps every part editable and, for
 * imported documents, style-preserving via the captured source spec.
 */

import { parseIndexRanges } from "@/modules/documents/ranges";
import { splitDocumentSections } from "@/modules/documents/sections";

export type DocumentPart = {
  /** 0-based section indices included in this part. */
  sectionIndices: number[];
  /** Markdown source for this part (front-matter plus the selected sections). */
  source: string;
  /** Title of the first section in the part (empty when unknown). */
  title: string;
};

const FRONT_MATTER_PATTERN = /^---\n[\s\S]*?\n---\n?/;

function normalize(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/**
 * Separate a leading YAML front-matter block (the `---` ... `---` fence) from
 * the rest of the source. The returned `frontMatter` always ends with a newline
 * when present, so it can be concatenated directly with body content.
 */
function extractFrontMatter(source: string): {
  frontMatter: string;
  rest: string;
} {
  const normalized = normalize(source);
  const match = FRONT_MATTER_PATTERN.exec(normalized);

  if (!match) {
    return { frontMatter: "", rest: normalized };
  }

  const raw = match[0];
  const frontMatter = raw.endsWith("\n") ? raw : `${raw}\n`;

  return { frontMatter, rest: normalized.slice(raw.length) };
}

/**
 * Split document source Markdown into parts by heading sections. The `spec`
 * accepts 0-based section ranges matching the `sections` list returned by the
 * `read` tool (for example "0-2,4", "3-", or "-1"). The keyword "each" makes
 * one part per section and "all" keeps everything in a single part. Front-matter
 * is copied into every part and the pre-heading preamble stays only in the first
 * part, so concatenating the parts in order reproduces the original source.
 */
export function splitDocumentSource(input: {
  source: string;
  spec: string;
}): { parts: DocumentPart[]; sectionCount: number } {
  const { frontMatter, rest } = extractFrontMatter(input.source);
  const split = splitDocumentSections(rest);
  const sectionCount = split.sections.length;

  if (sectionCount === 0) {
    throw new Error(
      "The document has no Markdown headings to split on. Add headings first, or split a pdf by pages with splitPdf.",
    );
  }

  const trimmed = input.spec.trim().toLowerCase();
  const ranges =
    trimmed === "each"
      ? split.sections.map((_section, index) => ({ start: index, end: index }))
      : parseIndexRanges(input.spec, sectionCount, "section", {
          zeroBased: true,
        });

  const parts: DocumentPart[] = ranges.map((range) => {
    const sectionIndices: number[] = [];

    for (let index = range.start; index <= range.end; index += 1) {
      sectionIndices.push(index);
    }

    const bodies = sectionIndices.map((index) => split.sections[index]!.body);

    return {
      source: bodies.join("\n"),
      title: split.sections[range.start]?.title ?? "",
      sectionIndices,
    };
  });

  // Keep the pre-heading preamble in the part that contains section 0, or in
  // the first part when section 0 is not part of any range, so no content is
  // silently dropped.
  const preamblePart = ranges.findIndex((range) => range.start === 0);

  parts.forEach((part, index) => {
    const preamble = index === (preamblePart >= 0 ? preamblePart : 0)
      ? split.prefix
      : "";

    part.source = `${frontMatter}${preamble}${part.source}`;
  });

  return { parts, sectionCount };
}

/**
 * Merge document sources into one, preserving order. The first source keeps its
 * YAML front-matter (and therefore its styling); later sources have their
 * front-matter stripped so the result has a single spec. Content is joined with
 * a blank line.
 */
export function mergeDocumentSources(input: { sources: string[] }): string {
  if (input.sources.length === 0) {
    throw new Error("At least one document is required to merge.");
  }

  const chunks = input.sources.map((source, index) => {
    const normalized = normalize(source).replace(/\n+$/, "");

    if (index === 0) {
      return normalized;
    }

    return extractFrontMatter(normalized)
      .rest.replace(/^\n+/, "")
      .replace(/\n+$/, "");
  });

  return `${chunks.filter((chunk) => chunk.length > 0).join("\n\n")}\n`;
}
