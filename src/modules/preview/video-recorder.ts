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
 *  - Video: each frame is posted as a JPEG and encoded by native MediaCodec.
 *    The producer waits for native acknowledgement; slower devices take longer
 *    to export rather than silently dropping frames.
 *  - Audio path (optional `audio` schedule): file cues (data-URI audio, inlined
 *    by the renderVideo tool) and synthesized cues are mixed in a WebAudio
 *    OfflineAudioContext, sent as continuous PCM16, AAC-encoded natively, and
 *    muxed as a second track. Requested soundtracks fail explicitly if audio
 *    cannot be rendered, rather than producing a silently incomplete export.
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
 * Scenes with custom source-video timelines may provide async prepareFrame(t).
 */
export const VIDEO_EXPORT_SCRIPT = `(function () {
  if (window.__mobileAgentVideoExportScript) return;
  window.__mobileAgentVideoExportScript = true;

  var running = false;
  var cancelled = true;
  var timers = [];
  var stage = null;
  var hijackedCanvas = null;
  var saved = null;
  var activeAudio = null;
  var activeAudioApi = null;
  var activeSpeechApi = null;
  var analysis = (typeof window !== 'undefined' && window.__mobileAgentAudioAnalysis) || null;
  var consumeId = 0;
  var pendingConsume = null;

  window.__mobileAgentExportConsumed = function (id) {
    var pending = pendingConsume;
    if (!pending || pending.id !== id) return;
    pendingConsume = null;
    clearTimeout(pending.timer);
    pending.resolve();
  };

  function postAndWait(payload) {
    return new Promise(function (resolve, reject) {
      if (cancelled) { reject(new Error('Video export cancelled.')); return; }
      var id = ++consumeId;
      payload.requestId = id;
      var timer = setTimeout(function () {
        if (!pendingConsume || pendingConsume.id !== id) return;
        pendingConsume = null;
        reject(new Error('Native encoder did not acknowledge the export data within 30 seconds.'));
      }, 30000);
      pendingConsume = { id: id, timer: timer, resolve: resolve, reject: reject };
      post(payload);
    });
  }

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
    var audio = activeAudio;
    activeAudio = null;
    activeAudioApi = null;
    activeSpeechApi = null;
    try { window.MOBILE_AGENT_VIDEO_AUDIO = null; } catch (_) {}
    try { window.MOBILE_AGENT_VIDEO_SPEECH = null; } catch (_) {}
    if (audio) releaseAudio(audio);
    timers.forEach(function (timer) { clearTimeout(timer); });
    timers = [];
    if (pendingConsume) {
      var pending = pendingConsume;
      pendingConsume = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('Video export stopped.'));
    }
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

  function releaseAudio(handle) {
    if (!handle) return;
    handle.context = null;
    handle.offlineBuffer = null;
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

  // Export sound in sample time, not wall time. Rendering a frame may take
  // seconds without dropping an audio callback or stretching AAC timestamps.
  function prepareOfflineAudio(schedule, duration) {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error('Offline audio rendering is unavailable on this device.'));
    var context = new Offline(2, Math.ceil(duration * 48000), 48000);
    var master = context.createGain();
    master.gain.value = schedule.master;
    master.connect(context.destination);
    var buses = buildFxBuses(context, master, schedule.fx);
    var handle = {
      context: context, master: master, decoded: [],
      fxReverb: buses.fxReverb, fxDelay: buses.fxDelay,
      voices: 0, voiceOverflow: false, offlineBuffer: null, features: null
    };
    var chain = Promise.resolve();
    schedule.cues.forEach(function (cue) {
      if (cue.kind !== 'file') return;
      chain = chain.then(function () {
        if (cancelled) throw new Error('Video export cancelled.');
        return fetch(cue.src).then(function (response) {
          if (!response.ok) throw new Error('Could not load an audio asset.');
          return response.arrayBuffer();
        }).then(function (bytes) { return context.decodeAudioData(bytes); })
          .then(function (buffer) { handle.decoded.push({ cue: cue, buffer: buffer }); });
      });
    });
    return chain.then(function () {
      if (cancelled) throw new Error('Video export cancelled.');
      schedule.cues.forEach(function (cue) { scheduleAudioCue(handle, cue, 0); });
      if (handle.voiceOverflow) throw new Error('The soundtrack exceeds the supported simultaneous voice limit.');
      if (schedule.cues.some(function (cue) { return cue.kind === 'synth' && cue.synth.kind === 'drums' && cue.synth.capped; })) {
        postAudioWarning('Drum steps past 512 hits were skipped; shorten the pattern or split it across tracks.');
      }
      return context.startRendering();
    }).then(function (buffer) {
      if (cancelled) throw new Error('Video export cancelled.');
      handle.offlineBuffer = buffer;
      var channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
      handle.features = analyzeMixedClips([{
        channels: channels, sampleRate: 48000, start: 0, offset: 0,
        duration: duration, loop: false, volume: 1, fadeIn: 0, fadeOut: 0
      }], duration, 48000, 1);
      // Release source buffers and the offline graph after mixing. Only the
      // bounded final soundtrack (at most 45 seconds) remains during export.
      handle.decoded = [];
      handle.context = null;
      handle.master = null;
      handle.fxReverb = null;
      handle.fxDelay = null;
      post({ type: 'mobileAgentVideoAudioConfig', sampleRate: 48000, channels: 2, encoding: 'pcm16' });
      return handle;
    });
  }

  function sendOfflineAudio() {
    var buffer = activeAudio && activeAudio.offlineBuffer;
    if (!buffer) return Promise.resolve();
    var left = buffer.getChannelData(0);
    var right = buffer.getChannelData(1);
    var offset = 0;
    function next() {
      if (cancelled) return Promise.reject(new Error('Video export cancelled.'));
      if (offset >= buffer.length) return Promise.resolve();
      var count = Math.min(4096, buffer.length - offset);
      var bytes = new Uint8Array(count * 4);
      var view = new DataView(bytes.buffer);
      for (var i = 0; i < count; i += 1) {
        view.setInt16(i * 4, Math.round(clamp(left[offset + i], -1, 1) * 32767), true);
        view.setInt16(i * 4 + 2, Math.round(clamp(right[offset + i], -1, 1) * 32767), true);
      }
      var pts = Math.round(offset * 1000000 / 48000);
      offset += count;
      return postAndWait({ type: 'mobileAgentVideoAudioPcmChunk', pts: pts, base64: bytesToBase64(bytes) }).then(next);
    }
    return next();
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

    try {
      hijackCanvas(canvas, width, height);
    } catch (error) {
      fail('Video canvas setup failed: ' + String((error && error.message) || error));
      return;
    }
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
    var audioReady = schedule ? prepareOfflineAudio(schedule, duration) : Promise.resolve(null);
    audioReady.then(function (audio) {
      if (cancelled) {
        if (audio) releaseAudio(audio);
        return;
      }
      activeAudio = audio;
      activeAudioApi = analysis ? analysis.createAudioApi(activeAudio ? activeAudio.features : null) : null;
      try { window.MOBILE_AGENT_VIDEO_AUDIO = activeAudioApi; } catch (_) {}
      activeSpeechApi = (analysis && analysis.createSpeechApi)
        ? analysis.createSpeechApi(contract.speech, duration)
        : null;
      try { window.MOBILE_AGENT_VIDEO_SPEECH = activeSpeechApi; } catch (_) {}
      runNativeFrames(contract, canvas, ctx, fps, frameCount);
    }).catch(function (error) {
      // Rejections (decode failure, synth render failure) fail loud.
      // Never-settling promises still hang until the run aborts — no timer
      // by design; legit 45 s schedules can need the full prep budget.
      fail('Video export preparation failed: ' + String((error && error.message) || error));
    });
  }

  // Source video decoding is asynchronous. Never draw the previous decoded
  // frame immediately after assigning currentTime. Scenes with custom media
  // timelines can implement async prepareFrame(t) to map their own offsets.
  function prepareSourceFrame(contract, t, fps) {
    if (typeof contract.prepareFrame === 'function') {
      return Promise.resolve().then(function () { return contract.prepareFrame(t); });
    }
    var videos = document.querySelectorAll('video');
    var waits = [];
    for (var i = 0; i < videos.length; i += 1) {
      // Test doubles and non-media elements do not implement pause().
      if (typeof videos[i].pause !== 'function') continue;
      waits.push(seekSourceVideo(videos[i], t, fps));
    }
    return Promise.all(waits);
  }

  function seekSourceVideo(video, t, fps) {
    return new Promise(function (resolve, reject) {
      var target = null;
      var timer = setTimeout(function () { finish(new Error('Timed out decoding a source video frame.')); }, 15000);
      function finish(error) {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', seek);
        video.removeEventListener('seeked', ready);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        if (error) reject(error); else resolve();
      }
      function failed() { finish(new Error('A source video could not be decoded.')); }
      function ready() {
        if (cancelled) { finish(new Error('Video export cancelled.')); return; }
        if (!video.seeking && video.readyState >= 2) finish();
      }
      function seek() {
        if (cancelled) { finish(new Error('Video export cancelled.')); return; }
        video.pause();
        if (!(video.duration > 0) || !isFinite(video.duration)) { failed(); return; }
        target = video.loop ? t % video.duration : Math.min(t, Math.max(0, video.duration - 1 / fps));
        try {
          if (Math.abs(video.currentTime - target) > 0.0001) video.currentTime = target;
          ready();
        } catch (error) { finish(error); }
      }
      video.addEventListener('loadedmetadata', seek);
      video.addEventListener('seeked', ready);
      video.addEventListener('loadeddata', ready);
      video.addEventListener('error', failed);
      if (video.readyState >= 1) seek();
    });
  }

  function pauseSourceVideos() {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i += 1) {
      try { videos[i].pause(); } catch (_) {}
    }
  }

  function runNativeFrames(contract, canvas, ctx, fps, frameCount) {
    var index = 0;
    var emitted = 0;

    function tick() {
      if (cancelled) { teardown(); return; }
      if (index >= frameCount) {
        sendOfflineAudio().then(function () {
          if (cancelled) { teardown(); return; }
          post({ type: 'mobileAgentVideoDone', emitted: emitted });
          teardown();
        }).catch(function (error) {
          fail('Soundtrack export failed: ' + String((error && error.message) || error));
        });
        return;
      }
      var t = index / fps;
      prepareSourceFrame(contract, t, fps).then(function () {
        if (cancelled) return;
        if (!renderFrame(contract, canvas, ctx, t)) return;
        // Legacy scenes may call play() inside render(). Export is clocked by
        // frame index instead, so do not let playback advance between frames.
        pauseSourceVideos();
        var dataUrl = null;
        try {
          dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        } catch (error) {
          fail('Frame capture failed: ' + String((error && error.message) || error));
          return;
        }
        var comma = dataUrl.indexOf(',');
        var base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        postAndWait({ type: 'mobileAgentVideoFrame', index: emitted, frameCount: frameCount, base64: base64 }).then(function () {
          emitted += 1;
          index += 1;
          // Yield between frames. Timeline position depends only on the index,
          // not rendering speed, and only one JPEG crosses the bridge at a time.
          timers.push(setTimeout(tick, 0));
        }).catch(function (error) {
          fail('Frame export failed: ' + String((error && error.message) || error));
        });
      }).catch(function (error) {
        fail('Source video preparation failed: ' + String((error && error.message) || error));
      });
    }

    tick();
  }

  function bytesToBase64(bytes) {
    var parts = [];
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
    }
    return btoa(parts.join(''));
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
