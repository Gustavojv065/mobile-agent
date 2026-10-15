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
  backend: string;
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
    __gl: null as FakeGl | null,
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
    getContext(kind?: string): ReturnType<typeof makeCtx> {
      // No WebGL in this harness by default: forces the CPU path. Tests
      // that need the GPU path install a fake via installStubs({ webgl }).
      if (kind === "webgl") return this.__gl as unknown as ReturnType<typeof makeCtx>;
      return this.__ctx;
    },
  };
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

type FakeGlOptions = {
  /** Return a fake WebGL context from canvas.getContext('webgl'). */
  webgl?: () => FakeGl;
  failUpload?: boolean;
};

type FakeGl = Record<string, unknown> & {
  calls: { name: string; args: unknown[] }[];
  uniforms: Record<string, unknown[]>;
};

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

function installStubs(opts: FakeGlOptions = {}) {
  const g = globalThis as Record<string, unknown>;
  g.window = {};
  g.document = {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error("unexpected element " + tag);
      const canvas = makeCanvas(300, 150);
      if (opts.webgl) canvas.__gl = opts.webgl();
      return canvas;
    },
  };
  new Function(VIDEO_CHROMA_KEY_SCRIPT)();
  return (g.window as { __mobileAgentChromaKey: ChromaKeyApi })
    .__mobileAgentChromaKey;
}

const GL_IDS = {
  VERTEX_SHADER: 1,
  FRAGMENT_SHADER: 2,
  COMPILE_STATUS: 10,
  LINK_STATUS: 11,
  ARRAY_BUFFER: 20,
  STATIC_DRAW: 21,
  TEXTURE_2D: 30,
  CLAMP_TO_EDGE: 31,
  LINEAR: 32,
  RGB: 33,
  UNSIGNED_BYTE: 34,
  UNPACK_FLIP_Y_WEBGL: 35,
  FLOAT: 36,
  TRIANGLE_STRIP: 37,
};

/** Minimal WebGL stub: records calls, pretends compile/link succeed. */
function makeFakeGl(failUpload = false): FakeGl {
  const calls: { name: string; args: unknown[] }[] = [];
  const uniforms: Record<string, unknown[]> = {};
  let nextId = 100;
  const gl: FakeGl = {
    calls,
    uniforms,
    ...GL_IDS,
    addEventListener() {},
    createShader() {
      return nextId++;
    },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() {
      return true;
    },
    createProgram() {
      return nextId++;
    },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() {
      return true;
    },
    useProgram() {},
    createBuffer() {
      return nextId++;
    },
    bindBuffer(...args: unknown[]) {
      calls.push({ name: "bindBuffer", args });
    },
    bufferData() {},
    createTexture() {
      return nextId++;
    },
    bindTexture() {},
    texParameteri() {},
    pixelStorei() {},
    texImage2D(...args: unknown[]) {
      calls.push({ name: "texImage2D", args });
      if (failUpload) throw new Error("upload failed");
    },
    getAttribLocation() {
      return 0;
    },
    getUniformLocation(_prog: unknown, name: unknown) {
      return `loc:${String(name)}`;
    },
    uniform1i(_loc: unknown, v: unknown) {
      uniforms.oneI = [v];
    },
    uniform2f(_loc: unknown, u: unknown, v: unknown) {
      uniforms.keyUv = [u, v];
    },
    uniform1f(_loc: unknown, v: unknown) {
      calls.push({ name: "uniform1f", args: [v] });
    },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    viewport() {},
    drawArrays(...args: unknown[]) {
      calls.push({ name: "drawArrays", args });
    },
  };
  return gl;
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

  it("reports cpu backend when WebGL is unavailable", () => {
    const api = installStubs();
    const main = makeCanvas(2, 2);
    const video = { readyState: 2, __frame: solidFrame(2, 2, 0, 255, 0) };
    expect(api.drawKeyed(main.getContext(), video, 0, 0, 2, 2, { key: "#00ff00" })).toBe(
      true,
    );
    expect(api.backend).toBe("cpu");
  });

  it("takes the GPU path with correct key uniforms when WebGL exists", () => {
    let gl: FakeGl | null = null;
    const api = installStubs({
      webgl: () => {
        gl = makeFakeGl();
        return gl;
      },
    });
    const main = makeCanvas(2, 2);
    const video = { readyState: 2, __frame: solidFrame(2, 2, 0, 255, 0) };
    expect(
      api.drawKeyed(main.getContext(), video, 5, 7, 2, 2, {
        key: "#00ff00",
        similarity: 0.4,
        smoothness: 0.2,
        spill: 0.3,
      }),
    ).toBe(true);
    expect(api.backend).toBe("webgl");
    expect(gl).not.toBeNull();
    // Green key UV: u = -0.331, v = -0.419.
    const [u, v] = gl!.uniforms.keyUv as number[];
    expect(u).toBeCloseTo(-0.331, 3);
    expect(v).toBeCloseTo(-0.419, 3);
    // Sized upload + fullscreen draw + composite onto the scene canvas.
    const upload = gl!.calls.find((c) => c.name === "texImage2D");
    expect(upload).toBeDefined();
    expect(gl!.calls.some((c) => c.name === "drawArrays")).toBe(true);
    expect(main.getContext().draws).toHaveLength(1);
  });

  it("falls back to CPU pixels when the GL upload throws", () => {
    const api = installStubs({ webgl: () => makeFakeGl(true) });
    const main = makeCanvas(2, 2);
    const video = { readyState: 2, __frame: solidFrame(2, 2, 0, 255, 0) };
    expect(api.drawKeyed(main.getContext(), video, 0, 0, 2, 2, { key: "#00ff00" })).toBe(
      true,
    );
    expect(api.backend).toBe("cpu");
    const drawn = main.getContext().draws[0] as ReturnType<typeof makeCanvas>;
    expect(alphaOf(drawn)).toEqual([0, 0, 0, 0]);
  });

  it("caches GL unavailability instead of re-running init", () => {
    let creations = 0;
    const g = globalThis as Record<string, unknown>;
    g.window = {};
    g.document = {
      createElement: (tag: string) => {
        if (tag !== "canvas") throw new Error("unexpected element " + tag);
        creations += 1;
        // No WebGL context: forces CPU both times.
        return makeCanvas(300, 150);
      },
    };
    new Function(VIDEO_CHROMA_KEY_SCRIPT)();
    const api = (g.window as { __mobileAgentChromaKey: ChromaKeyApi })
      .__mobileAgentChromaKey;
    const main = makeCanvas(1, 1);
    const video = { readyState: 2, __frame: solidFrame(1, 1, 200, 30, 30) };
    expect(api.drawKeyed(main.getContext(), video, 0, 0, 1, 1, { key: "#00ff00" })).toBe(
      true,
    );
    expect(api.drawKeyed(main.getContext(), video, 0, 0, 1, 1, { key: "#00ff00" })).toBe(
      true,
    );
    // First draw: GL canvas attempt + CPU offscreen = 2. Second draw: zero
    // (GL cached unavailable, CPU offscreen reused).
    expect(creations).toBe(2);
    expect(api.backend).toBe("cpu");
  });
});
