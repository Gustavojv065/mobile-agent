import { refractor } from "refractor";
import jsx from "refractor/jsx";
import tsx from "refractor/tsx";

refractor.register(jsx);
refractor.register(tsx);

/**
 * Pure syntax-highlighting core — no React Native imports, so vitest can test
 * it in node. The React Native rendering layer and the hooks live in
 * `syntax-highlight.tsx`, which re-exports everything from here.
 */

export type SyntaxNode =
  | { type: "text"; value: string }
  | {
      children: SyntaxNode[];
      properties?: { className?: unknown };
      type: "element";
    };

export type SyntaxTokenKind =
  | "comment"
  | "constant"
  | "number"
  | "string"
  | "operator"
  | "keyword"
  | "function"
  | "regex"
  | "default";

/** One flattened token run: a Prism token kind plus its raw text. */
export type SyntaxRun = {
  kind: SyntaxTokenKind;
  text: string;
};

/**
 * The syntax colors a theme provides. A structural subset of the app theme so
 * this core module stays independent of React and React Native.
 */
export type SyntaxColors = {
  syntaxComment: string;
  syntaxConstant: string;
  syntaxFunction: string;
  syntaxKeyword: string;
  syntaxNumber: string;
  syntaxOperator: string;
  syntaxRegex: string;
  syntaxString: string;
};

/** Map Prism's token class list to one of the nine token kinds. */
export const SYNTAX_KIND_CLASSES: Record<
  SyntaxTokenKind,
  readonly string[]
> = {
  comment: ["comment", "prolog", "doctype", "cdata"],
  constant: ["property", "tag", "constant", "symbol", "deleted"],
  number: ["boolean", "number"],
  string: ["selector", "attr-name", "string", "char", "builtin", "inserted"],
  operator: ["operator", "entity", "url", "variable"],
  keyword: ["atrule", "attr-value", "keyword", "control", "directive"],
  function: ["function", "class-name"],
  regex: ["regex", "important"],
  default: [],
};

export function getSyntaxTokenKind(classNames: string[]): SyntaxTokenKind {
  for (const [kind, classes] of Object.entries(SYNTAX_KIND_CLASSES)) {
    if (
      kind !== "default" &&
      classNames.some((name) => classes.includes(name))
    ) {
      return kind as SyntaxTokenKind;
    }
  }
  return "default";
}

export type SyntaxTokenStyle = { color: string; italic?: boolean };

export function getSyntaxTokenStyle(
  kind: SyntaxTokenKind,
  textColor: string,
  colors: SyntaxColors,
): SyntaxTokenStyle {
  switch (kind) {
    case "comment":
      return { color: colors.syntaxComment, italic: true };
    case "constant":
      return { color: colors.syntaxConstant };
    case "number":
      return { color: colors.syntaxNumber };
    case "string":
      return { color: colors.syntaxString };
    case "operator":
      return { color: colors.syntaxOperator };
    case "keyword":
      return { color: colors.syntaxKeyword };
    case "function":
      return { color: colors.syntaxFunction };
    case "regex":
      return { color: colors.syntaxRegex };
    default:
      return { color: textColor };
  }
}

/** Splits flattened runs at newline boundaries into per-line run arrays. */
export function splitRunsIntoLines(runs: SyntaxRun[]): SyntaxRun[][] {
  const lines: SyntaxRun[][] = [[]];

  for (const run of runs) {
    const segments = run.text.split("\n");

    for (let index = 0; index < segments.length; index += 1) {
      if (index > 0) {
        lines.push([]);
      }

      if (segments[index]) {
        lines[lines.length - 1].push({
          kind: run.kind,
          text: segments[index],
        });
      }
    }
  }

  return lines;
}

/** SGR foreground colors → the token kinds whose theme color matches. */
const ANSI_SGR_COLORS: Record<string, SyntaxTokenKind> = {
  "30": "default",
  "31": "constant",
  "32": "string",
  "33": "regex",
  "34": "function",
  "35": "keyword",
  "36": "operator",
  "37": "default",
  "90": "comment",
  "91": "constant",
  "92": "string",
  "93": "regex",
  "94": "function",
  "95": "keyword",
  "96": "operator",
  "97": "default",
};

const ANSI_RESET_PARAMS = new Set(["", "0", "39"]);

const ANSI_MATCHER = /\u001b\[([0-9;]*)m/g;

/** ANSI terminal output → token runs; escape codes never leak as text. */
export function highlightAnsi(code: string): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  let kind: SyntaxTokenKind = "default";
  let lastFlush = 0;
  ANSI_MATCHER.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = ANSI_MATCHER.exec(code))) {
    if (match.index > lastFlush) {
      runs.push({ kind, text: code.slice(lastFlush, match.index) });
    }

    const params = match[1].split(";").filter(Boolean);
    if (
      params.length === 0 ||
      params.some((param) => ANSI_RESET_PARAMS.has(param))
    ) {
      kind = "default";
    } else {
      const color = params.find((param) => ANSI_SGR_COLORS[param]);
      if (color) {
        kind = ANSI_SGR_COLORS[color];
      }
    }

    lastFlush = ANSI_MATCHER.lastIndex;
  }

  if (lastFlush < code.length) {
    runs.push({ kind, text: code.slice(lastFlush) });
  }

  return runs;
}

const SYNC_HIGHLIGHT_LENGTH = 2000;
const HIGHLIGHT_CACHE_LIMIT = 64;

type HighlightCacheEntry = SyntaxRun[] | null;

/**
 * Refractor is synchronous, so it can noticeably block the JS thread on large
 * files. Consumers highlight only small slices synchronously (usually the
 * collapsed first lines) and re-check this module-level LRU cache on every
 * render, keeping streaming smooth without dropping color to plain text.
 */
const highlightRunCache = new Map<string, HighlightCacheEntry>();

export function highlightCacheKey(code: string, language: string) {
  return `${language}\u0000${code}`;
}

export function clearHighlightCache() {
  highlightRunCache.clear();
}

/** White-box test hook: whether a code/language pair is cached. */
export function hasCachedHighlight(code: string, language: string) {
  return highlightRunCache.has(highlightCacheKey(code, language));
}

/**
 * Highlights `code` for `language`, returning flattened token runs, or `null`
 * when the language is not registered or grammar parsing fails. Pulls from
 * and populates the module-level LRU cache.
 */
export function computeHighlightRuns(
  code: string,
  language: string,
): SyntaxRun[] | null {
  if (!language) {
    return null;
  }

  if (language.toLowerCase() === "ansi") {
    return highlightAnsi(code);
  }

  if (!refractor.registered(language)) {
    return null;
  }

  if (code.length > SYNC_HIGHLIGHT_LENGTH) {
    // Large snippets are deliberately not cached here — they arrive once and
    // typically stream on, so keeping them would churn the LRU.
    let runs: SyntaxRun[] | null = null;

    try {
      runs = flattenNodes(
        refractor.highlight(code, language).children as SyntaxNode[],
      );
    } catch {
      runs = null;
    }

    return runs;
  }

  const key = highlightCacheKey(code, language);
  const cached = highlightRunCache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  let runs: SyntaxRun[] | null = null;

  try {
    runs = flattenNodes(
      refractor.highlight(code, language).children as SyntaxNode[],
    );
  } catch {
    runs = null;
  }

  if (highlightRunCache.size >= HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightRunCache.keys().next().value;

    if (oldest !== undefined) {
      highlightRunCache.delete(oldest);
    }
  }

  highlightRunCache.set(key, runs);

  return runs;
}

function flattenNodes(nodes: SyntaxNode[]): SyntaxRun[] {
  const runs: SyntaxRun[] = [];
  flattenSyntaxNodes(nodes, "default", runs);
  return runs;
}

function flattenSyntaxNodes(
  nodes: SyntaxNode[],
  parentKind: SyntaxTokenKind,
  runs: SyntaxRun[],
): void {
  for (const node of nodes) {
    if (node.type === "text") {
      const text = node.value ?? "";
      if (text) {
        runs.push({ kind: parentKind, text });
      }
      continue;
    }

    const classNames = Array.isArray(node.properties?.className)
      ? node.properties.className.filter(
          (className): className is string => typeof className === "string",
        )
      : [];
    flattenSyntaxNodes(
      node.children ?? [],
      getSyntaxTokenKind(classNames),
      runs,
    );
  }
}
