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
    clears: [] as unknown[][],
    clearRect(...args: unknown[]) {
      this.clears.push(args);
    },
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
    getContext(kind?: string, attrs?: unknown): ReturnType<typeof makeCtx> {
      // No WebGL in this harness by default: forces the CPU path. Tests
      // that need the GPU path install a fake via installStubs({ webgl }).
      if (kind === "webgl") {
        (canvas as { __attrs?: unknown }).__attrs = attrs;
        return this.__gl as unknown as ReturnType<typeof makeCtx>;
      }
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
  const canvases: (ReturnType<typeof makeCanvas> & { __attrs?: unknown })[] = [];
  g.document = {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error("unexpected element " + tag);
      const canvas = makeCanvas(300, 150);
      canvases.push(canvas);
      if (opts.webgl) canvas.__gl = opts.webgl();
      return canvas;
    },
  };
  new Function(VIDEO_CHROMA_KEY_SCRIPT)();
  const api = (g.window as { __mobileAgentChromaKey: ChromaKeyApi })
    .__mobileAgentChromaKey;
  return Object.assign(api, { canvases });
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
    uniform4f(_loc: unknown, a: unknown, b: unknown, c: unknown, d: unknown) {
      calls.push({ name: "uniform4f", args: [a, b, c, d] });
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

  it("caches GL unavailability instead of re-running init", () => {    let creations = 0;
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

  it("bridges the backend once per transition via postMessage", () => {
    const posted: unknown[] = [];
    const api = installStubs();
    (globalThis.window as unknown as Record<string, unknown>).ReactNativeWebView = {
      postMessage: (data: string) => {
        posted.push(JSON.parse(data));
      },
    };
    const main = makeCanvas(2, 2);
    const video = { readyState: 2, __frame: solidFrame(2, 2, 0, 255, 0) };
    expect(api.drawKeyed(main.getContext(), video, 0, 0, 2, 2, { key: "#00ff00" })).toBe(
      true,
    );
    expect(api.drawKeyed(main.getContext(), video, 0, 0, 2, 2, { key: "#00ff00" })).toBe(
      true,
    );
    expect(posted).toEqual([
      { type: "mobileAgentVideoChromaBackend", backend: "cpu", reason: "no-webgl-context" },
    ]);
  });

  it("keys green-excess on the CPU path with the studio ramp", () => {
    const api = installStubs();
    const main = makeCanvas(3, 1);
    // x=0 pure green (excess 255 -> transparent), x=1 gray (opaque),
    // x=2 mild excess 20 (mid ramp + green clamp).
    const video = {
      readyState: 2,
      __frame: new Uint8ClampedArray([0, 255, 0, 255, 100, 100, 100, 255, 60, 80, 50, 255]),
    };
    expect(api.drawKeyed(main.getContext(), video, 0, 0, 3, 1, { mode: "excess" })).toBe(true);
    expect(api.backend).toBe("cpu");
    const px = main.getContext().pixels;
    expect(px[3]).toBe(0);
    expect(px[7]).toBe(255);
    // Replace semantics: the target is cleared before the keyed layer lands.
    expect(main.getContext().clears).toEqual([[0, 0, 3, 1]]);
    // excess 20: alpha = round(255 * (1 - 12/25)) = round(132.6) = 133.
    expect(px[11]).toBe(133);
    // green clamped to max(r,b)+6 = 66.
    expect(px[9]).toBe(66);
    expect(px[8]).toBe(60);
    expect(px[10]).toBe(50);
  });

  it("accepts a canvas source and ignores the key color in excess mode", () => {
    const api = installStubs();
    const main = makeCanvas(1, 1);
    const src = makeCanvas(1, 1);
    src.getContext().pixels.set([0, 255, 0, 255]);
    expect(api.drawKeyed(main.getContext(), src, 0, 0, 1, 1, { mode: "excess" })).toBe(true);
    expect(main.getContext().pixels[3]).toBe(0);
  });

  it("takes the GPU path for excess mode with mode uniform set", () => {
    let gl: FakeGl | null = null;
    const api = installStubs({
      webgl: () => {
        gl = makeFakeGl();
        return gl;
      },
    });
    const main = makeCanvas(2, 2);
    const video = { readyState: 2, __frame: solidFrame(2, 2, 0, 255, 0) };
    expect(api.drawKeyed(main.getContext(), video, 0, 0, 2, 2, { mode: "excess" })).toBe(true);
    expect(api.backend).toBe("webgl");
    expect(gl).not.toBeNull();
    // Straight-alpha buffer: keyed-out regions must composite as transparent,
    // not opaque white, when drawn over the scene.
    expect(api.canvases[0].__attrs).toMatchObject({ premultipliedAlpha: false });
    const modeUniform = gl!.calls.filter((c) => c.name === "uniform1f").map((c) => c.args[0]);
    expect(modeUniform).toContain(1);
    expect(main.getContext().draws).toHaveLength(1);
    expect(main.getContext().clears).toEqual([[0, 0, 2, 2]]);
  });

  it("samples the full source by default and crops via srcRect", () => {
    let gl: FakeGl | null = null;
    const api = installStubs({
      webgl: () => {
        gl = makeFakeGl();
        return gl;
      },
    });
    const main = makeCanvas(2, 2);
    const video = {
      readyState: 2,
      videoWidth: 100,
      videoHeight: 50,
      __frame: solidFrame(2, 2, 0, 255, 0),
    };
    expect(api.drawKeyed(main.getContext(), video, 0, 0, 2, 2, { mode: "excess" })).toBe(true);
    const rects = gl!.calls.filter((c) => c.name === "uniform4f").map((c) => c.args);
    expect(rects).toEqual([[0, 0, 1, 1]]);
    expect(
      api.drawKeyed(main.getContext(), video, 0, 0, 2, 2, {
        mode: "excess",
        sx: 10,
        sy: 5,
        sw: 80,
        sh: 40,
      }),
    ).toBe(true);
    const rects2 = gl!.calls.filter((c) => c.name === "uniform4f").map((c) => c.args);
    expect(rects2[rects2.length - 1]).toEqual([0.1, 0.1, 0.8, 0.8]);
  });

  it("crops on the CPU fallback path with the source rect", () => {
    const api = installStubs();
    const main = makeCanvas(2, 1);
    const video = { readyState: 2, __frame: solidFrame(4, 1, 0, 255, 0) };
    expect(
      api.drawKeyed(main.getContext(), video, 0, 0, 2, 1, {
        mode: "excess",
        sx: 0,
        sy: 0,
        sw: 4,
        sh: 1,
      }),
    ).toBe(true);
    expect(api.backend).toBe("cpu");
  });
});
