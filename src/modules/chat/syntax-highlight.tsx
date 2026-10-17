import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, type TextStyle } from "react-native";

import { useTheme } from "@/hooks/use-theme";
import {
  computeHighlightRuns,
  getSyntaxTokenStyle,
  highlightCacheKey,
  splitRunsIntoLines,
  type SyntaxColors,
  type SyntaxRun,
  type SyntaxTokenKind,
} from "@/modules/chat/syntax-highlight-core";

/**
 * React Native layer of the syntax highlighter. The pure core (grammar
 * lookup, refractor highlighting, the LRU cache, token kinds, ANSI) lives in
 * `syntax-highlight-core.ts` and is unit-testable; this file holds the react
 * hooks and the run → <Text> renderer.
 */

export {
  clearHighlightCache,
  computeHighlightRuns,
  getSyntaxTokenKind,
  getSyntaxTokenStyle,
  highlightCacheKey,
  highlightAnsi,
  hasCachedHighlight,
  splitRunsIntoLines,
  type SyntaxColors,
  type SyntaxNode,
  type SyntaxRun,
  type SyntaxTokenKind,
  type SyntaxTokenStyle,
} from "@/modules/chat/syntax-highlight-core";

/**
 * Whole-code highlighted runs. Small code highlights synchronously; large
 * snippets render plain first and upgrade after one paint so a big block
 * never stalls the list. Cached results return either way.
 */
export function useHighlightedRuns(
  code: string,
  language: string,
): SyntaxRun[] | null {
  const cacheKey = highlightCacheKey(code, language);
  const immediateRuns = useMemo(
    () =>
      code.length <= SYNC_HIGHLIGHT_LENGTH
        ? computeHighlightRuns(code, language)
        : null,
    [code, language],
  );
  const [deferred, setDeferred] = useState<{
    key: string;
    runs: SyntaxRun[] | null;
  } | null>(null);

  useEffect(() => {
    if (code.length <= SYNC_HIGHLIGHT_LENGTH) {
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setDeferred({
          key: cacheKey,
          runs: computeHighlightRuns(code, language),
        });
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [cacheKey, code, language]);

  return code.length <= SYNC_HIGHLIGHT_LENGTH
    ? immediateRuns
    : deferred?.key === cacheKey
      ? deferred.runs
      : null;
}

const SYNC_HIGHLIGHT_LENGTH = 2000;

/**
 * Shadcn-style per-line hook: one run array per source line, or `null` when
 * the language renders plain. Whole code is highlighted once and cached, so
 * streaming re-parses only through the module cache — the split itself is a
 * cheap string pass and per-line arrays stay predictably shaped for React.
 */
export function useHighlightedCode(
  code: string,
  language: string,
): SyntaxRun[][] | null {
  const runs = useHighlightedRuns(code, language);

  return useMemo(
    () => (runs === null ? null : splitRunsIntoLines(runs)),
    [runs],
  );
}

/**
 * Renders flattened code runs as grouped <Text> nodes — adjacent runs of the
 * same kind merge into one element, so a highlighted line stays a handful of
 * native text nodes no matter how finely the grammar tokenized it.
 */
export function renderCodeRuns(
  runs: SyntaxRun[],
  textColor: string,
  colors: SyntaxColors,
): ReactNode[] {
  const styleCache = new Map<SyntaxTokenKind, TextStyle>();

  const getStyle = (kind: SyntaxTokenKind) => {
    let style = styleCache.get(kind);

    if (!style) {
      const tokenStyle = getSyntaxTokenStyle(kind, textColor, colors);
      style = { color: tokenStyle.color };
      if (tokenStyle.italic) {
        style.fontStyle = "italic";
      }
      styleCache.set(kind, style);
    }

    return style;
  };

  const grouped: ReactNode[] = [];
  let pending: { kind: SyntaxTokenKind; text: string } | null = null;
  let groupIndex = 0;

  const flush = () => {
    if (pending !== null) {
      grouped.push(
        <Text key={`run-${groupIndex++}`} style={getStyle(pending.kind)}>
          {pending.text}
        </Text>,
      );
      pending = null;
    }
  };

  for (const run of runs) {
    if (pending !== null && pending.kind === run.kind) {
      pending.text += run.text;
    } else {
      flush();
      pending = { kind: run.kind, text: run.text };
    }
  }
  flush();

  return grouped;
}

/** The app theme, narrowed to the syntax colors the renderer needs. */
export function getSyntaxColors(
  theme: ReturnType<typeof useTheme>,
): SyntaxColors {
  return {
    syntaxComment: theme.syntaxComment,
    syntaxConstant: theme.syntaxConstant,
    syntaxFunction: theme.syntaxFunction,
    syntaxKeyword: theme.syntaxKeyword,
    syntaxNumber: theme.syntaxNumber,
    syntaxOperator: theme.syntaxOperator,
    syntaxRegex: theme.syntaxRegex,
    syntaxString: theme.syntaxString,
  };
}
