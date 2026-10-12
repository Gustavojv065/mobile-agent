import MarkdownIt from "#app-markdown-it";
import { describe, expect, it } from "vitest";

import { registerChatMarkdownRules } from "@/modules/chat/markdown-rules";

type AppToken = {
  attrs: [string, string][] | null;
  block?: boolean;
  children: AppToken[] | null;
  content: string;
  type: string;
};

const PARSER = registerChatMarkdownRules(
  MarkdownIt({ breaks: true, linkify: true, typographer: false }),
);

function parse(source: string): AppToken[] {
  return PARSER.parse(source, {}) as unknown as AppToken[];
}

function attr(token: AppToken | undefined, name: string): string | undefined {
  return token?.attrs?.find(([key]) => key === name)?.[1];
}

describe("task list markdown rule", () => {
  it("marks a checked box and strips the marker", () => {
    const tokens = parse("- [x] done");
    const item = tokens.find((token) => token.type === "list_item_open");
    const inline = tokens.find((token) => token.type === "inline");

    expect(attr(item, "task")).toBe("true");
    expect(attr(item, "checked")).toBe("true");
    expect(inline?.children?.[0]?.content).toBe("done");
  });

  it("marks an unchecked box", () => {
    const tokens = parse("- [ ] todo");
    const item = tokens.find((token) => token.type === "list_item_open");

    expect(attr(item, "task")).toBe("true");
    expect(attr(item, "checked")).toBe("false");
    expect(tokens.find((token) => token.type === "inline")?.children?.[0]?.content).toBe(
      "todo",
    );
  });

  it("accepts an uppercase X", () => {
    const tokens = parse("- [X] done");
    const item = tokens.find((token) => token.type === "list_item_open");

    expect(attr(item, "checked")).toBe("true");
  });

  it("leaves ordinary items alone", () => {
    const tokens = parse("- plain");
    const item = tokens.find((token) => token.type === "list_item_open");

    expect(attr(item, "task")).toBeUndefined();
    expect(attr(item, "checked")).toBeUndefined();
    expect(tokens.find((token) => token.type === "inline")?.children?.[0]?.content).toBe(
      "plain",
    );
  });

  it("only matches a marker at the very start", () => {
    const tokens = parse("- see [x] notes");
    const item = tokens.find((token) => token.type === "list_item_open");

    expect(attr(item, "task")).toBeUndefined();
    expect(tokens.find((token) => token.type === "inline")?.children?.[0]?.content).toBe(
      "see [x] notes",
    );
  });

  it("does not mark ordered list items", () => {
    const tokens = parse("1. [x] done");
    const item = tokens.find((token) => token.type === "list_item_open");

    expect(attr(item, "task")).toBeUndefined();
  });

  it("handles nested lists independently", () => {
    const tokens = parse("- [ ] outer\n  - [x] inner");
    const items = tokens.filter((token) => token.type === "list_item_open");

    expect(items).toHaveLength(2);
    expect(attr(items[0], "checked")).toBe("false");
    expect(attr(items[1], "checked")).toBe("true");
  });

  it("requires whitespace after the marker", () => {
    const tokens = parse("- [x]done");
    const item = tokens.find((token) => token.type === "list_item_open");

    expect(attr(item, "task")).toBeUndefined();
  });
});

describe("math block markdown rule", () => {
  function mathToken(tokens: AppToken[]): AppToken | undefined {
    return tokens.find((token) => token.type === "math_block");
  }

  it("captures a fenced $$ block on its own lines", () => {
    const token = mathToken(parse("$$\nE = mc^2\n$$"));

    expect(token?.content).toBe("E = mc^2");
  });

  it("captures a single-line $$ block", () => {
    const token = mathToken(parse("$$x^2 + y^2$$"));

    expect(token?.content).toBe("x^2 + y^2");
  });

  it("captures a \\[ \\] block", () => {
    const token = mathToken(parse("\\[\n\\int_0^1 x\\,dx\n\\]"));

    expect(token?.content).toBe("\\int_0^1 x\\,dx");
  });

  it("preserves multi-line TeX", () => {
    const token = mathToken(parse("$$\na = b \\\\\nc = d\n$$"));

    expect(token?.content).toBe("a = b \\\\\nc = d");
  });

  it("emits a leaf block token", () => {
    const tokens = parse("$$\nx\n$$");
    const token = mathToken(tokens);

    expect(token?.block).toBe(true);
    expect(token?.children ?? null).toBeNull();
  });

  it("does not tokenize an unclosed block", () => {
    const tokens = parse("$$\nnever closed");

    expect(mathToken(tokens)).toBeUndefined();
  });

  it("leaves inline $math$ as ordinary text", () => {
    const tokens = parse("value $x^2$ here");

    expect(mathToken(tokens)).toBeUndefined();
    expect(tokens.find((token) => token.type === "inline")?.children?.[0]?.content).toBe(
      "value $x^2$ here",
    );
  });
});