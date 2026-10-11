import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const FRONT_MATTER_START_PATTERN = /^---[ \t]*$/;
const FRONT_MATTER_END_PATTERN = /^(---|\.\.\.)[ \t]*$/;

export type DocumentSource = {
  /** Markdown body without the front-matter block (if one was present). */
  body: string;
  /** Whether the content had a YAML front-matter block. */
  hadFrontMatter: boolean;
  /** Parsed front-matter values (any shape), including the `format` key. */
  meta: Record<string, unknown>;
};

/**
 * Split Markdown content into an optional YAML front-matter block and the
 * body. Only the very first `---` line (with nothing before it) opens a
 * block, and blocks that fail to parse as YAML are ignored (the content is
 * treated as plain body). This keeps ordinary documents that happen to start
 * with a horizontal rule intact.
 */
export function parseDocumentSource(content: string): DocumentSource {
  const normalized = content.replace(/\r\n?/g, "\n");

  const lines = normalized.split("\n");
  const firstLine = lines[0] ?? "";

  if (!FRONT_MATTER_START_PATTERN.test(firstLine)) {
    return { body: content, hadFrontMatter: false, meta: {} };
  }

  let endIndex = -1;

  for (let index = 1; index < lines.length; index += 1) {
    if (FRONT_MATTER_END_PATTERN.test(lines[index] ?? "")) {
      endIndex = index;
      break;
    }
  }

  if (endIndex < 0) {
    return { body: content, hadFrontMatter: false, meta: {} };
  }

  const rawFrontMatter = lines.slice(1, endIndex).join("\n");

  let meta: unknown;

  try {
    meta = parseYaml(rawFrontMatter || "{}");
  } catch {
    return { body: content, hadFrontMatter: false, meta: {} };
  }

  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return { body: content, hadFrontMatter: false, meta: {} };
  }

  const body = lines.slice(endIndex + 1).join("\n");

  return {
    body,
    hadFrontMatter: true,
    meta: meta as Record<string, unknown>,
  };
}

/**
 * Persist a format spec into the content's front-matter so documents keep
 * their styling across updates. The given spec replaces the `format` key;
 * other front-matter keys (title, author, ...) are preserved. Returns the
 * original content untouched when no spec is provided.
 */
export function mergeSpecIntoSource(
  content: string,
  spec: unknown,
): string {
  if (spec === undefined || spec === null) {
    return content;
  }

  const parsed = parseDocumentSource(content);
  const meta = { ...parsed.meta, format: spec };

  return `---\n${stringifyYaml(meta)}---\n\n${parsed.body}`;
}