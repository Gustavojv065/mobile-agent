/**
 * Recorder injected into the HTML preview document.
 *
 * The page declares `window.MOBILE_AGENT_VIDEO = { duration, fps, width,
 * height, canvasId?, render(t, canvas, ctx) }`. The recorder drives `render`
 * once per frame at the requested FPS:
 *
 *  - GPU path: `new VideoFrame(canvas)` is fed to WebCodecs `VideoEncoder`
 *    (hardware H.264), whose Annex-B chunks are posted to the native
 *    `html-video-export` module for muxing into an MP4.
 *  - Fallback path (no WebCodecs): each frame is posted as a JPEG and
 *    re-encoded on the native hardware encoder.
 *
 * Determinism rules for the page's `render`: everything must be a pure
 * function of `t` (seconds) — no `Math.random`, `Date.now`, or
 * `requestAnimationFrame`-driven state, since the recorder samples the canvas
 * on its own clock.
 *
 * The byte-level helpers in this string are mirrored by the Node-testable
 * functions in h264-nals.ts — keep both copies in sync.
 */
export const VIDEO_EXPORT_SCRIPT = `(function () {
  if (window.__mobileAgentVideoExportScript) return;
  window.__mobileAgentVideoExportScript = true;

  var running = false;
  var cancelled = true;
  var timers = [];
  var activeEncoder = null;
  var stage = null;
  var hijackedCanvas = null;
  var saved = null;

  function post(payload) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    } catch (_) {}
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function bitrateFor(width, height) {
    var pixels = width * height;
    if (pixels <= 640 * 360) return 2000000;
    if (pixels <= 1280 * 720) return 6000000;
    if (pixels <= 1920 * 1080) return 12000000;
    return 16000000;
  }

  function readContract() {
    var contract = window.MOBILE_AGENT_VIDEO;
    if (!contract || typeof contract.render !== 'function') return null;
    return contract;
  }

  function resolveCanvas(contract) {
    var canvas = null;
    if (contract.canvasId) {
      var byId = document.getElementById(contract.canvasId);
      if (byId && byId.tagName === 'CANVAS') canvas = byId;
    }
    if (!canvas) {
      var list = document.querySelectorAll('canvas');
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].width > 0 || list[i].height > 0 || list[i].offsetWidth > 0) {
          canvas = list[i];
          break;
        }
      }
    }
    return canvas;
  }

  function hijackCanvas(canvas, width, height) {
    saved = {
      parent: canvas.parentNode,
      nextSibling: canvas.nextSibling,
      style: canvas.getAttribute('style'),
      className: canvas.getAttribute('class'),
      width: canvas.width,
      height: canvas.height,
    };
    hijackedCanvas = canvas;
    canvas.width = width;
    canvas.height = height;
    canvas.setAttribute('style', 'position:relative;width:auto;height:auto;max-width:100%;max-height:100%;margin:auto;display:block;background:#000;');
    stage = document.createElement('div');
    stage.id = 'mobile-agent-video-stage';
    stage.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#000;');
    stage.appendChild(canvas);
    document.body.appendChild(stage);
  }

  function restoreCanvas() {
    if (stage && stage.parentNode) stage.parentNode.removeChild(stage);
    stage = null;
    if (hijackedCanvas && saved) {
      if (saved.nextSibling) {
        saved.parent.insertBefore(hijackedCanvas, saved.nextSibling);
      } else if (saved.parent) {
        saved.parent.appendChild(hijackedCanvas);
      }
      if (saved.style) hijackedCanvas.setAttribute('style', saved.style);
      else hijackedCanvas.removeAttribute('style');
      if (saved.className) hijackedCanvas.setAttribute('class', saved.className);
      else hijackedCanvas.removeAttribute('class');
      hijackedCanvas.width = saved.width;
      hijackedCanvas.height = saved.height;
    }
    hijackedCanvas = null;
    saved = null;
  }

  function renderFrame(contract, canvas, ctx, t) {
    try {
      contract.render(t, canvas, ctx || null);
      return true;
    } catch (error) {
      fail(String((error && error.message) || error));
      return false;
    }
  }

  function teardown() {
    try {
      if (activeEncoder) activeEncoder.close();
    } catch (_) {}
    activeEncoder = null;
    timers.forEach(function (timer) { clearTimeout(timer); });
    timers = [];
    restoreCanvas();
    running = false;
    try { window.MOBILE_AGENT_VIDEO_RECORDING = false; } catch (_) {}
  }

  function fail(message) {
    if (cancelled) return;
    cancelled = true;
    teardown();
    post({ type: 'mobileAgentVideoError', message: message });
  }

  function cancel() {
    if (cancelled && !running) return;
    cancelled = true;
    teardown();
  }

  function supportsH264Encoder(width, height, fps) {
    if (!window.VideoEncoder || !window.VideoFrame) return Promise.resolve(false);
    var config = {
      codec: 'avc1.42001F',
      width: width,
      height: height,
      bitrate: bitrateFor(width, height),
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware'
    };
    return VideoEncoder.isConfigSupported(config)
      .then(function (info) { return !!(info && info.supported); })
      .catch(function () { return false; });
  }

  function start() {
    if (running) return;
    var contract = readContract();
    if (!contract) {
      post({ type: 'mobileAgentVideoUnsupported' });
      return;
    }
    var duration = clamp(Number(contract.duration) || 10, 1, 45);
    var fps = clamp(Number(contract.fps) || 30, 5, 60);
    var width = Math.round(clamp(Number(contract.width) || 1280, 160, 1920));
    var height = Math.round(clamp(Number(contract.height) || 720, 160, 1920));
    if (width % 2 !== 0) width += 1;
    if (height % 2 !== 0) height += 1;
    var frameCount = Math.max(1, Math.round(duration * fps));

    var canvas = resolveCanvas(contract);
    if (!canvas) {
      post({ type: 'mobileAgentVideoUnsupported' });
      return;
    }
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (_) { ctx = null; }

    hijackCanvas(canvas, width, height);
    post({
      type: 'mobileAgentVideoConfig',
      width: width,
      height: height,
      fps: fps,
      frameCount: frameCount,
      duration: duration
    });

    running = true;
    cancelled = false;
    try { window.MOBILE_AGENT_VIDEO_RECORDING = true; } catch (_) {}

    supportsH264Encoder(width, height, fps).then(function (supported) {
      if (cancelled) return;
      if (supported) runH264(contract, canvas, ctx, width, height, fps, frameCount);
      else runJpeg(contract, canvas, ctx, width, height, fps, frameCount);
    });
  }

  function runH264(contract, canvas, ctx, width, height, fps, frameCount) {
    var encoder = null;
    var csdSent = false;
    var spsHex = null;
    var ppsHex = null;
    var emitted = 0;
    var index = 0;
    var stepMs = 1000 / fps;
    var nextAt = performance.now();

    function onChunk(chunk) {
      var bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      var annexb = toAnnexB(bytes);
      if (!csdSent) {
        if (chunk.type !== 'key') return;
        var meta = extractCsd(annexb);
        if (!meta) {
          fail('The H.264 encoder did not provide codec configuration (SPS/PPS).');
          return;
        }
        spsHex = meta.spsHex;
        ppsHex = meta.ppsHex;
        post({ type: 'mobileAgentVideoCsd', spsHex: spsHex, ppsHex: ppsHex });
        csdSent = true;
      }
      var payload = stripCsd(annexb);
      if (payload.byteLength > 0) {
        post({
          type: 'mobileAgentVideoEncodedChunk',
          index: emitted,
          frameCount: frameCount,
          keyFrame: chunk.type === 'key',
          timestamp: Math.round(chunk.timestamp),
          base64: bytesToBase64(payload)
        });
        emitted += 1;
      }
    }

    function onError(error) {
      fail('Video encoder error: ' + String((error && error.message) || error));
    }

    encoder = new VideoEncoder({ output: onChunk, error: onError });
    activeEncoder = encoder;

    function tick() {
      if (cancelled) { teardown(); return; }
      if (index >= frameCount) { finishH264(); return; }
      var t = index / fps;
      if (!renderFrame(contract, canvas, ctx, t)) return;
      var frame = null;
      try {
        frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6) });
      } catch (error) {
        fail('Frame capture failed: ' + String((error && error.message) || error));
        return;
      }
      try {
        encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
      } catch (error) {
        onError(error);
        return;
      } finally {
        frame.close();
      }
      index += 1;
      pace();
    }

    function pace() {
      if (cancelled) return;
      waitForEncoder(encoder).then(function () {
        if (cancelled) return;
        nextAt += stepMs;
        timers.push(setTimeout(tick, Math.max(0, nextAt - performance.now())));
      });
    }

    function finishH264() {
      if (cancelled) { teardown(); return; }
      var enc = encoder;
      encoder = null;
      activeEncoder = null;
      if (!enc) { teardown(); return; }
      enc.flush().then(function () {
        try { enc.close(); } catch (_) {}
        if (cancelled) return;
        post({ type: 'mobileAgentVideoDone', emitted: emitted });
        teardown();
      }).catch(function (error) {
        try { enc.close(); } catch (_) {}
        if (cancelled) return;
        fail('Encoder finish failed: ' + String((error && error.message) || error));
      });
    }

    try {
      encoder.configure({
        codec: 'avc1.42001F',
        width: width,
        height: height,
        bitrate: bitrateFor(width, height),
        framerate: fps,
        hardwareAcceleration: 'prefer-hardware'
      });
    } catch (error) {
      onError(error);
      return;
    }
    tick();
  }

  function runJpeg(contract, canvas, ctx, width, height, fps, frameCount) {
    var index = 0;
    var emitted = 0;
    var stepMs = 1000 / fps;
    var nextAt = performance.now();

    function tick() {
      if (cancelled) { teardown(); return; }
      if (index >= frameCount) {
        post({ type: 'mobileAgentVideoDone', emitted: emitted });
        teardown();
        return;
      }
      var t = index / fps;
      if (!renderFrame(contract, canvas, ctx, t)) return;
      var dataUrl = null;
      try {
        dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      } catch (error) {
        fail('Frame capture failed: ' + String((error && error.message) || error));
        return;
      }
      var comma = dataUrl.indexOf(',');
      var base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      post({ type: 'mobileAgentVideoFrame', index: emitted, frameCount: frameCount, base64: base64 });
      emitted += 1;
      index += 1;
      nextAt += stepMs;
      timers.push(setTimeout(tick, Math.max(0, nextAt - performance.now())));
    }

    tick();
  }

  function readStartCode(bytes, offset) {
    if (offset + 3 < bytes.length && bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 0 && bytes[offset + 3] === 1) return 4;
    if (offset + 2 < bytes.length && bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 1) return 3;
    return 0;
  }

  function splitNals(annexb) {
    var nals = [];
    var i = 0;
    while (i < annexb.length) {
      var startCode = readStartCode(annexb, i);
      if (startCode === 0) { i += 1; continue; }
      var start = i + startCode;
      var end = start;
      while (end < annexb.length && readStartCode(annexb, end) === 0) end += 1;
      if (end > start) nals.push(annexb.subarray(start, end));
      i = end;
    }
    return nals;
  }

  function toAnnexB(bytes) {
    if (readStartCode(bytes, 0) > 0) return bytes;
    var parts = [];
    var i = 0;
    while (i + 4 <= bytes.length) {
      var length = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
      if (length <= 0 || i + 4 + length > bytes.length) break;
      parts.push(new Uint8Array([0, 0, 0, 1]));
      parts.push(bytes.subarray(i + 4, i + 4 + length));
      i += 4 + length;
    }
    if (parts.length === 0) return bytes;
    var total = 0;
    for (var p = 0; p < parts.length; p += 1) total += parts[p].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var q = 0; q < parts.length; q += 1) {
      out.set(parts[q], offset);
      offset += parts[q].length;
    }
    return out;
  }

  function nalType(bytes) {
    return bytes.length > 0 ? bytes[0] & 0x1f : 0;
  }

  function extractCsd(annexb) {
    var nals = splitNals(annexb);
    var sps = null;
    var pps = null;
    for (var i = 0; i < nals.length; i += 1) {
      var type = nalType(nals[i]);
      if (type === 7 && !sps) sps = nals[i];
      else if (type === 8 && !pps) pps = nals[i];
    }
    if (!sps || !pps) return null;
    return { spsHex: bytesToHex(sps), ppsHex: bytesToHex(pps) };
  }

  function stripCsd(annexb) {
    var nals = splitNals(annexb);
    var kept = [];
    for (var i = 0; i < nals.length; i += 1) {
      var type = nalType(nals[i]);
      if (type === 7 || type === 8) continue;
      kept.push(nals[i]);
    }
    var total = 0;
    for (var k = 0; k < kept.length; k += 1) total += kept[k].length + 4;
    var out = new Uint8Array(total);
    var offset = 0;
    for (var j = 0; j < kept.length; j += 1) {
      out[offset] = 0; out[offset + 1] = 0; out[offset + 2] = 0; out[offset + 3] = 1;
      offset += 4;
      out.set(kept[j], offset);
      offset += kept[j].length;
    }
    return out;
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      var hex = bytes[i].toString(16);
      if (hex.length === 1) hex = '0' + hex;
      out += hex;
    }
    return out;
  }

  function bytesToBase64(bytes) {
    var parts = [];
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
    }
    return btoa(parts.join(''));
  }

  function waitForEncoder(encoder) {
    if (!encoder || !encoder.encodeQueueSize || encoder.encodeQueueSize <= 6) return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, 5); }).then(function () {
      return waitForEncoder(encoder);
    });
  }

  window.__startMobileAgentVideoExport = start;
  window.__cancelMobileAgentVideoExport = cancel;
})();
`;

/**
 * Injects the recorder script into a preview document right before `</body>`
 * (or appends it when the document has no body tag), so the page evaluates it
 * on load and `window.__startMobileAgentVideoExport` can be called later.
 */
export function buildVideoExportDocument(html: string): string {
  const script = `\n<script>${VIDEO_EXPORT_SCRIPT}</script>\n`;
  const lower = html.toLowerCase();
  const index = lower.lastIndexOf("</body>");
  if (index === -1) return `${html}${script}`;
  return `${html.slice(0, index)}${script}${html.slice(index)}`;
}