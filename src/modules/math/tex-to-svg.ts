/**
 * TeX → SVG rendering for block math.
 *
 * We render with MathJax's SVG output using `fontCache: "none"` so every glyph
 * is emitted as a self-contained inline `<path>`. The other font-cache modes
 * emit `<use xlink:href="#...">` references into a shared `<defs>`, which
 * `react-native-svg`'s `SvgXml` cannot resolve. With `"none"` the output drops
 * straight into `<SvgXml>` with no runtime or WebView.
 *
 * Everything here is synchronous and framework-agnostic so it can run (and be
 * tested) in plain Node.
 */

import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";

export type MathSvg = {
  /** Rendered height in density-independent pixels. */
  height: number;
  /** A self-contained `<svg>` string safe for `SvgXml`. */
  svg: string;
  /** Rendered width in density-independent pixels. */
  width: number;
};

export type RenderMathOptions = {
  /** Stroke/fill colour applied in place of `currentColor`. */
  color: string;
  /** Font size in density-independent pixels; drives the SVG scale. */
  fontSize: number;
};

// MathJax lays out in a coordinate space of 1000 units per em.
const UNITS_PER_EM = 1000;
const CACHE_LIMIT = 200;

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const texInput = new TeX({ packages: AllPackages });
const svgOutput = new SVG({ fontCache: "none" });
const mathDocument = mathjax.document("", {
  InputJax: texInput,
  OutputJax: svgOutput,
});

const cache = new Map<string, MathSvg | null>();

/**
 * Rewrites MathJax's `<svg>` markup into something `SvgXml` renders cleanly:
 * keeps the `viewBox`, drops the wrapper's `style`/namespace/library attributes,
 * strips MathJax's `data-mml-node` bookkeeping, and swaps `currentColor` for an
 * explicit colour (react-native-svg only resolves `currentColor` from a `color`
 * prop it never receives here).
 */
function toMathSvg(
  outerHtml: string,
  fontSize: number,
  color: string,
): MathSvg | null {
  const match = outerHtml.match(
    /<svg\b[^>]*viewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>/,
  );

  if (!match) {
    return null;
  }

  const [, viewBox, rawInner] = match;
  const [, , boxWidth, boxHeight] = viewBox.trim().split(/\s+/).map(Number);

  if (!Number.isFinite(boxWidth) || !Number.isFinite(boxHeight)) {
    return null;
  }

  const width = (boxWidth / UNITS_PER_EM) * fontSize;
  const height = (boxHeight / UNITS_PER_EM) * fontSize;

  if (width <= 0 || height <= 0) {
    return null;
  }

  const inner = rawInner
    .replace(/\sdata-[a-z-]+="[^"]*"/g, "")
    .replace(/currentColor/g, color);

  return {
    height,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${inner}</svg>`,
    width,
  };
}

/**
 * Renders a TeX string to a self-contained SVG block.
 *
 * Returns `null` when the source is empty or MathJax cannot produce geometry,
 * so callers can fall back to showing the raw TeX. Successful renders are
 * memoized (including on failure) to keep streaming and re-renders cheap.
 */
export function renderMathToSvg(
  tex: string,
  options: RenderMathOptions,
): MathSvg | null {
  const source = tex.trim();

  if (!source) {
    return null;
  }

  const key = `${options.fontSize}\u0000${options.color}\u0000${source}`;
  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  let result: MathSvg | null = null;

  try {
    const node = mathDocument.convert(source, {
      display: true,
      em: options.fontSize,
      ex: options.fontSize * 0.5,
      // Generous width: block math should wrap only on explicit breaks.
      containerWidth: 80 * 16,
    });

    result = toMathSvg(adaptor.outerHTML(node), options.fontSize, options.color);
  } catch {
    result = null;
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;

    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }

  cache.set(key, result);

  return result;
}
