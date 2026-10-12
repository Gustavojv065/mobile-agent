/**
 * Core markdown-it rules for the chat renderer.
 *
 * Kept free of `react-native` and `markdown-it` imports so the token transform
 * can be exercised directly in unit tests; the parser instance is injected.
 */

export type MarkdownToken = {
  attrSet: (name: string, value: string) => void;
  block?: boolean;
  // `null` rather than `undefined` so a real markdown-it Token (whose children
  // are null when absent) is structurally assignable to this shape.
  children?: MarkdownToken[] | null;
  content: string;
  level: number;
  map?: [number, number] | null;
  markup?: string;
  type: string;
};

/** The block-level parser state a block rule reads and mutates. */
type MarkdownBlockState = {
  bMarks: number[];
  eMarks: number[];
  src: string;
  tShift: number[];
  line: number;
  push(type: string, tag: string, nesting: number): MarkdownToken;
};

type MarkdownItLike = {
  block: {
    ruler: {
      // Method shorthand on purpose: it opts into bivariant parameter checking,
      // so a real markdown-it instance satisfies this stand-in even though its
      // StateBlock type is structurally wider than MarkdownBlockState.
      before(
        beforeName: string,
        ruleName: string,
        rule: (
          state: MarkdownBlockState,
          startLine: number,
          endLine: number,
          silent: boolean,
        ) => boolean,
        options?: { alt?: string[] },
      ): void;
    };
  };
  core: {
    ruler: {
      // Method shorthand on purpose: it opts into bivariant parameter checking,
      // so a real markdown-it instance satisfies this stand-in even though its
      // StateCore token type is structurally wider than MarkdownToken.
      after(
        afterName: string,
        ruleName: string,
        rule: (state: { tokens: MarkdownToken[] }) => void,
      ): void;
    };
  };
};

/** GFM task list checkboxes, which markdown-it does not support out of the box. */
function registerTaskLists(parser: MarkdownItLike) {
  parser.core.ruler.after("inline", "task_lists", (state) => {
    for (let index = 0; index < state.tokens.length; index += 1) {
      const listItem = state.tokens[index];

      if (listItem.type !== "list_item_open") {
        continue;
      }

      const list = state.tokens
        .slice(0, index)
        .reverse()
        .find(
          (token) =>
            token.level === listItem.level - 1 &&
            (token.type === "bullet_list_open" ||
              token.type === "ordered_list_open"),
        );

      if (list?.type !== "bullet_list_open") {
        continue;
      }

      const inline = state.tokens
        .slice(index + 1)
        .find(
          (token) =>
            token.type === "inline" ||
            (token.type === "list_item_close" &&
              token.level === listItem.level),
        );
      const firstText =
        inline?.type === "inline" ? inline.children?.[0] : undefined;
      const taskMarker = firstText?.content.match(/^\[([ xX])\]\s+/);

      if (!firstText || !taskMarker) {
        continue;
      }

      firstText.content = firstText.content.slice(taskMarker[0].length);
      listItem.attrSet("task", "true");
      listItem.attrSet("checked", String(taskMarker[1].toLowerCase() === "x"));
    }
  });
}

/** Block-math delimiters. Inline `$…$` is intentionally not handled here. */
const MATH_DELIMITERS: { close: string; open: string }[] = [
  { open: "$$", close: "$$" },
  { open: "\\[", close: "\\]" },
];

type MathBlockMatch = {
  /** Line the closing delimiter sits on. */
  closeLine: number;
  /** TeX between the delimiters, trimmed. */
  content: string;
};

/**
 * Resolves a math block that starts on `startLine`, where `firstLineRest` is the
 * opening line's text after the opening delimiter. Returns `null` — leaving the
 * text for the normal paragraph rule — when no closing delimiter exists.
 */
function readMathBlock(
  state: MarkdownBlockState,
  startLine: number,
  endLine: number,
  close: string,
  firstLineRest: string,
): MathBlockMatch | null {
  const sameLine = firstLineRest.indexOf(close);

  if (sameLine !== -1) {
    return {
      closeLine: startLine,
      content: firstLineRest.slice(0, sameLine).trim(),
    };
  }

  const lines = [firstLineRest];

  for (let line = startLine + 1; line < endLine; line += 1) {
    const from = state.bMarks[line] + state.tShift[line];
    const text = state.src.slice(from, state.eMarks[line]);
    const index = text.indexOf(close);

    if (index !== -1) {
      lines.push(text.slice(0, index));
      return { closeLine: line, content: lines.join("\n").trim() };
    }

    lines.push(text);
  }

  return null;
}

/**
 * `$$ … $$` and `\[ … \]` block equations.
 *
 * Emits a `math_block` token whose `content` is the raw TeX; the chat renderer
 * maps it to `<MathBlock>`.
 */
function registerMathBlocks(parser: MarkdownItLike) {
  parser.block.ruler.before(
    "fence",
    "math_block",
    (state, startLine, endLine, silent) => {
      const from = state.bMarks[startLine] + state.tShift[startLine];
      const rest = state.src.slice(from, state.eMarks[startLine]);
      const delimiter = MATH_DELIMITERS.find((entry) =>
        rest.startsWith(entry.open),
      );

      if (!delimiter) {
        return false;
      }

      const block = readMathBlock(
        state,
        startLine,
        endLine,
        delimiter.close,
        rest.slice(delimiter.open.length),
      );

      if (!block) {
        return false;
      }

      // `silent` probes whether the block is valid without consuming lines.
      if (silent) {
        return true;
      }

      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.content = block.content;
      token.markup = delimiter.open;
      token.map = [startLine, block.closeLine + 1];
      state.line = block.closeLine + 1;

      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
}

/** Generic in the input so the caller's concrete parser type is preserved. */
export function registerChatMarkdownRules<Parser extends MarkdownItLike>(
  parser: Parser,
): Parser {
  registerTaskLists(parser);
  registerMathBlocks(parser);

  return parser;
}