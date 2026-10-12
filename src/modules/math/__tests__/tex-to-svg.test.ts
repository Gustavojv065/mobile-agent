import { describe, expect, it } from "vitest";

import { renderMathToSvg } from "@/modules/math/tex-to-svg";

const OPTIONS = { color: "#123456", fontSize: 16 };

describe("renderMathToSvg", () => {
  it("renders block math into a self-contained svg", () => {
    const result = renderMathToSvg("E = mc^2", OPTIONS);

    expect(result).not.toBeNull();
    expect(result?.svg).toContain("<path");
    expect(result?.svg.startsWith("<svg")).toBe(true);
    expect(result?.width).toBeGreaterThan(0);
    expect(result?.height).toBeGreaterThan(0);
  });

  it("never emits <use>/<defs>, which SvgXml cannot resolve", () => {
    const result = renderMathToSvg("\\frac{a}{b} + \\sqrt{x}", OPTIONS);

    expect(result?.svg).not.toContain("<use");
    expect(result?.svg).not.toContain("<defs");
  });

  it("substitutes currentColor with the requested colour", () => {
    const result = renderMathToSvg("\\sum_{i=0}^{n} i", {
      color: "#abcdef",
      fontSize: 16,
    });

    expect(result?.svg).toContain("#abcdef");
    expect(result?.svg).not.toContain("currentColor");
  });

  it("strips MathJax bookkeeping attributes", () => {
    const result = renderMathToSvg("x^2", OPTIONS);

    expect(result?.svg).not.toContain("data-mml-node");
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(renderMathToSvg("", OPTIONS)).toBeNull();
    expect(renderMathToSvg("   \n  ", OPTIONS)).toBeNull();
  });

  it("memoizes repeated renders", () => {
    const first = renderMathToSvg("a+b", OPTIONS);
    const second = renderMathToSvg("a+b", OPTIONS);

    expect(second).toBe(first);
  });

  it("scales geometry with the requested font size", () => {
    const small = renderMathToSvg("x", { color: "#000000", fontSize: 16 });
    const large = renderMathToSvg("x", { color: "#000000", fontSize: 32 });

    expect(large?.width).toBeCloseTo((small?.width ?? 0) * 2, 5);
    expect(large?.height).toBeCloseTo((small?.height ?? 0) * 2, 5);
  });
});
