import { afterEach, describe, expect, it } from "vitest";

import {
  CHROMA_KEY_DEFAULTS,
  VIDEO_CHROMA_KEY_SCRIPT,
} from "@/modules/preview/video-chroma-key";

type ChromaKeyApi = {
  drawKeyed: (
    ctx: unknown,
    video: unknown,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    opts: unknown,
  ) => boolean;
  defaults: { similarity: number; smoothness: number; spill: number };
};

function makeCtx(w: number, h: number) {
  return {
    pixels: new Uint8ClampedArray(w * h * 4),
    draws: [] as unknown[],
    drawImage(src: unknown) {
      this.draws.push(src);
      const canvas = src as {
        __ctx?: { pixels: Uint8ClampedArray };
        __frame?: Uint8ClampedArray;
      };
      // Video stub carries its frame; canvas stub carries its 2d buffer.
      const srcPixels = canvas.__frame ?? canvas.__ctx?.pixels;
      if (srcPixels) this.pixels.set(srcPixels.subarray(0, this.pixels.length));
    },
    getImageData() {
      return { data: this.pixels };
    },
    putImageData() {},
  };
}

function makeCanvas(w: number, h: number) {
  const canvas = {
    __ctx: makeCtx(w, h),
    _w: w,
    _h: h,
    get width() {
      return this._w;
    },
    set width(v: number) {
      this._w = v;
      this.__ctx = makeCtx(v, this._h);
    },
    get height() {
      return this._h;
    },
    set height(v: number) {
      this._h = v;
      this.__ctx = makeCtx(this._w, v);
    },
    getContext() {
      return this.__ctx;
    },
  };
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function solidFrame(w: number, h: number, r: number, g: number, b: number) {
  const frame = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < frame.length; i += 4) {
    frame[i] = r;
    frame[i + 1] = g;
    frame[i + 2] = b;
    frame[i + 3] = 255;
  }
  return frame;
}

function installStubs() {
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  g.document = {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error("unexpected element " + tag);
      return makeCanvas(300, 150);
    },
  };
  new Function(VIDEO_CHROMA_KEY_SCRIPT)();
  return (g.window as { __mobileAgentChromaKey: ChromaKeyApi })
    .__mobileAgentChromaKey;
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
});

function alphaOf(canvas: ReturnType<typeof makeCanvas>) {
  const out: number[] = [];
  for (let i = 3; i < canvas.__ctx.pixels.length; i += 4) {
    out.push(canvas.__ctx.pixels[i]);
  }
  return out;
}

describe("VIDEO_CHROMA_KEY_SCRIPT", () => {
  it("stays a plain string with no template markers or backslashes", () => {
    expect(VIDEO_CHROMA_KEY_SCRIPT).not.toContain("`");
    expect(VIDEO_CHROMA_KEY_SCRIPT).not.toContain("${");
    expect(VIDEO_CHROMA_KEY_SCRIPT).not.toContain("\\");
  });

  it("exposes drawKeyed with defaults matching the TS constants", () => {
    const api = installStubs();
    expect(typeof api.drawKeyed).toBe("function");
    expect(api.defaults).toEqual({ ...CHROMA_KEY_DEFAULTS });
  });

  it("keys pure green to fully transparent", () => {
    const api = installStubs();
    const main = makeCanvas(2, 2);
    const video = { readyState: 2, __frame: solidFrame(2, 2, 0, 255, 0) };

    expect(api.drawKeyed(main.getContext(), video, 0, 0, 2, 2, { key: "#00ff00" })).toBe(
      true,
    );
    const drawn = main.getContext().draws[0] as ReturnType<typeof makeCanvas>;
    expect(alphaOf(drawn)).toEqual([0, 0, 0, 0]);
  });

  it("leaves far colors fully opaque with rgb untouched", () => {
    const api = installStubs();
    const main = makeCanvas(2, 1);
    const video = { readyState: 2, __frame: solidFrame(2, 1, 200, 30, 30) };

    expect(api.drawKeyed(main.getContext(), video, 0, 0, 2, 1, { key: "#00ff00" })).toBe(
      true,
    );
    const drawn = main.getContext().draws[0] as ReturnType<typeof makeCanvas>;
    expect(alphaOf(drawn)).toEqual([255, 255]);
    // spillVal is 1 far from the key, so mix() returns channels exactly.
    expect(Array.from(drawn.__ctx.pixels.subarray(0, 3))).toEqual([200, 30, 30]);
  });

  it("keys blue screens with a blue key", () => {
    const api = installStubs();
    const main = makeCanvas(1, 1);
    const video = { readyState: 2, __frame: solidFrame(1, 1, 0, 0, 255) };

    expect(api.drawKeyed(main.getContext(), video, 0, 0, 1, 1, { key: "#0000ff" })).toBe(
      true,
    );
    const drawn = main.getContext().draws[0] as ReturnType<typeof makeCanvas>;
    expect(alphaOf(drawn)).toEqual([0]);
  });

  it("ramps alpha through the smoothness band, monotonically", () => {
    const api = installStubs();
    // UV(gray) is 0, so mixing green toward mid-gray by a gray fraction t
    // puts the pixel at UV distance t * ~0.534 from the green key:
    // t=0.5 -> 0.267 (cut), t=0.749 -> ~0.40 (mid-ramp at defaults),
    // t=0.9 -> ~0.48 (opaque).
    const alphas = [0.5, 0.749, 0.9].map((t) => {
      const main = makeCanvas(1, 1);
      const v = Math.round(255 * 0.5 * t);
      const gv = Math.round(255 * (1 - 0.5 * t));
      const video = { readyState: 2, __frame: solidFrame(1, 1, v, gv, v) };
      expect(
        api.drawKeyed(main.getContext(), video, 0, 0, 1, 1, { key: "#00ff00" }),
      ).toBe(true);
      const drawn = main.getContext().draws[0] as ReturnType<typeof makeCanvas>;
      return alphaOf(drawn)[0];
    });
    expect(alphas[0]).toBe(0);
    expect(alphas[1]).toBeGreaterThan(0);
    expect(alphas[1]).toBeLessThan(255);
    expect(alphas[2]).toBe(255);
  });

  it("despills green fringe toward luma", () => {
    const api = installStubs();
    const main = makeCanvas(1, 1);
    const video = { readyState: 2, __frame: solidFrame(1, 1, 32, 223, 32) };

    expect(api.drawKeyed(main.getContext(), video, 0, 0, 1, 1, { key: "#00ff00" })).toBe(
      true,
    );
    const drawn = main.getContext().draws[0] as ReturnType<typeof makeCanvas>;
    const [r, g, b] = Array.from(drawn.__ctx.pixels.subarray(0, 3));
    // Near-key pixel: green pulled down, red/blue pulled up toward luma.
    expect(g).toBeLessThan(223);
    expect(r).toBeGreaterThan(32);
    expect(b).toBeGreaterThan(32);
  });

  it("rejects unparseable key colors without painting", () => {
    const api = installStubs();
    for (const key of ["green", "#fff", "#gggggg", "", null, undefined, 42]) {
      const main = makeCanvas(1, 1);
      const video = { readyState: 2, __frame: solidFrame(1, 1, 0, 255, 0) };
      expect(
        api.drawKeyed(main.getContext(), video, 0, 0, 1, 1, { key }),
      ).toBe(false);
      expect(main.getContext().draws).toHaveLength(0);
    }
  });

  it("skips video that is not ready instead of throwing", () => {
    const api = installStubs();
    const main = makeCanvas(1, 1);
    const video = { readyState: 1, __frame: solidFrame(1, 1, 0, 255, 0) };
    expect(
      api.drawKeyed(main.getContext(), video, 0, 0, 1, 1, { key: "#00ff00" }),
    ).toBe(false);
    expect(main.getContext().draws).toHaveLength(0);
  });

  it("reuses the offscreen canvas across sizes", () => {
    const api = installStubs();
    const main = makeCanvas(4, 4);
    const red = { readyState: 2, __frame: solidFrame(4, 4, 255, 0, 0) };
    const green = { readyState: 2, __frame: solidFrame(2, 2, 0, 255, 0) };

    expect(api.drawKeyed(main.getContext(), red, 0, 0, 4, 4, { key: "#00ff00" })).toBe(
      true,
    );
    expect(api.drawKeyed(main.getContext(), green, 0, 0, 2, 2, { key: "#00ff00" })).toBe(
      true,
    );
    const second = main.getContext().draws[1] as ReturnType<typeof makeCanvas>;
    expect(alphaOf(second)).toEqual([0, 0, 0, 0]);
  });
});
