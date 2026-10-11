import { describe, expect, it } from "vitest";

import { parseIndexRanges } from "@/modules/documents/ranges";

describe("parseIndexRanges", () => {
  it("parses 1-based ranges by default", () => {
    expect(parseIndexRanges("1-3,5,7-9", 10, "page")).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
      { start: 7, end: 9 },
    ]);
  });

  it("parses 0-based ranges for sections", () => {
    expect(
      parseIndexRanges("0-2,4", 5, "section", { zeroBased: true }),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 4 },
    ]);
    expect(
      parseIndexRanges("3-", 5, "section", { zeroBased: true }),
    ).toEqual([{ start: 3, end: 4 }]);
    expect(
      parseIndexRanges("-1", 5, "section", { zeroBased: true }),
    ).toEqual([{ start: 0, end: 1 }]);
  });

  it("supports open-ended ranges and whitespace", () => {
    expect(parseIndexRanges("2-, -4", 10, "page")).toEqual([
      { start: 2, end: 10 },
      { start: 1, end: 4 },
    ]);
  });

  it("supports 'all'", () => {
    expect(parseIndexRanges("all", 7, "page")).toEqual([{ start: 1, end: 7 }]);
    expect(
      parseIndexRanges("all", 7, "section", { zeroBased: true }),
    ).toEqual([{ start: 0, end: 6 }]);
  });

  it("rejects ranges outside the item count with the label", () => {
    expect(() => parseIndexRanges("1-11", 10, "page")).toThrow(/outside the pages/);
    expect(() =>
      parseIndexRanges("0-9", 5, "section", { zeroBased: true }),
    ).toThrow(/outside the sections \(0-4\)/);
    expect(() =>
      parseIndexRanges("-5", 3, "section", { zeroBased: true }),
    ).toThrow(/outside/);
  });

  it("rejects reversed and malformed ranges", () => {
    expect(() => parseIndexRanges("9-2", 10, "page")).toThrow(/outside/);
    expect(() => parseIndexRanges("banana", 10, "page")).toThrow(
      /Invalid page range/,
    );
    expect(() => parseIndexRanges("", 10, "section")).toThrow(/required/);
    expect(() => parseIndexRanges("0--1", 5, "section")).toThrow(
      /Invalid section range/,
    );
  });

  it("reports an error when there is nothing to split", () => {
    expect(() => parseIndexRanges("all", 0, "section")).toThrow(
      /no sections to split/,
    );
  });
});
