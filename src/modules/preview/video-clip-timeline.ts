/**
 * In-page clip timeline: the single frame-mapping source of truth for every
 * surface a scene plays or renders on — the export recorder, the live preview
 * player, and previewScene stills.
 *
 * The defect this replaces is structural, not stylistic. Before this helper,
 * "which decoded frame does <video> X show at scene time t" had four different
 * owners that never agreed: the export default seeked EVERY video to the same
 * global t (correct only for full-timeline clips — short clips clamped to
 * their last frame or wrapped), a scene's hand-written prepareFrame replaced
 * the default entirely (any clip it forgot froze forever, in every surface),
 * the live preview player drove clips only if the scene's own code did, and
 * stills never seeked at all — so verification could not see clip timing
 * errors. Scenes then patched visibility windows around a broken mapping,
 * and breakage moved to the other end of the timeline instead of going away.
 *
 * A declared timeline replaces all of that. The scene STATES WHERE each clip
 * lives — `window.MOBILE_AGENT_VIDEO.clips = [{ el, start, end, from?, loop?,
 * hold?, x?, y?, w?, h?, alpha? }]` — as pure data next to the contract, and
 * the runtime derives `stateAt(t)`, a pure function of absolute t:
 *
 * - Window `[start, end)`: at t == end the clip is already gone. Half-open
 *   windows are segment-safe by construction — a 30 s segment seam at exactly
 *   `end` paints the clip on exactly one side, never both, never neither.
 * - `from` (default 0) is the source position mapped to `start`; source time
 *   at scene time t is `from + (t - start)`.
 * - `hold` (default true) parks the clip on its last decoded frame when the
 *   source runs out inside its window; `loop: true` repeats the source
 *   instead. Both are loud one-time diagnostics in the render warnings.
 * - Optional geometry (`x, y, w, h, alpha`) feeds `draw(ctx, t)`, a plain
 *   drawImage helper for scenes that do not need custom compositing (chroma
 *   key scenes keep calling `__mobileAgentChromaKey.drawKeyed` and only use
 *   the timeline to drive frames).
 *
 * `prepareFrame(t)` awaits, per clip that is ACTIVE at t only: metadata
 * (readyState >= 1), the assigned `currentTime` (`seeked`), and decode
 * (readyState >= 2), with a 15 s watchdog that fails loud and names the clip
 * — but only after ONE `el.load()` recovery attempt: both stall modes seen
 * in the field (Chromium's readyState stuck at 1 with `seeked` never firing,
 * and a refused decoder allocation under the device codec cap) clear when
 * resource selection re-runs. Before preparing, clips whose window is
 * already over are unloaded so their hardware decoder instances return to
 * the shared, heavily limited pool, and active clips prepare one at a time
 * instead of racing that pool together. Clips are muted on declare (the
 * render mix owns audio)
 * — that also removes the autoplay-policy trap where an unmuted clip could
 * never be advanced programmatically.
 *
 * All three surfaces call `attach(contract)`, which converts the declarative
 * `contract.clips` data once per contract object (memoized) and validates it
 * loudly — a bad selector or shape throws with the clip index and reason
 * instead of silently freezing. `prepareFrame(t)` absolute-t semantics make
 * every segment agree with every other segment by construction.
 *
 * Plain ES5 string (no backticks, template markers, or backslashes), and
 * Node-testable with element stubs.
 */

export type ClipDefinition = {
  /** `<video>` reference or a CSS selector resolving to exactly one video. */
  el: string | HTMLVideoElement;
  /** Scene-time window start, seconds. The clip exists for t in [start, end). */
  start: number;
  /** Scene-time window end, seconds (exclusive). */
  end: number;
  /** Source position mapped to `start`. Defaults to 0. */
  from?: number;
  /** Repeat the source when the window outlives it. Defaults to false. */
  loop?: boolean;
  /** Hold the last decoded frame after the source runs out. Defaults to true. */
  hold?: boolean;
  /** Optional draw rect for `draw(ctx, t)` in canvas pixels. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Optional draw alpha for `draw(ctx, t)`, 0–1. */
  alpha?: number;
  /** Diagnostics label; defaults to the selector or src tail. */
  label?: string;
};

export const VIDEO_CLIP_TIMELINE_SCRIPT = `(function () {
  var installed = null;
  var attached = { contract: null, timeline: null };
  var seenIssues = {};
  var issueList = [];

  function issue(key, message) {
    if (seenIssues[key]) return;
    seenIssues[key] = true;
    if (issueList.length < 8) issueList.push(message);
  }

  function num(value, fallback) {
    if (typeof value !== 'number' || !(value >= 0) || !isFinite(value)) return fallback;
    return value;
  }

  function describe(el) {
    try {
      if (el && el.currentSrc) {
        var parts = String(el.currentSrc).split('/');
        return parts[parts.length - 1].slice(-24);
      }
      return String((el && el.getAttribute && el.getAttribute('src')) || 'video element');
    } catch (_) {
      return 'video element';
    }
  }

  function labelOf(el) {
    var src = describe(el);
    return src.length > 20 ? src.slice(0, 20) : src;
  }

  function resolveElement(entry, index) {
    var raw = entry.el;
    if (typeof raw === 'string') {
      if (!raw) throw new Error('clips[' + index + ']: "el" is empty.');
      var found = null;
      try { found = document.querySelector(raw); } catch (_) { found = null; }
      if (!found) throw new Error('clips[' + index + ']: selector "' + raw + '" matched no element in the page.');
      raw = found;
    }
    var tag = '';
    try { tag = String(raw.tagName || '').toLowerCase(); } catch (_) { tag = ''; }
    if (tag !== 'video') {
      throw new Error('clips[' + index + ']: element is a <' + (tag || 'unknown') + '>, not a <video>.');
    }
    return raw;
  }

  function buildTimeline(entries, fps) {
    if (!(fps > 0) || !isFinite(fps)) fps = 30;
    var clips = [];
    for (var i = 0; i < entries.length; i += 1) {
      (function (entry, index) {
        if (!entry || typeof entry !== 'object') {
          throw new Error('clips[' + index + ']: entry is not an object.');
        }
        var el = resolveElement(entry, index);
        var start = num(entry.start, NaN);
        var end = num(entry.end, NaN);
        if (!(start >= 0)) throw new Error('clips[' + index + ']: "start" must be a number >= 0.');
        if (!(end > start)) throw new Error('clips[' + index + ']: "end" must be greater than "start" (' + start + ').');
        var from = num(entry.from, 0);
        // One Timeline owns the element from declare time on: muted (the
        // render mix owns audio; muted also keeps play()/seek() free of the
        // autoplay policy), paused (frames are clocked by t, never by
        // playback), and never display:none (a hidden video is not decoded).
        try { el.muted = true; } catch (_) {}
        try { el.pause(); } catch (_) {}
        var rect = null;
        var hasRect = entry.x !== undefined || entry.y !== undefined || entry.w !== undefined || entry.h !== undefined;
        if (hasRect) {
          var x = num(entry.x, NaN);
          var y = num(entry.y, NaN);
          var w = num(entry.w, NaN);
          var h = num(entry.h, NaN);
          if (!(x >= 0) || !(y >= 0) || !(w > 0) || !(h > 0)) {
            throw new Error('clips[' + index + ']: rect needs finite x, y and positive w, h.');
          }
          rect = [x, y, w, h];
        }
        var alpha = undefined;
        if (entry.alpha !== undefined) {
          alpha = num(entry.alpha, NaN);
          if (!(alpha >= 0) || alpha > 1) throw new Error('clips[' + index + ']: alpha must be between 0 and 1.');
        }
        var clip = {
          el: el,
          label: entry.label || labelOf(el),
          start: start,
          end: end,
          from: from,
          loop: entry.loop === true,
          hold: entry.hold !== false,
          rect: rect,
          alpha: alpha
        };
        clips.push(clip);
      })(entries[i], i);
    }

    function stateAt(t) {
      var out = [];
      for (var i = 0; i < clips.length; i += 1) {
        var clip = clips[i];
        // Half-open [start, end): a segment seam at exactly end paints the
        // clip on exactly one side — never on both, never on neither.
        var active = t >= clip.start && t < clip.end;
        var local = clip.from + (t - clip.start);
        var dur = 0;
        try { dur = clip.el.duration; } catch (_) { dur = 0; }
        var held = false;
        var wrapped = false;
        var target = local;
        if (active && dur > 0 && isFinite(dur)) {
          if (clip.loop) {
            target = local % dur;
            wrapped = local >= dur;
          } else if (local > dur) {
            target = Math.max(0, dur - 1 / fps);
            held = true;
          }
        }
        if (active && held) {
          issue('hold-' + i, 'Clip "' + clip.label + '" ran past its source length (' + Math.round(dur * 10) / 10 + 's) at t=' + Math.round(t * 10) / 10 + 's: holding its last decoded frame. Pass loop: true to repeat it, or shorten its window.');
        }
        if (active && wrapped) {
          issue('wrap-' + i, 'Clip "' + clip.label + '" repeats (loop: true) after its ' + Math.round(dur * 10) / 10 + 's source length.');
        }
        out.push({
          el: clip.el, label: clip.label, active: active, local: local,
          target: target, held: held, wrapped: wrapped, rect: clip.rect, alpha: clip.alpha
        });
      }
      return out;
    }

    function prepareClip(clip, t) {
      return new Promise(function (resolve, reject) {
        var atScene = Math.round(t * 10) / 10;
        var retried = false;
        var finished = false;
        var timer = null;
        function detach() {
          clip.el.removeEventListener('loadedmetadata', assign);
          clip.el.removeEventListener('seeked', ready);
          clip.el.removeEventListener('loadeddata', ready);
          clip.el.removeEventListener('error', failed);
        }
        function finish(error) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          detach();
          if (error) reject(error); else resolve();
        }
        // One bounded recovery before failing loud: both stall modes clear
        // when the element re-runs resource selection — Chromium's stuck
        // readyState 1 ('seeked' never fires), and a decoder-allocation
        // refusal under the device codec cap (prepareFrame has just
        // unloaded the finished clips' decoders, so the reload has a slot
        // to acquire). A second stall keeps the loud, clip-named failure.
        function recoverOrFail(finalMessage) {
          if (retried || typeof clip.el.load !== 'function') {
            finish(new Error(finalMessage + (retried ? ' Reloaded once and it still stalled.' : '')));
            return;
          }
          retried = true;
          var stuckReadyState = clip.el.readyState;
          clearTimeout(timer);
          detach();
          try {
            clip.el.load();
          } catch (error) {
            finish(new Error(finalMessage + ' (reload failed: ' + String((error && error.message) || error) + ')'));
            return;
          }
          issue('reload-' + clip.label, 'Clip "' + clip.label + '" stalled decoding at t=' + atScene + 's (readyState ' + stuckReadyState + ') and was reloaded to continue.');
          start();
        }
        function failed() {
          recoverOrFail('Clip "' + clip.label + '" video failed to decode.');
        }
        function timedOut() {
          recoverOrFail('Clip "' + clip.label + '" did not decode its frame at t=' + atScene + 's in 15s (stuck at readyState ' + clip.el.readyState + ').');
        }
        function currentTarget() {
          var local = clip.from + (t - clip.start);
          var dur = 0;
          try { dur = clip.el.duration; } catch (_) { dur = 0; }
          if (dur > 0 && isFinite(dur)) {
            if (clip.loop) return local % dur;
            if (local > dur) return Math.max(0, dur - 1 / fps);
          }
          return local;
        }
        function assign() {
          try { clip.el.pause(); } catch (_) {}
          var at = currentTarget();
          try {
            if (Math.abs(clip.el.currentTime - at) > 0.0001) clip.el.currentTime = at;
          } catch (e) {
            finish(e);
            return;
          }
          ready();
        }
        function ready() {
          if (!clip.el.seeking && clip.el.readyState >= 2) finish();
        }
        function start() {
          timer = setTimeout(timedOut, 15000);
          clip.el.addEventListener('loadedmetadata', assign);
          clip.el.addEventListener('seeked', ready);
          clip.el.addEventListener('loadeddata', ready);
          clip.el.addEventListener('error', failed);
          if (clip.el.readyState >= 1) assign();
        }
        start();
      });
    }

    function prepareFrame(t) {
      var states = stateAt(t);
      // A clip whose window is over keeps its decoded frame — and with it a
      // device hardware decoder instance. Those are a shared, heavily
      // limited resource (Android grants fewer concurrent instances than a
      // timeline often has clips), and an accumulating timeline starves
      // later clips into a permanent readyState-1 stall. load() re-runs
      // resource selection (decoder returned to the pool); the clip
      // re-fetches when its window comes around again.
      for (var r = 0; r < clips.length; r += 1) {
        if (t >= clips[r].start && t < clips[r].end) continue;
        if (!(clips[r].el.readyState >= 2)) continue;
        if (typeof clips[r].el.load !== 'function') continue;
        try { clips[r].el.load(); } catch (_) {}
      }
      // One clip at a time: decoder inits are acquired in order instead of
      // all racing the codec cap together on a segment's first frame.
      var chain = Promise.resolve();
      for (var i = 0; i < states.length; i += 1) {
        if (!states[i].active) continue;
        (function (clip) {
          chain = chain.then(function () { return prepareClip(clip, t); });
        })(clips[i]);
      }
      return chain;
    }

    function draw(ctx, t) {
      var drawn = [];
      var states = stateAt(t);
      for (var i = 0; i < states.length; i += 1) {
        var state = states[i];
        if (!state.active) continue;
        try {
          if (state.el.readyState < 2) continue;
          ctx.save();
          if (state.alpha !== undefined && state.alpha < 1) ctx.globalAlpha = ctx.globalAlpha * state.alpha;
          if (state.rect) ctx.drawImage(state.el, state.rect[0], state.rect[1], state.rect[2], state.rect[3]);
          else ctx.drawImage(state.el, 0, 0);
          ctx.restore();
          drawn.push(state.el);
        } catch (_) {}
      }
      return drawn;
    }

    return {
      clips: clips,
      fps: fps,
      stateAt: stateAt,
      prepareFrame: prepareFrame,
      draw: draw,
      ownedElements: function () {
        var out = [];
        for (var i = 0; i < clips.length; i += 1) out.push(clips[i].el);
        return out;
      }
    };
  }

  function declare(entries, options) {
    var fps = (options && num(options.fps, 0)) || 30;
    if (!Array.isArray(entries)) throw new Error('clips: expected an array of clip definitions.');
    if (!entries.length) throw new Error('clips: the list is empty.');
    installed = buildTimeline(entries, fps);
    return installed;
  }

  // Data-contract conversion. The scene only sets window.MOBILE_AGENT_VIDEO.clips;
  // each surface calls attach() with its contract handle, which validates the
  // list once per contract object. Validation errors throw with the clip index
  // and reason — a misconfigured clip must fail loud, not vanish or freeze.
  function attach(contract) {
    if (attached.contract === contract) return attached.timeline;
    attached = { contract: contract, timeline: null };
    if (contract && Array.isArray(contract.clips) && contract.clips.length) {
      installed = buildTimeline(contract.clips, num(contract.fps, 30));
      attached.timeline = installed;
    }
    return attached.timeline;
  }

  window.__mobileAgentClips = {
    declare: declare,
    attach: attach,
    timeline: function () { return installed; },
    issues: function () { return issueList.slice(0); },
    version: 1
  };
})();`;
