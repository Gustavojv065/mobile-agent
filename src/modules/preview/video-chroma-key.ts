/**
 * In-page chroma key (green/blue screen) helper for video scenes.
 *
 * A `clip:` layer shot against a flat screen is keyed at draw time: the
 * scene paints the `<video>` frame through `window.__mobileAgentChromaKey`
 * onto the scene canvas, and both preview stills and the export capture
 * carry the keyed result automatically — no preprocessing tool, no native
 * module, no rebuild. The math is a Canvas2D port of the OBS Studio chroma
 * key filter (via Jim Fisher's WebGL port): distance in UV chrominance
 * space from the key color, with `similarity` (cut threshold), `smoothness`
 * (edge ramp), and `spill` (despill strength) params.
 *
 * CPU cost is one getImageData loop per drawn frame (~1M pixels at 720p),
 * inside the realtime render budget — measured on device before any WebGL
 * variant is considered. Numbers clamp instead of throwing (agent tuning
 * must never crash a render); only an unparseable key color or an
 * unready video skips the draw (returns false so the scene can fall back
 * to a plain drawImage).
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
};

/** Starting points — tune per clip with previewScene stills, never ship blind. */
export const CHROMA_KEY_DEFAULTS = {
  similarity: 0.35,
  smoothness: 0.1,
  spill: 0.15,
} as const;

export const VIDEO_CHROMA_KEY_SCRIPT = `(function () {
  var offscreen = null;

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

  function drawKeyed(ctx, video, dx, dy, dw, dh, opts) {
    if (!ctx || !video || !opts) return false;
    if (video.readyState < 2) return false;
    var w = Math.floor(dw);
    var h = Math.floor(dh);
    if (!(w > 0) || !(h > 0)) return false;
    var key = parseKeyColor(opts.key);
    if (!key) return false;
    var similarity = numOr(opts.similarity, ${CHROMA_KEY_DEFAULTS.similarity});
    var smoothness = numOr(opts.smoothness, ${CHROMA_KEY_DEFAULTS.smoothness});
    var spill = numOr(opts.spill, ${CHROMA_KEY_DEFAULTS.spill});
    if (similarity > 1) similarity = 1;
    if (smoothness > 1) smoothness = 1;
    if (spill > 1) spill = 1;

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
      octx.drawImage(video, 0, 0, w, h);
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
      ctx.drawImage(offscreen, dx, dy);
    } catch (_) {
      return false;
    }
    return true;
  }

  window.__mobileAgentChromaKey = {
    drawKeyed: drawKeyed,
    defaults: {
      similarity: ${CHROMA_KEY_DEFAULTS.similarity},
      smoothness: ${CHROMA_KEY_DEFAULTS.smoothness},
      spill: ${CHROMA_KEY_DEFAULTS.spill}
    }
  };
})();`;
