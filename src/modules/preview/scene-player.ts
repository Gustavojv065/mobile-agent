import { readContractDuration } from "@/modules/preview/video-audio";

/**
 * In-app scene player (no render involved).
 *
 * Video scenes (`window.MOBILE_AGENT_VIDEO` with a `render(t, ...)` function)
 * are deterministic in `t`, so "playing" one is just advancing `t` and
 * re-calling `render` inside the preview WebView. This module builds the
 * injected player script plus the small pure helpers the native transport
 * bar needs. The player is always silent: scenes get stub audio/speech
 * objects (same shape as the not-ready APIs, every lookup empty), so a
 * scene that reads `audio.level(t)` cannot throw in preview.
 */

/** Scene length in seconds from the HTML, or null when not a video scene. */
export function getSceneDuration(html: string): number | null {
  const duration = readContractDuration(html);
  return duration != null && duration > 0 ? duration : null;
}

/** `7` -> `"0:07"`, `65.2` -> `"1:05"`. Floors; never negative. */
export function formatPlayerTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}

/**
 * Builds the idempotent player script injected into the scene WebView. It
 * defines `window.__mobileAgentPlayer = { play, pause, seek, state }` and
 * posts `{ type: 'mobileAgentPlayerTime', t, playing, error }` (throttled)
 * back over `ReactNativeWebView.postMessage`.
 *
 * Plain-JS string, free of backticks and `${`, in the house style of the
 * other injected engines.
 */
export const SCENE_PLAYER_MESSAGE_TYPE = "mobileAgentPlayerTime";

export function buildScenePlayerScript(): string {
  return `(function () {
  if (window.__mobileAgentPlayer) return;
  var v = window.MOBILE_AGENT_VIDEO;
  if (!v || typeof v.render !== 'function') return;
  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  var duration = num(v.duration, 0);
  var fps = num(v.fps, 30);
  if (!(fps > 0)) fps = 30;
  var canvas = null;
  try {
    canvas = (v.canvasId && document.getElementById(v.canvasId)) ||
      document.querySelector('canvas');
  } catch (_) { canvas = null; }
  var ctx = null;
  try { ctx = canvas ? canvas.getContext('2d') : null; } catch (_) { ctx = null; }
  function zero() { return 0; }
  function emptyText() { return ''; }
  var stubAudio = {
    ready: false, duration: 0, frameRate: 0, bpm: null, beats: [],
    energy: [], low: [], mid: [], high: [], onset: [], pitch: [], pitchConf: [],
    key: null, keyConfidence: null, tuningCents: null,
    level: zero, lowAt: zero, midAt: zero, highAt: zero, onsetAt: zero,
    pitchAt: zero, pitchConfAt: zero, beatPulse: zero
  };
  var stubSpeech = {
    ready: false, duration: 0, language: null, text: '', count: 0, segments: [],
    activeIndex: function () { return -1; },
    segmentAt: function () { return null; },
    activeSegment: function () { return null; },
    activeText: emptyText, progress: zero,
    nextStart: function () { return null; }
  };
  var state = { playing: false, t: 0, raf: 0, last: 0, lastDraw: 0, lastPost: 0, error: null };
  function post(force) {
    var now = Date.now();
    if (!force && now - state.lastPost < 200) return;
    state.lastPost = now;
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: '${SCENE_PLAYER_MESSAGE_TYPE}', t: Math.round(state.t * 100) / 100,
          playing: state.playing, error: state.error
        }));
      }
    } catch (_) {}
    state.error = null;
  }
  function draw(t) {
    if (!ctx || !canvas) return;
    try {
      v.render(t, canvas, ctx, stubAudio, stubSpeech);
    } catch (e) {
      state.error = String((e && e.message) || e);
      state.playing = false;
      if (state.raf) {
        try { cancelAnimationFrame(state.raf); } catch (_) {}
        state.raf = 0;
      }
      post(true);
    }
  }
  function frame(now) {
    if (!state.playing) return;
    if (!state.last) state.last = now;
    var dt = (now - state.last) / 1000;
    state.last = now;
    if (!(dt > 0)) { state.raf = requestAnimationFrame(frame); return; }
    state.t += dt;
    if (duration > 0 && state.t >= duration) {
      state.t = duration;
      draw(state.t);
      state.playing = false;
      state.raf = 0;
      post(true);
      return;
    }
    if (now - state.lastDraw >= 1000 / fps - 2) {
      state.lastDraw = now;
      draw(state.t);
    }
    post(false);
    state.raf = requestAnimationFrame(frame);
  }
  window.__mobileAgentPlayer = {
    play: function () {
      if (!ctx) return false;
      if (duration > 0 && state.t >= duration) state.t = 0;
      state.playing = true;
      state.last = 0;
      state.error = null;
      if (!state.raf) state.raf = requestAnimationFrame(frame);
      post(true);
      return true;
    },
    pause: function () {
      state.playing = false;
      if (state.raf) {
        try { cancelAnimationFrame(state.raf); } catch (_) {}
        state.raf = 0;
      }
      post(true);
    },
    seek: function (t) {
      t = num(t, 0);
      if (t < 0) t = 0;
      if (duration > 0 && t > duration) t = duration;
      state.t = t;
      state.last = 0;
      draw(t);
      post(true);
    },
    state: function () {
      return { t: state.t, playing: state.playing, duration: duration, hasCanvas: !!ctx };
    }
  };
})();`;
}
