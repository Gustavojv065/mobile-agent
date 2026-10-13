/**
 * In-page scene preview runner for the `previewScene` tool.
 *
 * The tool loads the agent's scene (assets already inlined) wrapped in this
 * script in a hidden host WebView. The script waits for media readiness,
 * calls `render(t, ...)` at each requested timestamp with silent stub audio
 * and speech objects (scenes check `.ready` first, so they draw their
 * no-audio state), captures the canvas via `toDataURL`, and posts each frame
 * back. Two render passes per timestamp let seek-chasing scenes settle: the
 * first triggers async seeks/decodes, the second paints the settled frame.
 *
 * Approximate by design (async media, no audio playback) — the render is
 * truth. A tainted canvas fails capture here first, before export time.
 *
 * Plain ES5 string (no backticks, template markers, or backslashes) like the
 * recorder string, and Node-testable with DOM stubs. Test-only knobs via
 * `window.__mobileAgentScenePreviewConfig = { settleMs, readyTimeoutMs }`.
 */
export const VIDEO_PREVIEW_SCRIPT = `(function () {
  var cancelled = false;
  var running = false;
  var timer = null;

  function config() {
    var cfg = window.__mobileAgentScenePreviewConfig;
    if (cfg && typeof cfg === 'object') {
      return {
        settleMs: typeof cfg.settleMs === 'number' ? cfg.settleMs : 400,
        readyTimeoutMs: typeof cfg.readyTimeoutMs === 'number' ? cfg.readyTimeoutMs : 10000
      };
    }
    return { settleMs: 400, readyTimeoutMs: 10000 };
  }

  function post(payload) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    } catch (_) {}
  }

  function zero() { return 0; }
  function emptyText() { return ''; }
  function negOne() { return -1; }
  function none() { return null; }

  function stubAudio() {
    return {
      ready: false, duration: 0, frameRate: 0, bpm: null, beats: [],
      energy: [], low: [], mid: [], high: [], onset: [],
      level: zero, lowAt: zero, midAt: zero, highAt: zero, onsetAt: zero,
      beatPulse: zero
    };
  }

  function stubSpeech() {
    return {
      ready: false, duration: 0, language: '', text: '', count: 0, segments: [],
      activeIndex: negOne, segmentAt: none, activeSegment: none,
      activeText: emptyText, progress: zero, nextStart: none
    };
  }

  function findCanvas(contract) {
    if (contract.canvasId) {
      var el = document.getElementById(contract.canvasId);
      if (el) return el;
    }
    var list = document.querySelectorAll('canvas');
    return list && list.length > 0 ? list[0] : null;
  }

  function mediaVideos() {
    var out = [];
    var list = document.querySelectorAll('video');
    for (var i = 0; i < list.length; i += 1) out.push(list[i]);
    return out;
  }

  // Resolves when every image is complete and every video can play at least
  // the current frame; unready elements are warned about once, never fatal.
  function mediaReady(timeoutMs) {
    return new Promise(function (resolve) {
      var warnings = [];
      var startedAt = Date.now();
      function poll() {
        if (cancelled) { resolve({ warnings: warnings }); return; }
        var pending = false;
        var imgs = document.images;
        for (var i = 0; i < imgs.length; i += 1) {
          var img = imgs[i];
          if (!img.complete) { pending = true; continue; }
          if (img.naturalWidth === 0 && !img.__previewWarned) {
            img.__previewWarned = true;
            warnings.push('An image failed to load; it paints nothing in the preview.');
          }
        }
        var videos = mediaVideos();
        for (var v = 0; v < videos.length; v += 1) {
          var video = videos[v];
          try {
            if (video.error && !video.__previewWarned) {
              video.__previewWarned = true;
              warnings.push('A video clip failed to load; it paints nothing in the preview.');
            } else if (!video.error && video.readyState < 2) {
              pending = true;
            }
          } catch (_) {}
        }
        if (!pending || Date.now() - startedAt > timeoutMs) {
          if (pending) warnings.push('Some media was still loading; the preview may show placeholders.');
          resolve({ warnings: warnings });
          return;
        }
        timer = setTimeout(poll, 120);
      }
      poll();
    });
  }

  function captureFrame(contract, canvas, ctx, audioApi, speechApi, t, settleMs) {
    return new Promise(function (resolve) {
      try {
        contract.render(t, canvas, ctx, audioApi, speechApi);
      } catch (error) {
        resolve({ error: 'render(' + t + ') threw: ' + String((error && error.message) || error) });
        return;
      }
      timer = setTimeout(function () {
        if (cancelled) { resolve({ cancelled: true }); return; }
        try {
          contract.render(t, canvas, ctx, audioApi, speechApi);
        } catch (error) {
          resolve({ error: 'render(' + t + ') threw: ' + String((error && error.message) || error) });
          return;
        }
        var dataUrl = null;
        try {
          dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        } catch (error) {
          resolve({ error: 'Preview capture failed: the canvas is tainted by a cross-origin asset. Use workspace:// images and clips only.' });
          return;
        }
        if (!dataUrl) {
          resolve({ error: 'Preview capture produced no pixels at t=' + t + '.' });
          return;
        }
        var comma = dataUrl.indexOf(',');
        resolve({
          frame: {
            time: t,
            width: canvas.width,
            height: canvas.height,
            base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
          }
        });
      }, settleMs);
    });
  }

  window.__startMobileAgentScenePreview = function (times) {
    if (running) return;
    running = true;
    cancelled = false;
    var cfg = config();
    var contract = window.MOBILE_AGENT_VIDEO;
    if (!contract || typeof contract.render !== 'function') {
      running = false;
      post({ type: 'mobileAgentPreviewError', message: 'The HTML does not implement the window.MOBILE_AGENT_VIDEO contract.' });
      return;
    }
    var canvas = findCanvas(contract);
    if (!canvas) {
      running = false;
      post({ type: 'mobileAgentPreviewError', message: 'No canvas element was found in the scene.' });
      return;
    }
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (_) {}
    var list = Array.isArray(times) ? times : [];
    var videos = mediaVideos();
    for (var i = 0; i < videos.length; i += 1) {
      try { videos[i].muted = true; videos[i].pause(); } catch (_) {}
    }
    var audioApi = stubAudio();
    var speechApi = stubSpeech();
    mediaReady(cfg.readyTimeoutMs).then(function (media) {
      var warnings = media.warnings;
      var chain = Promise.resolve();
      for (var k = 0; k < list.length; k += 1) {
        (function (t) {
          chain = chain.then(function () {
            if (cancelled) return null;
            return captureFrame(contract, canvas, ctx, audioApi, speechApi, t, cfg.settleMs).then(function (result) {
              if (!result || result.cancelled) return null;
              if (result.error) {
                warnings.push(result.error);
                return null;
              }
              post({ type: 'mobileAgentPreviewFrame', frame: result.frame });
              return null;
            });
          });
        })(list[k]);
      }
      return chain.then(function () {
        running = false;
        if (cancelled) return null;
        post({ type: 'mobileAgentPreviewDone', warnings: warnings });
        return null;
      });
    });
  };

  window.__cancelMobileAgentScenePreview = function () {
    cancelled = true;
    if (timer) {
      try { clearTimeout(timer); } catch (_) {}
      timer = null;
    }
  };
})();`;

/**
 * Wraps a scene document with the preview runner, mirroring
 * `buildVideoExportDocument` (preview script only — no recorder).
 */
export function buildScenePreviewDocument(html: string): string {
  const script = `\n<script>${VIDEO_PREVIEW_SCRIPT}</script>\n`;
  const lower = html.toLowerCase();
  const index = lower.lastIndexOf("</body>");
  if (index === -1) return `${html}${script}`;
  return `${html.slice(0, index)}${script}${html.slice(index)}`;
}
