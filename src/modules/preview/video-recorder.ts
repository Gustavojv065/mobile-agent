import { VIDEO_AUDIO_ANALYSIS_SCRIPT } from "@/modules/preview/video-audio-analysis";
import { VIDEO_CHROMA_KEY_SCRIPT } from "@/modules/preview/video-chroma-key";

/**
 * Recorder injected into the HTML preview document.
 *
 * The page declares `window.MOBILE_AGENT_VIDEO = { duration, fps, width,
 * height, canvasId?, render(t, canvas, ctx, audio, speech), audio?, speech? }`.
 * The recorder drives `render` once per frame at the requested FPS. When file
 * audio is present it is analyzed up front (see video-audio-analysis.ts) and the
 * resulting `audio` object is passed as the fourth argument and mirrored on
 * `window.MOBILE_AGENT_VIDEO_AUDIO`, so the visuals can react to the actual
 * soundtrack deterministically. A `speech` transcript (usually the `segments`
 * from the `transcribeAudio` tool) is normalized the same way and passed as the
 * fifth argument, mirrored on `window.MOBILE_AGENT_VIDEO_SPEECH`:
 *
 *  - GPU path: `new VideoFrame(canvas)` is fed to WebCodecs `VideoEncoder`
 *    (hardware H.264), whose Annex-B chunks are posted to the native
 *    `html-video-export` module for muxing into an MP4.
 *  - Fallback path (no WebCodecs): each frame is posted as a JPEG and
 *    re-encoded on the native hardware encoder.
 *  - Audio path (optional `audio` schedule): file cues (data-URI audio, inlined
 *    by the renderVideo tool) and synthesized cues are mixed in a WebAudio
 *    graph, captured, AAC-encoded (WebCodecs or native PCM fallback), and muxed
 *    as a second track. Missing audio
 *    APIs degrade to a silent video with a warning, never a failure.
 *
 * `audio` is always an object (never undefined): when there is no analyzable
 * file audio, `audio.ready` is false and every lookup returns 0, so a page can
 * safely call `audio.level(t)` unconditionally. `speech` is likewise always an
 * object: without a usable transcript `speech.ready` is false, `speech.activeText(t)`
 * is "", and `speech.activeIndex(t)` is -1.
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
  var activeAudio = null;
  var activeAudioSchedule = null;
  var activeAudioApi = null;
  var activeSpeechApi = null;
  var analysis = (typeof window !== 'undefined' && window.__mobileAgentAudioAnalysis) || null;

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

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function parseNoteName(name) {
    if (typeof name !== 'string') return null;
    var m = /^\\s*([A-Ga-g])([#b]?)(-?\\d+)\\s*$/.exec(name);
    if (!m) return null;
    var base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
    if (base == null) return null;
    var acc = m[2] === '#' ? 1 : (m[2] === 'b' ? -1 : 0);
    var octave = parseInt(m[3], 10);
    if (isNaN(octave)) return null;
    return base + acc + (octave + 1) * 12;
  }

  function noteToFreq(value) {
    if (typeof value === 'number' && isFinite(value)) {
      if (value > 0 && value < 128) return midiToFreq(Math.round(value));
      return null;
    }
    var midi = parseNoteName(value);
    return midi == null ? null : midiToFreq(midi);
  }

  function validWave(wave, fallback) {
    if (wave === 'sine' || wave === 'square' || wave === 'triangle' || wave === 'sawtooth') return wave;
    return fallback;
  }

  function kitNum(raw, key, fallback, min, max) {
    var v = raw && typeof raw === 'object' ? raw[key] : null;
    if (v == null) return fallback;
    v = Number(v);
    if (isNaN(v)) return fallback;
    return clamp(v, min, max);
  }

  function normalizeKitPiece(raw) {
    return {
      level: kitNum(raw, 'level', 1, 0, 2),
      decay: kitNum(raw, 'decay', 1, 0.25, 4),
      tone: kitNum(raw, 'tone', 1, 0.5, 2)
    };
  }

  function normalizeKit(raw) {
    return {
      kick: normalizeKitPiece(raw && raw.kick),
      snare: normalizeKitPiece(raw && raw.snare),
      hat: normalizeKitPiece(raw && raw.hat),
      openhat: normalizeKitPiece(raw && raw.openhat),
      clap: normalizeKitPiece(raw && raw.clap)
    };
  }

  function normalizeDuckRanges(raw, duration) {
    var ranges = [];
    if (!Array.isArray(raw)) return ranges;
    for (var i = 0; i < raw.length; i += 1) {
      var r = raw[i];
      if (!r || typeof r !== 'object') continue;
      var start = Number(r.start);
      var end = Number(r.end);
      if (isNaN(start) || isNaN(end) || !(end > start)) continue;
      start = clamp(start, 0, duration);
      end = clamp(end, 0, duration);
      if (end > start) ranges.push({ start: start, end: end });
    }
    ranges.sort(function (a, b) { return a.start - b.start; });
    return ranges;
  }

  function normalizeSynth(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var kind = String(raw.kind || raw.type || 'tone').toLowerCase();
    var i, freqs, f;
    if (kind === 'tone' || kind === 'pluck' || kind === 'lead' || kind === 'bass') {
      freqs = [];
      if (Array.isArray(raw.notes)) {
        for (i = 0; i < raw.notes.length && freqs.length < 128; i += 1) {
          f = noteToFreq(raw.notes[i]);
          if (f) freqs.push(f);
        }
      }
      var single = Number(raw.freq) || 0;
      if (freqs.length === 0) {
        if (!(single >= 20 && single <= 20000)) return null;
        freqs.push(single);
      }
      return {
        kind: 'tone', freqs: freqs,
        wave: validWave(raw.wave, 'sine'),
        noteDur: clamp(Number(raw.noteDur) || 0.5, 0.05, 8),
        attack: clamp(Number(raw.attack) || 0.01, 0.001, 4),
        release: clamp(Number(raw.release) || 0.2, 0.001, 4)
      };
    }
    if (kind === 'pad' || kind === 'chord' || kind === 'strings') {
      freqs = [];
      if (Array.isArray(raw.notes)) {
        for (i = 0; i < raw.notes.length && freqs.length < 16; i += 1) {
          f = noteToFreq(raw.notes[i]);
          if (f) freqs.push(f);
        }
      }
      if (freqs.length === 0) return null;
      return {
        kind: 'pad', freqs: freqs,
        wave: validWave(raw.wave, 'triangle'),
        attack: clamp(Number(raw.attack) || 1.5, 0.05, 8),
        release: clamp(Number(raw.release) || 1.5, 0.05, 8)
      };
    }
    if (kind === 'noise' || kind === 'sweep' || kind === 'whoosh' || kind === 'wind' || kind === 'rain') {
      var filter = (raw.filter === 'highpass' || raw.filter === 'bandpass') ? raw.filter : 'lowpass';
      return {
        kind: 'noise', filter: filter,
        filterFreq: clamp(Number(raw.filterFreq) || 800, 20, 20000),
        filterEnd: raw.filterEnd == null ? null : clamp(Number(raw.filterEnd), 20, 20000),
        q: clamp(Number(raw.q) || 1, 0.1, 20),
        attack: clamp(Number(raw.attack) || 0.3, 0.001, 4),
        release: clamp(Number(raw.release) || 0.5, 0.001, 4)
      };
    }
    if (kind === 'drums' || kind === 'kit' || kind === 'beat') {
      var stepDur = Number(raw.stepDur) || 0.25;
      if (isNaN(stepDur)) stepDur = 0.25;
      stepDur = clamp(stepDur, 0.05, 2);
      var hits = [];
      var capped = false;
      if (Array.isArray(raw.steps)) {
        for (i = 0; i < raw.steps.length && !capped; i += 1) {
          var step = raw.steps[i];
          var names = Array.isArray(step) ? step : (typeof step === 'string' ? [step] : []);
          for (var k = 0; k < names.length; k += 1) {
            var hit = String(names[k] || '').toLowerCase();
            if (hit !== 'kick' && hit !== 'snare' && hit !== 'hat' && hit !== 'openhat' && hit !== 'clap') continue;
            if (hits.length >= 512) { capped = true; break; }
            hits.push({ at: i * stepDur, hit: hit });
          }
        }
      }
      if (hits.length === 0) return null;
      return { kind: 'drums', stepDur: stepDur, hits: hits, capped: capped, kit: normalizeKit(raw.kit) };
    }
    return null;
  }

  function normalizeAudioCue(raw, duration) {
    if (!raw || typeof raw !== 'object') return null;
    var cue = null;
    if (typeof raw.file === 'string' && raw.file) {
      cue = { kind: 'file', src: raw.file };
    } else if (raw.synth) {
      var synth = normalizeSynth(raw.synth);
      if (!synth) return null;
      cue = { kind: 'synth', synth: synth };
    } else {
      return null;
    }
    cue.start = clamp(Number(raw.start) || 0, 0, duration);
    var maxDur = Math.max(0, duration - cue.start);
    cue.duration = raw.duration == null ? maxDur : clamp(Number(raw.duration) || 0, 0, maxDur);
    if (!(cue.duration > 0)) return null;
    cue.volume = raw.volume == null ? 0.8 : clamp(Number(raw.volume), 0, 1);
    if (isNaN(cue.volume)) cue.volume = 0.8;
    cue.fadeIn = clamp(Number(raw.fadeIn) || 0, 0, cue.duration);
    cue.fadeOut = clamp(Number(raw.fadeOut) || 0, 0, cue.duration);
    cue.reverb = raw.reverb == null ? 0 : clamp(Number(raw.reverb), 0, 1);
    if (isNaN(cue.reverb)) cue.reverb = 0;
    cue.delay = raw.delay == null ? 0 : clamp(Number(raw.delay), 0, 1);
    if (isNaN(cue.delay)) cue.delay = 0;
    cue.duckRanges = normalizeDuckRanges(raw.duckUnder, duration);
    cue.duckAmount = raw.duckAmount == null ? 0.4 : clamp(Number(raw.duckAmount), 0, 1);
    if (isNaN(cue.duckAmount)) cue.duckAmount = 0.4;
    cue.duckAttack = raw.duckAttack == null ? 0.3 : clamp(Number(raw.duckAttack), 0.01, 4);
    if (isNaN(cue.duckAttack)) cue.duckAttack = 0.3;
    cue.duckRelease = raw.duckRelease == null ? 0.5 : clamp(Number(raw.duckRelease), 0.01, 4);
    if (isNaN(cue.duckRelease)) cue.duckRelease = 0.5;
    if (cue.kind === 'file') {
      cue.offset = Math.max(0, Number(raw.offset) || 0);
      cue.loop = raw.loop === true;
    }
    return cue;
  }

  function readAudioSchedule(contract, duration) {
    var audio = contract.audio;
    if (!audio || typeof audio !== 'object') return null;
    var tracks = audio.tracks;
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    var master = audio.master == null ? 1 : clamp(Number(audio.master), 0, 1);
    if (isNaN(master)) master = 1;
    var cues = [];
    for (var i = 0; i < tracks.length && cues.length < 8; i += 1) {
      var cue = normalizeAudioCue(tracks[i], duration);
      if (cue) cues.push(cue);
    }
    if (cues.length === 0) return null;
    return { master: master, cues: cues, fx: readFxSchedule(audio) };
  }

  // Schedule-level effect buses: at most one shared reverb and one shared
  // echo per record. The value true selects tuned defaults; objects
  // override them.
  function readFxSchedule(audio) {
    var out = { reverb: null, delay: null };
    if (!audio || typeof audio.fx !== 'object' || !audio.fx) return out;
    var rev = audio.fx.reverb;
    if (rev === true) {
      out.reverb = { decay: 1.8 };
    } else if (rev && typeof rev === 'object') {
      var decay = rev.decay == null ? 1.8 : clamp(Number(rev.decay), 0.5, 3);
      if (isNaN(decay)) decay = 1.8;
      out.reverb = { decay: decay };
    }
    var dly = audio.fx.delay;
    if (dly === true) {
      out.delay = { time: 0.375, feedback: 0.35, mix: 0.25 };
    } else if (dly && typeof dly === 'object') {
      var time = dly.time == null ? 0.375 : clamp(Number(dly.time), 0.03, 2);
      if (isNaN(time)) time = 0.375;
      var feedback = dly.feedback == null ? 0.35 : clamp(Number(dly.feedback), 0, 0.85);
      if (isNaN(feedback)) feedback = 0.35;
      var mix = dly.mix == null ? 0.25 : clamp(Number(dly.mix), 0, 1);
      if (isNaN(mix)) mix = 0.25;
      out.delay = { time: time, feedback: feedback, mix: mix };
    }
    return out;
  }

  function mulberry32(seed) {
    var state = seed >>> 0;
    return function () {
      state |= 0; state = (state + 0x6D2B79F5) | 0;
      var t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function bitrateFor(width, height) {
    var pixels = width * height;
    if (pixels <= 640 * 360) return 3000000;
    if (pixels <= 1280 * 720) return 10000000;
    if (pixels <= 1920 * 1080) return 16000000;
    return 20000000;
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
      contract.render(t, canvas, ctx || null, activeAudioApi || null, activeSpeechApi || null);
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
    var audio = activeAudio;
    activeAudio = null;
    activeAudioSchedule = null;
    activeAudioApi = null;
    activeSpeechApi = null;
    try { window.MOBILE_AGENT_VIDEO_AUDIO = null; } catch (_) {}
    try { window.MOBILE_AGENT_VIDEO_SPEECH = null; } catch (_) {}
    if (audio) teardownAudioCapture(audio);
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

  function teardownAudioCapture(handle) {
    if (!handle) return;
    try {
      if (handle.autoplayTimer) clearTimeout(handle.autoplayTimer);
    } catch (_) {}
    handle.autoplayTimer = null;
    try {
      if (handle.reader) handle.reader.cancel().catch(function () {});
    } catch (_) {}
    handle.reader = null;
    stopLegacyPcmCapture(handle);
    try {
      if (handle.encoder) handle.encoder.close();
    } catch (_) {}
    handle.encoder = null;
    try {
      if (handle.context) handle.context.close().catch(function () {});
    } catch (_) {}
    handle.context = null;
    handle.pendingPts = [];
    handle.pcmParts = [];
    handle.pcmByteLength = 0;
    handle.pcmFirstPts = null;
  }

  function postAudioWarning(reason) {
    post({ type: 'mobileAgentVideoAudioWarning', reason: String(reason || 'Audio was skipped.') });
  }

  function noiseBuffer(ctx) {
    if (ctx.__mobileAgentNoise) return ctx.__mobileAgentNoise;
    var len = Math.floor(ctx.sampleRate * 2);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    var rand = mulberry32(0xC0FFEE);
    for (var i = 0; i < len; i += 1) data[i] = rand() * 2 - 1;
    ctx.__mobileAgentNoise = buf;
    return buf;
  }

  // Schedule-wide voice budget: thousands of live nodes can stall low-end
  // devices, so sound events past the budget are skipped with a warning
  // instead of failing the render. Counts events (note/hit/voice), not nodes.
  function claimVoice(handle) {
    handle.voices = (handle.voices | 0) + 1;
    if (handle.voices > 2048) {
      handle.voiceOverflow = true;
      return false;
    }
    return true;
  }

  // Procedural reverb impulse: stereo decaying noise with a one-pole
  // darkening pass, peak-normalized to 1. Seeded, so every record renders
  // the exact same room — deterministic like the noise buffer above.
  function makeImpulse(ctx, decaySeconds) {
    var rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * decaySeconds));
    var buf = ctx.createBuffer(2, len, rate);
    var rand = mulberry32(0x7E57B);
    var ch, i;
    for (ch = 0; ch < 2; ch += 1) {
      var data = buf.getChannelData(ch);
      var last = 0;
      for (i = 0; i < len; i += 1) {
        var t = i / len;
        var env = Math.pow(1 - t, 2.2);
        last = last + 0.3 * ((rand() * 2 - 1) - last);
        data[i] = last * env;
      }
    }
    var peak = 0.0001;
    for (ch = 0; ch < 2; ch += 1) {
      var scan = buf.getChannelData(ch);
      for (i = 0; i < len; i += 1) {
        var amp = scan[i] < 0 ? -scan[i] : scan[i];
        if (amp > peak) peak = amp;
      }
    }
    var inv = 1 / peak;
    for (ch = 0; ch < 2; ch += 1) {
      var norm = buf.getChannelData(ch);
      for (i = 0; i < len; i += 1) norm[i] = norm[i] * inv;
    }
    return buf;
  }

  function schedulePluck(handle, s, freq, startAt, endAt, out) {
    if (!claimVoice(handle)) return;
    var ctx = handle.context;
    var osc = ctx.createOscillator();
    osc.type = s.wave;
    osc.frequency.value = freq;
    var g = ctx.createGain();
    var peakAt = startAt + Math.min(s.attack, Math.max(0.005, (endAt - startAt) / 2));
    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.linearRampToValueAtTime(1, peakAt);
    g.gain.setValueAtTime(1, Math.max(peakAt, endAt - s.release));
    g.gain.linearRampToValueAtTime(0.0001, endAt);
    osc.connect(g);
    g.connect(out);
    osc.start(startAt);
    try { osc.stop(endAt + 0.05); } catch (_) {}
  }

  function schedulePadVoice(handle, s, freq, startAt, endAt, out) {
    if (!claimVoice(handle)) return;
    var ctx = handle.context;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.linearRampToValueAtTime(0.5, startAt + Math.min(s.attack, Math.max(0.05, endAt - startAt)));
    g.gain.setValueAtTime(0.5, Math.max(startAt, endAt - s.release));
    g.gain.linearRampToValueAtTime(0.0001, endAt);
    g.connect(out);
    var ratios = [1, 1.003];
    for (var i = 0; i < ratios.length; i += 1) {
      var osc = ctx.createOscillator();
      osc.type = s.wave;
      osc.frequency.value = freq * ratios[i];
      osc.connect(g);
      osc.start(startAt);
      try { osc.stop(endAt + 0.05); } catch (_) {}
    }
  }

  function scheduleNoiseWash(handle, s, startAt, endAt, out) {
    if (!claimVoice(handle)) return;
    var ctx = handle.context;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    var filter = ctx.createBiquadFilter();
    filter.type = s.filter;
    filter.frequency.setValueAtTime(s.filterFreq, startAt);
    if (s.filterEnd != null) {
      try { filter.frequency.exponentialRampToValueAtTime(s.filterEnd, endAt); } catch (_) {}
    }
    filter.Q.value = s.q;
    var g = ctx.createGain();
    var span = Math.max(0.01, endAt - startAt);
    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.linearRampToValueAtTime(0.9, startAt + Math.min(s.attack, span));
    g.gain.setValueAtTime(0.9, Math.max(startAt, endAt - s.release));
    g.gain.linearRampToValueAtTime(0.0001, endAt);
    src.connect(filter);
    filter.connect(g);
    g.connect(out);
    src.start(startAt);
    try { src.stop(endAt + 0.05); } catch (_) {}
  }

  // Sample-free drum kit. Each hit is a tiny deterministic graph from the
  // seeded noise buffer and plain oscillators — no samples, no network:
  // kick is a pitched-down sine plus a click transient, snare a triangle
  // body plus bandpassed noise, hats highpassed noise, clap a burst train.
  function scheduleKick(handle, p, startAt, out) {
    var ctx = handle.context;
    var osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(Math.max(20, 150 * p.tone), startAt);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, 40 * p.tone), startAt + 0.12);
    var g = ctx.createGain();
    var dur = 0.4 * p.decay;
    g.gain.setValueAtTime(Math.max(0.0001, p.level), startAt);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    osc.connect(g);
    g.connect(out);
    osc.start(startAt);
    try { osc.stop(startAt + dur + 0.05); } catch (_) {}
    var click = ctx.createOscillator();
    click.type = 'sine';
    click.frequency.value = 800 * p.tone;
    var cg = ctx.createGain();
    cg.gain.setValueAtTime(Math.max(0.0001, 0.4 * p.level), startAt);
    cg.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.03);
    click.connect(cg);
    cg.connect(out);
    click.start(startAt);
    try { click.stop(startAt + 0.08); } catch (_) {}
  }

  function scheduleSnare(handle, p, startAt, out) {
    var ctx = handle.context;
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 180 * p.tone;
    var g = ctx.createGain();
    var bodyDur = 0.12 * p.decay;
    g.gain.setValueAtTime(Math.max(0.0001, 0.7 * p.level), startAt);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + bodyDur);
    osc.connect(g);
    g.connect(out);
    osc.start(startAt);
    try { osc.stop(startAt + bodyDur + 0.05); } catch (_) {}
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    var ng = ctx.createGain();
    var noiseDur = 0.2 * p.decay;
    ng.gain.setValueAtTime(Math.max(0.0001, 0.5 * p.level), startAt);
    ng.gain.exponentialRampToValueAtTime(0.0001, startAt + noiseDur);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    src.start(startAt);
    try { src.stop(startAt + noiseDur + 0.05); } catch (_) {}
  }

  function scheduleHat(handle, p, startAt, out, open) {
    var ctx = handle.context;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    var g = ctx.createGain();
    var dur = (open ? 0.3 : 0.05) * p.decay;
    g.gain.setValueAtTime(Math.max(0.0001, 0.3 * p.level), startAt);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    src.connect(hp);
    hp.connect(g);
    g.connect(out);
    src.start(startAt);
    try { src.stop(startAt + dur + 0.05); } catch (_) {}
  }

  function scheduleClap(handle, p, startAt, out) {
    var ctx = handle.context;
    var b;
    for (b = 0; b < 3; b += 1) {
      var at = startAt + b * 0.025;
      var src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1200 * p.tone;
      bp.Q.value = 1.5;
      var g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0001, 0.5 * p.level), at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
      src.connect(bp);
      bp.connect(g);
      g.connect(out);
      src.start(at, (b * 0.13) % 1.5);
      try { src.stop(at + 0.08); } catch (_) {}
    }
    var tail = ctx.createBufferSource();
    tail.buffer = noiseBuffer(ctx);
    var tbp = ctx.createBiquadFilter();
    tbp.type = 'bandpass';
    tbp.frequency.value = 1200 * p.tone;
    tbp.Q.value = 1.5;
    var tg = ctx.createGain();
    var tailDur = 0.15 * p.decay;
    tg.gain.setValueAtTime(Math.max(0.0001, 0.4 * p.level), startAt);
    tg.gain.exponentialRampToValueAtTime(0.0001, startAt + tailDur);
    tail.connect(tbp);
    tbp.connect(tg);
    tg.connect(out);
    tail.start(startAt);
    try { tail.stop(startAt + tailDur + 0.05); } catch (_) {}
  }

  function scheduleDrumHit(handle, s, hitName, startAt, out) {
    if (!claimVoice(handle)) return;
    var p = s.kit[hitName] || s.kit.snare;
    if (hitName === 'kick') scheduleKick(handle, p, startAt, out);
    else if (hitName === 'snare') scheduleSnare(handle, p, startAt, out);
    else if (hitName === 'hat') scheduleHat(handle, p, startAt, out, false);
    else if (hitName === 'openhat') scheduleHat(handle, p, startAt, out, true);
    else if (hitName === 'clap') scheduleClap(handle, p, startAt, out);
  }

  // Voice ducking without a sidechain compressor (Web Audio has no sidechain
  // input): a ducked cue gets a second gain in series whose automation is
  // computed up front from the declared voice ranges. Only linear ramps and
  // sets with finite times are used, so a degenerate range degrades to a
  // slightly-off curve, never to silent audio. Overlapping ranges merge.
  function scheduleDuckGain(ctx, cue, t0, startAt, endAt) {
    if (cue.duckRanges.length === 0 || !(cue.duckAmount < 1)) return null;
    var attack = cue.duckAttack;
    var release = cue.duckRelease;
    var amount = cue.duckAmount;
    var merged = [];
    var i;
    for (i = 0; i < cue.duckRanges.length; i += 1) {
      var rs = Math.max(startAt, Math.min(endAt, t0 + cue.duckRanges[i].start));
      var re = Math.max(startAt, Math.min(endAt, t0 + cue.duckRanges[i].end));
      if (!(re > rs)) continue;
      if (merged.length > 0 && rs - merged[merged.length - 1].end < attack + release) {
        if (re > merged[merged.length - 1].end) merged[merged.length - 1].end = re;
      } else {
        merged.push({ start: rs, end: re });
      }
    }
    if (merged.length === 0) return null;
    var g = ctx.createGain();
    g.gain.setValueAtTime(1, startAt);
    for (i = 0; i < merged.length; i += 1) {
      var dip = Math.max(startAt, merged[i].start - attack);
      if (dip > startAt) g.gain.setValueAtTime(1, dip);
      g.gain.linearRampToValueAtTime(amount, merged[i].start);
      g.gain.setValueAtTime(amount, merged[i].end);
      var out = Math.min(endAt, merged[i].end + release);
      if (out > merged[i].end) g.gain.linearRampToValueAtTime(1, out);
    }
    return g;
  }

  function scheduleSynthCue(handle, cue, startAt, endAt, out) {
    var s = cue.synth;
    var i;
    if (s.kind === 'tone') {
      for (i = 0; i < s.freqs.length; i += 1) {
        var nStart = startAt + i * s.noteDur;
        if (nStart >= endAt) break;
        schedulePluck(handle, s, s.freqs[i], nStart, Math.min(endAt, nStart + s.noteDur + s.release), out);
      }
    } else if (s.kind === 'pad') {
      for (i = 0; i < s.freqs.length; i += 1) {
        schedulePadVoice(handle, s, s.freqs[i], startAt, endAt, out);
      }
    } else if (s.kind === 'noise') {
      scheduleNoiseWash(handle, s, startAt, endAt, out);
    } else if (s.kind === 'drums') {
      for (i = 0; i < s.hits.length; i += 1) {
        var hitAt = startAt + s.hits[i].at;
        if (hitAt >= endAt) break;
        scheduleDrumHit(handle, s, s.hits[i].hit, hitAt, out);
      }
    }
  }

  function scheduleAudioCue(handle, cue, t0) {
    var ctx = handle.context;
    var startAt = t0 + cue.start;
    var endAt = startAt + cue.duration;
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(Math.max(0.0001, cue.volume), startAt + Math.min(cue.fadeIn, cue.duration));
    gain.gain.setValueAtTime(Math.max(0.0001, cue.volume), Math.max(startAt, endAt - cue.fadeOut));
    gain.gain.linearRampToValueAtTime(0.0001, endAt);
    var bus = gain;
    var duckGain = scheduleDuckGain(ctx, cue, t0, startAt, endAt);
    if (duckGain) {
      gain.connect(duckGain);
      bus = duckGain;
    }
    bus.connect(handle.master);
    if (handle.fxReverb && cue.reverb > 0) {
      var revSend = ctx.createGain();
      revSend.gain.value = cue.reverb;
      bus.connect(revSend);
      revSend.connect(handle.fxReverb);
    }
    if (handle.fxDelay && cue.delay > 0) {
      var dlySend = ctx.createGain();
      dlySend.gain.value = cue.delay;
      bus.connect(dlySend);
      dlySend.connect(handle.fxDelay);
    }
    if (cue.kind === 'file') {
      var entry = null;
      for (var i = 0; i < handle.decoded.length; i += 1) {
        if (handle.decoded[i].cue === cue) { entry = handle.decoded[i]; break; }
      }
      if (!entry) return;
      var src = ctx.createBufferSource();
      src.buffer = entry.buffer;
      src.loop = cue.loop === true;
      src.connect(gain);
      if (cue.loop) {
        var loopOffset = cue.offset % entry.buffer.duration;
        src.start(startAt, loopOffset < 0 ? 0 : loopOffset);
        try { src.stop(endAt + 0.05); } catch (_) {}
      } else {
        var avail = Math.max(0, entry.buffer.duration - cue.offset);
        var playDur = Math.min(cue.duration, avail);
        if (playDur <= 0) return;
        src.start(startAt, cue.offset, playDur);
        try { src.stop(startAt + playDur + 0.05); } catch (_) {}
      }
      return;
    }
    scheduleSynthCue(handle, cue, startAt, endAt, gain);
  }

  function onAudioChunk(handle, chunk) {
    if (cancelled || !handle || activeAudio !== handle) return;
    var pts = handle.pendingPts.length > 0 ? handle.pendingPts.shift() : 0;
    var bytes = new Uint8Array(chunk.byteLength);
    try {
      chunk.copyTo(bytes);
    } catch (_) {
      return;
    }
    if (bytes.byteLength === 0) return;
    post({ type: 'mobileAgentVideoAudioChunk', pts: pts, base64: bytesToBase64(bytes) });
  }

  function audioDataToS16(data, expectedChannels) {
    var channels = data ? (data.numberOfChannels | 0) : 0;
    var frames = data ? (data.numberOfFrames | 0) : 0;
    if (!(channels >= 1 && channels <= 2) || !(frames > 0)) return null;
    var format = String((data && data.format) || '');
    var isPlanar = format.indexOf('planar') >= 0;
    var out = new Int16Array(frames * channels);
    var ch = 0;
    var f = 0;
    var i = 0;
    var v = 0;
    try {
      if (format.indexOf('s16') === 0) {
        if (!isPlanar) {
          var size = data.allocationSize({ planeIndex: 0, format: 's16' });
          var buf = new ArrayBuffer(size);
          data.copyTo(buf, { planeIndex: 0, format: 's16' });
          var s16 = new Int16Array(buf);
          if (s16.length < frames * channels) return null;
          if (channels === expectedChannels || expectedChannels == null) {
            return { bytes: new Uint8Array(buf, 0, frames * channels * 2), channels: channels, frames: frames };
          }
          out.set(s16.subarray(0, frames * channels));
        } else {
          for (ch = 0; ch < channels; ch += 1) {
            var psize = data.allocationSize({ planeIndex: ch, format: 's16-planar' });
            var pbuf = new ArrayBuffer(psize);
            data.copyTo(pbuf, { planeIndex: ch, format: 's16-planar' });
            var pin = new Int16Array(pbuf);
            for (f = 0; f < frames; f += 1) out[f * channels + ch] = pin[f];
          }
        }
      } else if (format.indexOf('f32') === 0) {
        if (!isPlanar) {
          var fsize = data.allocationSize({ planeIndex: 0, format: 'f32' });
          var fbuf = new ArrayBuffer(fsize);
          data.copyTo(fbuf, { planeIndex: 0, format: 'f32' });
          var fin = new Float32Array(fbuf);
          for (i = 0; i < frames * channels; i += 1) {
            v = fin[i];
            if (v > 1) v = 1;
            else if (v < -1) v = -1;
            out[i] = Math.round(v * 32767);
          }
        } else {
          for (ch = 0; ch < channels; ch += 1) {
            var qsize = data.allocationSize({ planeIndex: ch, format: 'f32-planar' });
            var qbuf = new ArrayBuffer(qsize);
            data.copyTo(qbuf, { planeIndex: ch, format: 'f32-planar' });
            var qin = new Float32Array(qbuf);
            for (f = 0; f < frames; f += 1) {
              v = qin[f];
              if (v > 1) v = 1;
              else if (v < -1) v = -1;
              out[f * channels + ch] = Math.round(v * 32767);
            }
          }
        }
      } else {
        return null;
      }
    } catch (_) {
      return null;
    }
    if (channels === 1 && expectedChannels === 2) {
      var stereo = new Int16Array(frames * 2);
      for (f = 0; f < frames; f += 1) {
        stereo[f * 2] = out[f];
        stereo[f * 2 + 1] = out[f];
      }
      return { bytes: new Uint8Array(stereo.buffer), channels: 2, frames: frames };
    }
    if (channels !== expectedChannels && expectedChannels != null) return null;
    return { bytes: new Uint8Array(out.buffer), channels: channels, frames: frames };
  }

  function flushPcmBatch(handle) {
    if (!handle || !handle.pcmMode) return;
    if (!handle.pcmParts || handle.pcmByteLength <= 0 || handle.pcmFirstPts == null) {
      handle.pcmParts = [];
      handle.pcmByteLength = 0;
      handle.pcmFirstPts = null;
      return;
    }
    var merged = new Uint8Array(handle.pcmByteLength);
    var offset = 0;
    for (var i = 0; i < handle.pcmParts.length; i += 1) {
      merged.set(handle.pcmParts[i], offset);
      offset += handle.pcmParts[i].length;
    }
    var pts = handle.pcmFirstPts;
    handle.pcmParts = [];
    handle.pcmByteLength = 0;
    handle.pcmFirstPts = null;
    if (merged.length === 0) return;
    post({ type: 'mobileAgentVideoAudioPcmChunk', pts: pts, base64: bytesToBase64(merged) });
  }

  function accumulatePcm(handle, pcm, pts) {
    if (!handle || !pcm || !pcm.bytes || pcm.bytes.length === 0) return;
    handle.pcmBytesCaptured = (handle.pcmBytesCaptured || 0) + pcm.bytes.length;
    if (handle.pcmFirstPts == null) handle.pcmFirstPts = pts;
    handle.pcmParts.push(pcm.bytes);
    handle.pcmByteLength += pcm.bytes.length;
    if (handle.pcmByteLength >= 16384) flushPcmBatch(handle);
  }

  function stopLegacyPcmCapture(handle) {
    if (!handle || !handle.pcmProcessor) return;
    handle.pcmProcessor.onaudioprocess = null;
    try { handle.master.disconnect(handle.pcmProcessor); } catch (_) {}
    try { handle.pcmProcessor.disconnect(); } catch (_) {}
    try { handle.pcmSink.disconnect(); } catch (_) {}
    handle.pcmProcessor = null;
    handle.pcmSink = null;
  }

  // Compatibility only: some WebViews expose TrackProcessor but reject audio
  // tracks. ScriptProcessor is deprecated, but works without secure-context
  // AudioWorklet support on the existing inline HTML/about:blank renderer.
  function startLegacyPcmCapture(handle) {
    var ctx = handle.context;
    var channels = handle.pcmChannels;
    var processor = ctx.createScriptProcessor(4096, channels, channels);
    var sink = ctx.createGain();
    sink.gain.value = 0;
    handle.pcmProcessor = processor;
    handle.pcmSink = sink;
    var capturedFrames = 0;
    processor.onaudioprocess = function (event) {
      if (cancelled || activeAudio !== handle) return;
      var input = event.inputBuffer;
      var frames = input.length;
      var pcm = new Int16Array(frames * channels);
      for (var ch = 0; ch < channels; ch += 1) {
        var samples = input.getChannelData(Math.min(ch, input.numberOfChannels - 1));
        for (var f = 0; f < frames; f += 1) {
          pcm[f * channels + ch] = Math.round(clamp(samples[f], -1, 1) * 32767);
        }
      }
      var pts = Math.max(0, Math.round(capturedFrames * 1000000 / ctx.sampleRate - handle.leadUs));
      capturedFrames += frames;
      accumulatePcm(handle, { bytes: new Uint8Array(pcm.buffer) }, pts);
    };
    handle.master.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
  }

  function pumpAudio(handle) {
    var reader = handle.reader;
    if (!reader) return;
    reader.read().then(function (result) {
      if (cancelled || activeAudio !== handle || !result || result.done) return;
      var data = result.value;
      if (handle.stopping) {
        try { data.close(); } catch (_) {}
        return;
      }
      try {
        if (handle.firstTs < 0) handle.firstTs = data.timestamp;
        var pts = Math.round(data.timestamp - handle.firstTs - handle.leadUs);
        if (pts < 0 || isNaN(pts)) pts = 0;
        if (handle.pcmMode) {
          var pcm = audioDataToS16(data, handle.pcmChannels || 2);
          if (!pcm) {
            postAudioWarning('Audio samples could not be read; continuing silent.');
            teardownAudioCapture(handle);
            if (activeAudio === handle) activeAudio = null;
            return;
          }
          accumulatePcm(handle, pcm, pts);
        } else {
          handle.pendingPts.push(pts);
          handle.encoder.encode(data);
        }
      } catch (error) {
        postAudioWarning('Audio sample processing failed; continuing silent.');
        teardownAudioCapture(handle);
        if (activeAudio === handle) activeAudio = null;
      } finally {
        try { data.close(); } catch (_) {}
      }
      pumpAudio(handle);
    }).catch(function () {
      // Reader was cancelled during teardown.
    });
  }

  function startAudioReader(handle) {
    var track = null;
    try {
      var stream = handle.dest.stream;
      track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
      if (!track) throw new Error('no audio track');
      var processor = new MediaStreamTrackProcessor({ track: track });
      handle.reader = processor.readable.getReader();
    } catch (error) {
      if (handle.pcmMode && typeof handle.context.createScriptProcessor === 'function') {
        try {
          startLegacyPcmCapture(handle);
          return;
        } catch (_) {
          stopLegacyPcmCapture(handle);
        }
      }
      postAudioWarning('Audio capture is unavailable on this device; continuing silent.');
      teardownAudioCapture(handle);
      if (activeAudio === handle) activeAudio = null;
      return;
    }
    pumpAudio(handle);
  }

  function beginAudioCapture() {
    var handle = activeAudio;
    var schedule = activeAudioSchedule;
    if (!handle || !schedule || handle.started) return;
    handle.started = true;
    handle.context.resume().catch(function () {}).then(function () {
      if (cancelled || activeAudio !== handle) return;
      var t0 = handle.context.currentTime + 0.03;
      try {
        for (var i = 0; i < schedule.cues.length; i += 1) {
          scheduleAudioCue(handle, schedule.cues[i], t0);
        }
        if (handle.voiceOverflow) {
          postAudioWarning('Too many simultaneous sounds were scheduled; some were skipped to protect playback.');
        }
        for (var c = 0; c < schedule.cues.length; c += 1) {
          var skipCue = schedule.cues[c];
          if (skipCue.kind === 'synth' && skipCue.synth.kind === 'drums' && skipCue.synth.capped) {
            postAudioWarning('Drum steps past 512 hits were skipped; shorten the pattern or split it across tracks.');
            break;
          }
        }
      } catch (error) {
        postAudioWarning('Audio scheduling failed; continuing silent.');
        teardownAudioCapture(handle);
        activeAudio = null;
        return;
      }
      startAudioReader(handle);
      handle.autoplayTimer = setTimeout(function () {
        handle.autoplayTimer = null;
        if (cancelled || activeAudio !== handle) return;
        try {
          if (handle.context && handle.context.state !== 'running') {
            postAudioWarning('Audio playback was blocked; continuing silent.');
            teardownAudioCapture(handle);
            activeAudio = null;
          }
        } catch (_) {}
      }, 800);
      timers.push(handle.autoplayTimer);
    });
  }

  function flushAudioCapture() {
    var handle = activeAudio;
    if (!handle) return Promise.resolve();
    handle.stopping = true;
    if (handle.autoplayTimer) {
      try { clearTimeout(handle.autoplayTimer); } catch (_) {}
      handle.autoplayTimer = null;
    }
    try {
      if (handle.reader) handle.reader.cancel().catch(function () {});
    } catch (_) {}
    handle.reader = null;
    stopLegacyPcmCapture(handle);
    flushPcmBatch(handle);
    if (handle.pcmMode && !handle.pcmBytesCaptured) {
      postAudioWarning('The audio capture produced no samples; this video is silent.');
    }
    var enc = handle.encoder;
    handle.encoder = null;
    if (!enc) return Promise.resolve();
    return enc.flush().then(function () {
      try { enc.close(); } catch (_) {}
    }).catch(function () {
      try { enc.close(); } catch (_) {}
    });
  }

  // Mixes the schedule's file cues into a mono buffer (honoring start/offset/
  // duration/loop/volume/fades and master gain) and extracts the feature track
  // the page reacts to. Returns null when there is nothing analyzable; callers
  // still receive a stable "not ready" audio object.
  function collectFileClips(schedule, decoded) {
    var clips = [];
    for (var i = 0; i < decoded.length; i += 1) {
      var entry = decoded[i];
      var cue = entry && entry.cue;
      var buffer = entry && entry.buffer;
      if (!cue || cue.kind !== 'file' || !buffer) continue;
      var channels = [];
      var count = Math.min(buffer.numberOfChannels, 2);
      for (var c = 0; c < count; c += 1) channels.push(buffer.getChannelData(c));
      if (channels.length === 0) continue;
      clips.push({
        channels: channels,
        sampleRate: buffer.sampleRate,
        start: cue.start,
        offset: cue.offset,
        duration: cue.duration,
        loop: cue.loop,
        volume: cue.volume,
        fadeIn: cue.fadeIn,
        fadeOut: cue.fadeOut
      });
    }
    return clips;
  }

  function analyzeMixedClips(clips, duration, sampleRate, masterLevel) {
    if (!analysis || clips.length === 0 || !(sampleRate > 0)) return null;
    try {
      var samples = analysis.mixClipsToMono(clips, duration, sampleRate, masterLevel);
      return analysis.analyzeAudio(samples, sampleRate, duration);
    } catch (_) {
      return null;
    }
  }

  function buildFxBuses(context, master, fx) {
    var buses = { fxReverb: null, fxDelay: null };
    fx = fx || { reverb: null, delay: null };
    if (fx.reverb) {
      try {
        var conv = context.createConvolver();
        conv.buffer = makeImpulse(context, fx.reverb.decay);
        var wet = context.createGain();
        wet.gain.value = 0.5;
        conv.connect(wet);
        wet.connect(master);
        buses.fxReverb = conv;
      } catch (_) {
        postAudioWarning('Reverb is not supported here; continuing dry.');
      }
    }
    if (fx.delay) {
      try {
        var dly = context.createDelay(2.0);
        dly.delayTime.value = fx.delay.time;
        var fb = context.createGain();
        fb.gain.value = fx.delay.feedback;
        var damp = context.createBiquadFilter();
        damp.type = 'lowpass';
        damp.frequency.value = 2000;
        var dwet = context.createGain();
        dwet.gain.value = fx.delay.mix;
        dly.connect(fb);
        fb.connect(damp);
        damp.connect(dly);
        dly.connect(dwet);
        dwet.connect(master);
        buses.fxDelay = dly;
      } catch (_) {
        postAudioWarning('Echo is not supported here; continuing dry.');
      }
    }
    return buses;
  }

  // Renders generated (synth/drums) cues through an offline context so the
  // visualizer sees them like file audio. Reuses the exact schedule path —
  // file cues find no decoded entry and skip themselves — with t0 = 0 so the
  // stem stays glued to video time. Cue volumes, fades, ducking, and wet
  // sends are baked in; the schedule master is left for the mixer.
  function renderSynthStems(schedule, duration, sampleRate) {
    var hasSynth = false;
    var i;
    for (i = 0; i < schedule.cues.length; i += 1) {
      if (schedule.cues[i].kind === 'synth') { hasSynth = true; break; }
    }
    if (!hasSynth) return Promise.resolve(null);
    if (typeof OfflineAudioContext === 'undefined') {
      postAudioWarning('Generated sounds cannot feed the visualizer on this device.');
      return Promise.resolve(null);
    }
    var offline = null;
    try {
      offline = new OfflineAudioContext(2, Math.max(1, Math.ceil(sampleRate * duration)), sampleRate);
    } catch (_) {
      return Promise.resolve(null);
    }
    try {
      var master = offline.createGain();
      master.gain.value = 1;
      master.connect(offline.destination);
      var buses = buildFxBuses(offline, master, schedule.fx);
      var stemHandle = {
        context: offline, master: master, decoded: [],
        voices: 0, voiceOverflow: false,
        fxReverb: buses.fxReverb, fxDelay: buses.fxDelay
      };
      for (i = 0; i < schedule.cues.length; i += 1) {
        var cue = schedule.cues[i];
        if (cue.kind !== 'synth') continue;
        scheduleAudioCue(stemHandle, cue, 0);
      }
      return offline.startRendering();
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function analyzeScheduleAudioAsync(schedule, decoded, duration, sampleRate) {
    if (!analysis || !schedule || !(sampleRate > 0)) return Promise.resolve(null);
    var clips = [];
    try {
      clips = collectFileClips(schedule, decoded);
    } catch (_) {
      clips = [];
    }
    return renderSynthStems(schedule, duration, sampleRate).then(function (stem) {
      if (stem) {
        try {
          var channels = [];
          var count = Math.min(stem.numberOfChannels, 2);
          for (var c = 0; c < count; c += 1) channels.push(stem.getChannelData(c));
          if (channels.length > 0) {
            clips.push({
              channels: channels,
              sampleRate: sampleRate,
              start: 0,
              offset: 0,
              duration: duration,
              loop: false,
              volume: 1,
              fadeIn: 0,
              fadeOut: 0
            });
          }
        } catch (_) {}
      }
      return analyzeMixedClips(clips, duration, sampleRate, schedule.master);
    }, function () {
      return analyzeMixedClips(clips, duration, sampleRate, schedule.master);
    });
  }

  function prepareAudioCapture(schedule, duration) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      post({ type: 'mobileAgentVideoAudioUnsupported', reason: 'This WebView does not support Web Audio.' });
      return Promise.resolve(null);
    }
    var ctx = null;
    try {
      // Force a standard rate so the AAC track's AudioSpecificConfig is always
      // expressible (48 kHz is universally supported by the native muxer).
      ctx = new AC({ sampleRate: 48000 });
    } catch (error) {
      try {
        ctx = new AC();
      } catch (fallbackError) {
        post({ type: 'mobileAgentVideoAudioUnsupported', reason: 'Audio could not start.' });
        return Promise.resolve(null);
      }
    }
    var context = ctx;
    var decoded = [];
    var standardRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
    if (standardRates.indexOf(context.sampleRate) < 0) {
      try { context.close().catch(function () {}); } catch (_) {}
      post({
        type: 'mobileAgentVideoAudioUnsupported',
        reason: 'Unsupported audio sample rate: ' + context.sampleRate + ' Hz.'
      });
      return Promise.resolve(null);
    }
    return context.suspend().catch(function () {}).then(function () {
      var chain = Promise.resolve();
      schedule.cues.forEach(function (cue) {
        if (cue.kind !== 'file') return;
        chain = chain.then(function () {
          return fetch(cue.src).then(function (res) {
            if (!res.ok) throw new Error('fetch failed');
            return res.arrayBuffer();
          }).then(function (buf) {
            return context.decodeAudioData(buf);
          }).then(function (audioBuf) {
            decoded.push({ cue: cue, buffer: audioBuf });
          }).catch(function () {
            postAudioWarning('An audio file could not be decoded and was skipped.');
          });
        });
      });
      return chain;
    }).then(function () {
      // The stem render is async; everything below waits on it so generated
      // beds are part of the features before the first frame records.
      return analyzeScheduleAudioAsync(schedule, decoded, duration, context.sampleRate).then(function (features) {
      var master = context.createGain();
      master.gain.value = schedule.master;
      var dest = context.createMediaStreamDestination();
      try { dest.channelCount = 2; } catch (_) {}
      master.connect(dest);
      var buses = buildFxBuses(context, master, schedule.fx);
      var fxReverb = buses.fxReverb;
      var fxDelay = buses.fxDelay;
      var pcmChannels = dest.channelCount || 2;
      if (pcmChannels !== 1 && pcmChannels !== 2) pcmChannels = 2;
      var aacConfig = {
        codec: 'mp4a.40.2',
        sampleRate: context.sampleRate,
        numberOfChannels: 2,
        bitrate: 128000
      };
      var aacPossible = null;
      if (!window.AudioEncoder || !window.MediaStreamTrackProcessor) {
        aacPossible = Promise.resolve(false);
      } else if (window.AudioEncoder.isConfigSupported) {
        try {
          aacPossible = window.AudioEncoder.isConfigSupported(aacConfig).then(function (info) {
            return !!(info && info.supported);
          }).catch(function () {
            return false;
          });
        } catch (_) {
          aacPossible = Promise.resolve(false);
        }
      } else {
        aacPossible = Promise.resolve(true);
      }
      return aacPossible.then(function (ok) {
        var handle = {
          context: context, encoder: null, master: master, dest: dest,
          decoded: decoded, started: false, firstTs: -1, pendingPts: [],
          reader: null, autoplayTimer: null, leadUs: 30000,
          pcmMode: !ok, pcmChannels: pcmChannels,
          pcmParts: [], pcmByteLength: 0, pcmFirstPts: null,
          features: features, voices: 0, voiceOverflow: false,
          fxReverb: fxReverb, fxDelay: fxDelay
        };
        if (ok) {
          try {
            var encoder = new AudioEncoder({
              output: function (chunk) { onAudioChunk(handle, chunk); },
              error: function () {
                postAudioWarning('Audio encoding failed; continuing silent.');
                if (activeAudio === handle) {
                  teardownAudioCapture(handle);
                  activeAudio = null;
                } else {
                  teardownAudioCapture(handle);
                }
              }
            });
            encoder.configure(aacConfig);
            handle.encoder = encoder;
            handle.pcmMode = false;
            post({ type: 'mobileAgentVideoAudioConfig', sampleRate: context.sampleRate, channels: 2, encoding: 'aac' });
          } catch (_) {
            try { if (encoder) encoder.close(); } catch (closeError) {}
            handle.encoder = null;
            handle.pcmMode = true;
            post({ type: 'mobileAgentVideoAudioConfig', sampleRate: context.sampleRate, channels: pcmChannels, encoding: 'pcm16' });
          }
        } else {
          post({ type: 'mobileAgentVideoAudioConfig', sampleRate: context.sampleRate, channels: pcmChannels, encoding: 'pcm16' });
        }
        return handle;
      });
      });
    }).catch(function (error) {
      try { context.close().catch(function () {}); } catch (_) {}
      var detail = error && error.message ? ' ' + error.message : '';
      post({ type: 'mobileAgentVideoAudioUnsupported', reason: 'Audio could not start on this device.' + detail });
      return null;
    });
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

    var schedule = readAudioSchedule(contract, duration);
    activeAudioSchedule = schedule;
    var audioReady = schedule ? prepareAudioCapture(schedule, duration) : Promise.resolve(null);
    var videoReady = supportsH264Encoder(width, height, fps);
    Promise.all([audioReady, videoReady]).then(function (results) {
      if (cancelled) {
        if (results[0]) teardownAudioCapture(results[0]);
        return;
      }
      activeAudio = results[0];
      activeAudioApi = analysis ? analysis.createAudioApi(activeAudio ? activeAudio.features : null) : null;
      try { window.MOBILE_AGENT_VIDEO_AUDIO = activeAudioApi; } catch (_) {}
      activeSpeechApi = (analysis && analysis.createSpeechApi)
        ? analysis.createSpeechApi(contract.speech, duration)
        : null;
      try { window.MOBILE_AGENT_VIDEO_SPEECH = activeSpeechApi; } catch (_) {}
      if (results[1]) runH264(contract, canvas, ctx, width, height, fps, frameCount);
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
        flushAudioCapture().then(function () {
          if (cancelled) return;
          post({ type: 'mobileAgentVideoDone', emitted: emitted });
          teardown();
        });
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
    beginAudioCapture();
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
        flushAudioCapture().then(function () {
          if (cancelled) { teardown(); return; }
          post({ type: 'mobileAgentVideoDone', emitted: emitted });
          teardown();
        });
        return;
      }
      var t = index / fps;
      if (!renderFrame(contract, canvas, ctx, t)) return;
      var dataUrl = null;
      try {
        dataUrl = canvas.toDataURL('image/jpeg', 0.92);
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

    beginAudioCapture();
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
  // Reused by same-page tools (mix check): schedule validation, cue
  // scheduling, and FX buses without starting a recording.
  window.__mobileAgentAudioEngine = {
    readAudioSchedule: readAudioSchedule,
    scheduleAudioCue: scheduleAudioCue,
    buildFxBuses: buildFxBuses
  };
})();
`;

/**
 * Injects the recorder script into a preview document right before `</body>`
 * (or appends it when the document has no body tag), so the page evaluates it
 * on load and `window.__startMobileAgentVideoExport` can be called later.
 */
export function buildVideoExportDocument(html: string): string {
  const script = `\n<script>${VIDEO_AUDIO_ANALYSIS_SCRIPT}</script>\n<script>${VIDEO_CHROMA_KEY_SCRIPT}</script>\n<script>${VIDEO_EXPORT_SCRIPT}</script>\n`;
  const lower = html.toLowerCase();
  const index = lower.lastIndexOf("</body>");
  if (index === -1) return `${html}${script}`;
  return `${html.slice(0, index)}${script}${html.slice(index)}`;
}
