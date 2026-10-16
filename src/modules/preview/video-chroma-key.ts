/**
 * In-page chroma key (green/blue screen) helper for video scenes.
 *
 * A `clip:` layer shot against a flat screen is keyed at draw time: the
 * scene paints the `<video>` frame through `window.__mobileAgentChromaKey`
 * onto the scene canvas, and both preview stills and the export capture
 * carry the keyed result automatically — no preprocessing tool, no native
 * module, no rebuild. The math is a port of the OBS Studio chroma key
 * filter (via Jim Fisher's WebGL port): distance in UV chrominance space
 * from the key color, with `similarity` (cut threshold), `smoothness`
 * (edge ramp), and `spill` (despill strength) params.
 *
 * Two backends, one contract. `drawKeyed` tries the GPU first: the video
 * frame uploads straight into a GPU texture (hardware decode path, zero
 * readback) and a fragment shader keys it — no `getImageData` loop. When
 * WebGL is missing, shader compile fails, the context is lost, or any GL
 * call throws, it falls back to the CPU pixel loop for that draw. Backend
 * used by the last successful draw is visible as `api.backend`
 * (`'webgl'` | `'cpu'`) for device measurement. Numbers clamp instead of
 * throwing (agent tuning must never crash a render); only an unparseable
 * key color or an unready video skips the draw (returns false so the scene
 * can fall back to a plain drawImage).
 *
 * Plain ES5 string (no backticks, template markers, or backslashes) like
 * the recorder string, and Node-testable with canvas stubs.
 */

export type ChromaKeyOptions = {
  /** Screen color as `#rrggbb` (green `#00ff00`, blue `#0000ff`). */
  key: string;
  /** UV distance below which a pixel is fully transparent. */
  similarity?: number;
  /** Ramp width from transparent to opaque (edge softness). */
  smoothness?: number;
  /** Ramp width of the despill (green-fringe removal). */
  spill?: number;
  /**
   * `'excess'` selects the green-excess key (exact port of the hand-rolled
   * studio loop, key color ignored): opaque at green-excess <= 8, linear
   * alpha ramp over 8..33, green capped at max(r,b)+6. Accepts a video
   * element or a canvas (e.g. a pre-cropped frame) as the source.
   */
  mode?: "excess";
  /**
   * Optional source crop in source pixels (drawImage-style `sx, sy, sw, sh`).
   * Keys straight from the video element with no intermediate canvas, so
   * the key input never passes through an extra resample. Omit for the
   * full source frame.
   */
  sx?: number;
  sy?: number;
  sw?: number;
  sh?: number;
};

/** Starting points — tune per clip with previewScene stills, never ship blind. */
export const CHROMA_KEY_DEFAULTS = {
  similarity: 0.35,
  smoothness: 0.1,
  spill: 0.15,
} as const;

export const VIDEO_CHROMA_KEY_SCRIPT = `(function () {
  var offscreen = null;
  var glCanvas = null;
  var glState = null;

  // premultipliedAlpha:false is load-bearing: the keyed canvas is drawn
  // over the scene with drawImage, which composites straight alpha. With
  // the default premultiplied buffer this WebView composites keyed-out
  // regions as opaque white instead of transparent.
  var GL_ATTRS = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false };
  // GLSL is whitespace-insensitive, so single-line sources keep the injected
  // string free of backslashes. ES 1.00 builtins only (GL ES 2.0 everywhere).
  // uMode selects the key math: 0 = UV-distance (OBS port), 1 = green-excess
  // (exact port of the hand-rolled studio loop: ex = g - max(r,b), opaque at
  // ex <= 8, linear alpha ramp over 8..33, green capped at max(r,b)+6).
  // uUvRect is the source crop in top-left-origin normalized coords
  // (sx/VW, sy/VH, sw/VW, sh/VH); (0,0,1,1) samples the whole source.
  // The Y flip accounts for UNPACK_FLIP_Y_WEBGL so scenes pass plain
  // drawImage-style rects.
  var GL_VS = 'attribute vec2 aPos; varying vec2 vUv; void main() { vUv = vec2(aPos.x * 0.5 + 0.5, aPos.y * 0.5 + 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }';
  var GL_FS = 'precision mediump float; varying vec2 vUv; uniform sampler2D uVideo; uniform vec2 uKeyUv; uniform float uSimilarity; uniform float uSmoothness; uniform float uSpill; uniform float uMode; uniform vec4 uUvRect; void main() { vec2 uv = vec2(uUvRect.x + vUv.x * uUvRect.z, (1.0 - uUvRect.y - uUvRect.w) + vUv.y * uUvRect.w); vec4 c = texture2D(uVideo, uv); if (uMode > 0.5) { float ex = c.g - max(c.r, c.b); float a = 1.0 - clamp((ex - 8.0 / 255.0) * 255.0 / 25.0, 0.0, 1.0); float g = c.g; if (ex > 8.0 / 255.0) { g = min(c.g, max(c.r, c.b) + 6.0 / 255.0); } gl_FragColor = vec4(c.r, g, c.b, a * c.a); } else { float u = c.r * -0.169 + c.g * -0.331 + c.b * 0.5; float v = c.r * 0.5 + c.g * -0.419 + c.b * -0.081; float dist = distance(vec2(u, v), uKeyUv); float base = dist - uSimilarity; float m = clamp(base / max(uSmoothness, 0.0001), 0.0, 1.0); m = m * m * sqrt(m); float s = clamp(base / max(uSpill, 0.0001), 0.0, 1.0); s = s * s * sqrt(s); float luma = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722; vec3 rgb = vec3(luma) + (c.rgb - vec3(luma)) * s; gl_FragColor = vec4(rgb, m * c.a); } }';

  function clamp01(value) {
    if (!(value > 0)) return 0;
    if (value > 1) return 1;
    return value;
  }

  function ramp15(value) {
    var m = clamp01(value);
    return m * m * Math.sqrt(m);
  }

  function numOr(value, fallback) {
    if (typeof value !== 'number' || !(value >= 0)) return fallback;
    return value;
  }

  // Strict '#rrggbb' only — named colors and shorthand never survive an
  // agent round-trip intact, and a silently wrong key eats the subject.
  function parseKeyColor(key) {
    if (typeof key !== 'string' || key.length !== 7 || key.charAt(0) !== '#') return null;
    var r = parseInt(key.substr(1, 2), 16);
    var g = parseInt(key.substr(3, 2), 16);
    var b = parseInt(key.substr(5, 2), 16);
    if (!(r >= 0) || !(g >= 0) || !(b >= 0)) return null;
    if (r > 255 || g > 255 || b > 255) return null;
    return { r: r / 255, g: g / 255, b: b / 255 };
  }

  // UV chrominance only (brightness ignored, so screen shadows key evenly).
  // The +0.5 offsets cancel in the distance — omitted on purpose.
  function rgbToUv(r, g, b) {
    return {
      u: r * -0.169 + g * -0.331 + b * 0.5,
      v: r * 0.5 + g * -0.419 + b * -0.081
    };
  }

  function glShader(gl, type, src) {
    var sh = null;
    try {
      sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
    } catch (_) {
      return null;
    }
    return sh;
  }

  // Lazy one-time GL setup. Returns the state object, or null when the GPU
  // path is unavailable (result cached — a failed init never retries, but a
  // per-frame upload failure falls back to CPU for that draw only).
  function glContext() {
    if (glState !== null) return glState || null;
    glState = false;
    try {
      if (typeof document === 'undefined' || !document.createElement) return null;
      glCanvas = document.createElement('canvas');
      if (glCanvas.addEventListener) {
        glCanvas.addEventListener('webglcontextlost', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          glState = false;
        });
      }
      var gl = glCanvas.getContext('webgl', GL_ATTRS);
      if (!gl) return null;
      var vs = glShader(gl, gl.VERTEX_SHADER, GL_VS);
      var fs = glShader(gl, gl.FRAGMENT_SHADER, GL_FS);
      if (!vs || !fs) return null;
      var prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
      gl.useProgram(prog);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      glState = {
        gl: gl,
        tex: tex,
        buf: buf,
        pos: gl.getAttribLocation(prog, 'aPos'),
        video: gl.getUniformLocation(prog, 'uVideo'),
        keyUv: gl.getUniformLocation(prog, 'uKeyUv'),
        similarity: gl.getUniformLocation(prog, 'uSimilarity'),
        smoothness: gl.getUniformLocation(prog, 'uSmoothness'),
        spill: gl.getUniformLocation(prog, 'uSpill'),
        mode: gl.getUniformLocation(prog, 'uMode'),
        uvRect: gl.getUniformLocation(prog, 'uUvRect')
      };
      return glState;
    } catch (_) {
      glState = false;
      return null;
    }
  }

  function drawKeyedGL(ctx, video, dx, dy, w, h, keyUv, similarity, smoothness, spill, excess, uvRect) {
    var st = glContext();
    if (!st) return false;
    var gl = st.gl;
    try {
      if (glCanvas.width !== w || glCanvas.height !== h) {
        glCanvas.width = w;
        glCanvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, st.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      // Unsized upload form: the only spec-clean overload for DOM sources
      // (video/canvas are always exactly w x h at every call site).
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      gl.uniform1i(st.video, 0);
      gl.uniform2f(st.keyUv, keyUv.u, keyUv.v);
      gl.uniform1f(st.similarity, similarity);
      gl.uniform1f(st.smoothness, smoothness);
      gl.uniform1f(st.spill, spill);
      gl.uniform1f(st.mode, excess ? 1 : 0);
      gl.uniform4f(st.uvRect, uvRect[0], uvRect[1], uvRect[2], uvRect[3]);
      gl.bindBuffer(gl.ARRAY_BUFFER, st.buf);
      gl.enableVertexAttribArray(st.pos);
      gl.vertexAttribPointer(st.pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // Replace semantics: the keyed layer must overwrite the target region,
      // never composite over previous frames. Compositing over a stale
      // keyed frame ghosts old edges into the new one (fringe/halo that
      // builds up frame after frame); compositing over a fresh video blit
      // shows the unkeyed footage through transparent pixels (green).
      // Same-task composite: safe with preserveDrawingBuffer false.
      try { ctx.clearRect(dx, dy, w, h); } catch (_) {}
      ctx.drawImage(glCanvas, dx, dy);
    } catch (_) {
      return false;
    }
    return true;
  }

  function drawKeyedCpu(ctx, video, dx, dy, w, h, key, similarity, smoothness, spill, src) {
    if (!offscreen) {
      if (typeof document === 'undefined' || !document.createElement) return false;
      offscreen = document.createElement('canvas');
    }
    if (offscreen.width !== w || offscreen.height !== h) {
      offscreen.width = w;
      offscreen.height = h;
    }
    var octx = offscreen.getContext('2d');
    if (!octx) return false;
    try {
      if (src) octx.drawImage(video, src[0], src[1], src[2], src[3], 0, 0, w, h);
      else octx.drawImage(video, 0, 0, w, h);
    } catch (_) {
      return false;
    }
    var img;
    try {
      img = octx.getImageData(0, 0, w, h);
    } catch (_) {
      return false;
    }
    var data = img.data;
    var keyUv = rgbToUv(key.r, key.g, key.b);
    var i, r, g, b, du, dv, dist, base, mask, spillVal, luma;
    for (i = 0; i < data.length; i += 4) {
      r = data[i] / 255;
      g = data[i + 1] / 255;
      b = data[i + 2] / 255;
      du = (r * -0.169 + g * -0.331 + b * 0.5) - keyUv.u;
      dv = (r * 0.5 + g * -0.419 + b * -0.081) - keyUv.v;
      dist = Math.sqrt(du * du + dv * dv);
      base = dist - similarity;
      if (smoothness > 0) {
        mask = ramp15(base / smoothness);
      } else {
        mask = base > 0 ? 1 : 0;
      }
      if (spill > 0) {
        spillVal = ramp15(base / spill);
      } else {
        spillVal = 1;
      }
      luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      data[i] = Math.round((luma + (r - luma) * spillVal) * 255);
      data[i + 1] = Math.round((luma + (g - luma) * spillVal) * 255);
      data[i + 2] = Math.round((luma + (b - luma) * spillVal) * 255);
      data[i + 3] = Math.round(mask * 255);
    }
    try {
      octx.putImageData(img, 0, 0);
    } catch (_) {
      return false;
    }
    try {
      // Replace, don't accumulate: see drawKeyedGL.
      try { ctx.clearRect(dx, dy, w, h); } catch (_) {}
      ctx.drawImage(offscreen, dx, dy);
    } catch (_) {
      return false;
    }
    return true;
  }

  // Exact port of the hand-rolled studio loop (green-excess key): opaque at
  // ex <= 8, linear alpha ramp over 8..33, green capped at max(r,b)+6.
  // Same offscreen/canvas plumbing as drawKeyedCpu, only the pixel math differs.
  function drawKeyedCpuExcess(ctx, video, dx, dy, w, h, src) {
    if (!offscreen) {
      if (typeof document === 'undefined' || !document.createElement) return false;
      offscreen = document.createElement('canvas');
    }
    if (offscreen.width !== w || offscreen.height !== h) {
      offscreen.width = w;
      offscreen.height = h;
    }
    var octx = offscreen.getContext('2d');
    if (!octx) return false;
    try {
      if (src) octx.drawImage(video, src[0], src[1], src[2], src[3], 0, 0, w, h);
      else octx.drawImage(video, 0, 0, w, h);
    } catch (_) {
      return false;
    }
    var img;
    try {
      img = octx.getImageData(0, 0, w, h);
    } catch (_) {
      return false;
    }
    var data = img.data;
    var i, r, g, bl, ex, mx;
    for (i = 0; i < data.length; i += 4) {
      r = data[i];
      g = data[i + 1];
      bl = data[i + 2];
      mx = r > bl ? r : bl;
      ex = g - mx;
      if (ex > 8) {
        data[i + 3] = Math.round(255 * (1 - Math.min(1, (ex - 8) / 25)));
        data[i + 1] = Math.min(g, mx + 6);
      }
    }
    try {
      octx.putImageData(img, 0, 0);
    } catch (_) {
      return false;
    }
    try {
      // Replace, don't accumulate: see drawKeyedGL.
      try { ctx.clearRect(dx, dy, w, h); } catch (_) {}
      ctx.drawImage(offscreen, dx, dy);
    } catch (_) {
      return false;
    }
    return true;
  }

  var api = {
    drawKeyed: function (ctx, video, dx, dy, dw, dh, opts) {
      if (!ctx || !video || !opts) return false;
      if (video.readyState !== undefined && video.readyState < 2) return false;
      var w = Math.floor(dw);
      var h = Math.floor(dh);
      if (!(w > 0) || !(h > 0)) return false;
      // Excess mode keys on green dominance directly (no key color needed);
      // every other mode uses the UV-distance key color contract.
      var excess = opts.mode === 'excess';
      var key = excess ? { r: 0, g: 1, b: 0 } : parseKeyColor(opts.key);
      if (!key) return false;
      var similarity = numOr(opts.similarity, ${CHROMA_KEY_DEFAULTS.similarity});
      var smoothness = numOr(opts.smoothness, ${CHROMA_KEY_DEFAULTS.smoothness});
      var spill = numOr(opts.spill, ${CHROMA_KEY_DEFAULTS.spill});
      if (similarity > 1) similarity = 1;
      if (smoothness > 1) smoothness = 1;
      if (spill > 1) spill = 1;
      var keyUv = rgbToUv(key.r, key.g, key.b);
      // Optional source crop (drawImage-style rect in source pixels).
      // Lets scenes key straight from the video element: no intermediate
      // canvas, so the key input never passes through an extra resample.
      var VW = video.videoWidth || video.width || w;
      var VH = video.videoHeight || video.height || h;
      var sx = typeof opts.sx === 'number' && opts.sx > 0 ? opts.sx : 0;
      var sy = typeof opts.sy === 'number' && opts.sy > 0 ? opts.sy : 0;
      var sw = typeof opts.sw === 'number' && opts.sw > 0 ? opts.sw : VW;
      var sh = typeof opts.sh === 'number' && opts.sh > 0 ? opts.sh : VH;
      var hasCrop = sx > 0 || sy > 0 || sw !== VW || sh !== VH;
      var src = hasCrop ? [sx, sy, sw, sh] : null;
      var uvRect = [sx / VW, sy / VH, sw / VW, sh / VH];
      if (drawKeyedGL(ctx, video, dx, dy, w, h, keyUv, similarity, smoothness, spill, excess, uvRect)) {
        api.backend = 'webgl';
        return true;
      }
      if (excess ? drawKeyedCpuExcess(ctx, video, dx, dy, w, h, src)
                 : drawKeyedCpu(ctx, video, dx, dy, w, h, key, similarity, smoothness, spill, src)) {
        api.backend = 'cpu';
        return true;
      }
      return false;
    },
    backend: 'cpu',
    defaults: {
      similarity: ${CHROMA_KEY_DEFAULTS.similarity},
      smoothness: ${CHROMA_KEY_DEFAULTS.smoothness},
      spill: ${CHROMA_KEY_DEFAULTS.spill}
    }
  };

  window.__mobileAgentChromaKey = api;
})();`;
