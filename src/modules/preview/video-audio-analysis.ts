/**
 * Deterministic audio analysis for audio-reactive video renders.
 *
 * A page can react to its soundtrack by reading the fourth argument the
 * recorder passes to `render(t, canvas, ctx, audio)`:
 *
 *   audio.ready          // false when there was no file audio to analyze
 *   audio.bpm            // estimated tempo, or null
 *   audio.beats          // onset times in seconds (ascending)
 *   audio.energy/low/mid/high/onset   // normalized 0..1 envelopes
 *   audio.level(t)       // energy at time t (linear interpolation, clamped)
 *   audio.lowAt(t) audio.midAt(t) audio.highAt(t) audio.onsetAt(t)
 *   audio.beatPulse(t)   // exponential pulse since the last beat (0..1)
 *
 * Every value is a pure function of the precomputed feature track, so the
 * render stays deterministic: no live AnalyserNode sampling is involved.
 *
 * The same injected engine also normalizes the optional **speech** track the
 * page supplies on the contract (`speech.segments`, typically the `segments`
 * returned by the `transcribeAudio` tool). The recorder passes it to `render` as
 * the fifth argument, so word/phrase captions follow the transcript
 * deterministically without reading audio at render time:
 *
 *   speech.ready         // false when there is no usable transcript
 *   speech.segments      // normalized spans { start, end, text } in seconds
 *   speech.activeText(t) // text of the span containing t, or ""
 *   speech.activeIndex(t) speech.activeSegment(t) speech.progress(t)
 *
 * Like `audio`, `speech` is always an object so a page can call it
 * unconditionally. Segment times are video time; an optional `speech.offset`
 * shifts them all (e.g. when the audio track is scheduled with a `start`).
 *
 * The implementation lives here as a plain-JS string
 * ({@link VIDEO_AUDIO_ANALYSIS_SCRIPT}) that is injected into the render
 * WebView, and the unit tests evaluate that exact string — there is no second
 * TypeScript mirror that could drift out of sync. Keep the string free of
 * backticks and `${` (it is embedded in an HTML `<script>`).
 *
 * Analysis covers the *file* tracks (the imported audio the user attached),
 * mixed with their start/offset/duration/loop/volume/fades and the schedule's
 * master gain. Synthesized cues are intentionally excluded: they are pure
 * tone/noise generators the author already controls, and reproducing the Web
 * Audio synth graph byte-for-byte would be a second, drifting engine.
 */

export type AudioFeatures = {
  /** True when at least one sample was analyzed. */
  ready: boolean;
  /** Seconds of audio analyzed (capped at the video duration). */
  duration: number;
  /** Feature frames per second (sampleRate / hop). */
  frameRate: number;
  /** Estimated tempo in BPM in the 50–220 range, or null when unknown. */
  bpm: number | null;
  /** Onset times in seconds, ascending. */
  beats: number[];
  energy: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  onset: Float32Array;
};

/** One decoded audio file placed on the timeline for analysis. */
export type AnalysisMixClip = {
  /** Per-channel sample data (1–2 channels, mono is fine). */
  channels: ArrayLike<number>[];
  sampleRate: number;
  start: number;
  offset: number;
  duration: number;
  loop: boolean;
  volume: number;
  fadeIn: number;
  fadeOut: number;
};

/** The reactive object handed to `render` as its fourth argument. */
export type AudioReactiveApi = {
  ready: boolean;
  duration: number;
  frameRate: number;
  bpm: number | null;
  beats: number[];
  energy: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  onset: Float32Array;
  level(t: number): number;
  lowAt(t: number): number;
  midAt(t: number): number;
  highAt(t: number): number;
  onsetAt(t: number): number;
  beatPulse(t: number, decay?: number): number;
};

/** One timed span of spoken text. Times are seconds on the video timeline. */
export type SpeechSegment = {
  start: number;
  end: number;
  text: string;
};

/** The transcript the page supplies on the contract to enable the speech track. */
export type SpeechContractInput = {
  /**
   * Timed spans, usually the `segments` returned by the `transcribeAudio` tool.
   * Interpreted as video time, shifted uniformly by `offset`.
   */
  segments?: { start?: number; end?: number; text?: string }[];
  /** Full transcript text (optional; `activeText` works without it). */
  text?: string;
  /** Detected language code (optional). */
  language?: string;
  /** Seconds added to every segment time (default 0). */
  offset?: number;
};

/**
 * The deterministic speech track handed to `render` as its fifth argument (and
 * mirrored on `window.MOBILE_AGENT_VIDEO_SPEECH`). Like the audio object it is
 * always present: when there is no usable transcript `ready` is false and every
 * lookup is empty, so a page can call it unconditionally.
 */
export type SpeechApi = {
  ready: boolean;
  /** End of the last segment (seconds), or 0 when not ready. */
  duration: number;
  language: string | null;
  /** Full transcript text, or "" when not ready. */
  text: string;
  /** Number of normalized segments (capped at 2000). */
  count: number;
  /**
   * Normalized segments, ascending by start time (empty when not ready). Text
   * is whitespace-collapsed and capped at 400 characters; times are clamped to
   * the video duration.
   */
  segments: SpeechSegment[];
  /** Index of the segment containing `t`, or -1 in a gap / when not ready. */
  activeIndex(t: number): number;
  /** Segment at `index`, or null when out of range. */
  segmentAt(index: number): SpeechSegment | null;
  /** Segment containing `t`, or null. */
  activeSegment(t: number): SpeechSegment | null;
  /** Text of the segment containing `t`, or "" in a gap / when not ready. */
  activeText(t: number): string;
  /** 0..1 position within the active segment, or 0 when none. */
  progress(t: number): number;
  /** Start of the next segment strictly after `t`, or null. */
  nextStart(t: number): number | null;
};

/** Compact, JSON-safe audio summary returned to the agent by the analyze tool. */
export type AudioAnalysisSummary = {
  ready: boolean;
  duration: number;
  frameRate: number;
  bpm: number | null;
  /** Total number of detected onsets (may exceed `beats.length`). */
  beatCount: number;
  /** Onset times in seconds (uniformly sampled down when very dense). */
  beats: number[];
  /** Number of samples in each of the curves below. */
  curvePoints: number;
  /** Seconds between successive curve samples. */
  curveStepSeconds: number;
  energy: number[];
  low: number[];
  mid: number[];
  high: number[];
  onset: number[];
};

export type AudioAnalysisApi = {
  analyzeAudio(
    samples: Float32Array,
    sampleRate: number,
    maxSeconds?: number,
  ): AudioFeatures;
  mixClipsToMono(
    clips: AnalysisMixClip[],
    duration: number,
    sampleRate: number,
    master?: number,
  ): Float32Array;
  createAudioApi(features: AudioFeatures | null | undefined): AudioReactiveApi;
  createSpeechApi(
    speech: SpeechContractInput | null | undefined,
    duration?: number,
  ): SpeechApi;
  summarizeFeatures(
    features: AudioFeatures | null | undefined,
    options?: { maxBeats?: number; curvePoints?: number },
  ): AudioAnalysisSummary;
  emptyFeatures(): AudioFeatures;
  FFT_SIZE: number;
  HOP: number;
  MAX_SECONDS: number;
};

export const AUDIO_ANALYSIS_FFT_SIZE = 2048;
export const AUDIO_ANALYSIS_HOP = 1024;
export const AUDIO_ANALYSIS_MAX_SECONDS = 45;

/**
 * Plain-JS implementation injected into the render WebView. Assigns the API to
 * `window.__mobileAgentAudioAnalysis` (or `globalThis` under Node/tests).
 */
export const VIDEO_AUDIO_ANALYSIS_SCRIPT = `(function () {
  var root = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root || root.__mobileAgentAudioAnalysis) return;

  var FFT_SIZE = 2048;
  var HOP = 1024;
  var MAX_SECONDS = 45;
  var HALF = FFT_SIZE / 2;

  function emptyFeatures() {
    return {
      ready: false, duration: 0, frameRate: 0, bpm: null, beats: [],
      energy: new Float32Array(0), low: new Float32Array(0), mid: new Float32Array(0),
      high: new Float32Array(0), onset: new Float32Array(0)
    };
  }

  function hann(size) {
    var w = new Float64Array(size);
    for (var i = 0; i < size; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    return w;
  }

  // Iterative radix-2 Cooley-Tukey FFT (in place). Deterministic.
  function fft(re, im) {
    var n = re.length;
    var i, j, k, m, len, bit, tr, ti, ur, ui, vr, vi, cwr, cwi, nwr;
    for (i = 1, j = 0; i < n; i += 1) {
      bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { tr = re[i]; re[i] = re[j]; re[j] = tr; ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (len = 2; len <= n; len <<= 1) {
      var ang = (-2 * Math.PI) / len;
      var wr = Math.cos(ang);
      var wi = Math.sin(ang);
      for (k = 0; k < n; k += len) {
        cwr = 1;
        cwi = 0;
        var half = len / 2;
        for (m = 0; m < half; m += 1) {
          var a = k + m;
          var b = k + m + half;
          vr = re[b] * cwr - im[b] * cwi;
          vi = re[b] * cwi + im[b] * cwr;
          ur = re[a];
          ui = im[a];
          re[a] = ur + vr; im[a] = ui + vi;
          re[b] = ur - vr; im[b] = ui - vi;
          nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nwr;
        }
      }
    }
  }

  function percentile(values, p) {
    var n = values.length;
    if (n === 0) return 0;
    var copy = Array.prototype.slice.call(values);
    copy.sort(function (a, b) { return a - b; });
    var idx = Math.round((n - 1) * p);
    if (idx < 0) idx = 0;
    else if (idx > n - 1) idx = n - 1;
    return copy[idx];
  }

  // Scales an envelope into 0..1 by a high percentile so a single click does not
  // flatten everything else. Silence collapses to all zeros (no NaN/Infinity).
  function normalizeEnvelope(values) {
    var n = values.length;
    if (n === 0) return values;
    var peak = percentile(values, 0.995);
    if (!(peak > 1e-8) || !isFinite(peak)) {
      for (var i = 0; i < n; i += 1) values[i] = 0;
      return values;
    }
    for (var j = 0; j < n; j += 1) {
      var v = values[j] / peak;
      if (!isFinite(v) || isNaN(v)) v = 0;
      values[j] = v > 1 ? 1 : (v < 0 ? 0 : v);
    }
    return values;
  }

  function binFor(freq, sampleRate) {
    var bin = Math.round((freq * FFT_SIZE) / sampleRate);
    if (bin < 1) bin = 1;
    if (bin > HALF - 1) bin = HALF - 1;
    return bin;
  }

  function analyzeAudio(samples, sampleRate, maxSeconds) {
    var features = emptyFeatures();
    if (!samples || samples.length === 0 || !(sampleRate > 0)) return features;

    var limit = (maxSeconds == null) ? MAX_SECONDS : maxSeconds;
    if (!(limit > 0)) limit = MAX_SECONDS;
    var maxSamples = Math.min(samples.length, Math.round(limit * sampleRate));
    if (maxSamples <= 0) return features;

    var frameCount = Math.max(1, Math.ceil(maxSamples / HOP));
    var frameRate = sampleRate / HOP;
    var energy = new Float32Array(frameCount);
    var low = new Float32Array(frameCount);
    var mid = new Float32Array(frameCount);
    var high = new Float32Array(frameCount);
    var onset = new Float32Array(frameCount);

    var window = hann(FFT_SIZE);
    var re = new Float64Array(FFT_SIZE);
    var im = new Float64Array(FFT_SIZE);
    var prevMag = new Float64Array(HALF);

    var lowLo = binFor(20, sampleRate);
    var lowHi = binFor(250, sampleRate);
    var midLo = lowHi + 1;
    var midHi = binFor(2000, sampleRate);
    var highLo = midHi + 1;
    var highHi = binFor(8000, sampleRate);
    if (midLo > midHi) midLo = midHi = lowHi;
    if (highLo > highHi) highLo = highHi = midHi;

    for (var f = 0; f < frameCount; f += 1) {
      var start = f * HOP;
      var rms = 0;
      for (var n = 0; n < FFT_SIZE; n += 1) {
        var s = (start + n) < maxSamples ? samples[start + n] : 0;
        if (isNaN(s)) s = 0;
        rms += s * s;
        re[n] = s * window[n];
        im[n] = 0;
      }
      energy[f] = Math.sqrt(rms / FFT_SIZE);
      fft(re, im);
      var lb = 0, mb = 0, hb = 0, flux = 0;
      for (var k = 1; k < HALF; k += 1) {
        var mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (k >= lowLo && k <= lowHi) lb += mag * mag;
        if (k >= midLo && k <= midHi) mb += mag * mag;
        if (k >= highLo && k <= highHi) hb += mag * mag;
        var d = mag - prevMag[k];
        if (d > 0) flux += d;
        prevMag[k] = mag;
      }
      low[f] = Math.sqrt(lb);
      mid[f] = Math.sqrt(mb);
      high[f] = Math.sqrt(hb);
      onset[f] = flux;
    }
    onset[0] = 0;

    normalizeEnvelope(energy);
    normalizeEnvelope(low);
    normalizeEnvelope(mid);
    normalizeEnvelope(high);
    normalizeEnvelope(onset);

    features.ready = true;
    features.duration = maxSamples / sampleRate;
    features.frameRate = frameRate;
    features.energy = energy;
    features.low = low;
    features.mid = mid;
    features.high = high;
    features.onset = onset;
    features.beats = pickPeaks(onset, frameRate);
    features.bpm = estimateTempo(onset, frameRate);
    return features;
  }

  function pickPeaks(onset, frameRate) {
    var frames = onset.length;
    var out = [];
    if (frames === 0 || !(frameRate > 0)) return out;
    var win = Math.max(1, Math.round(frameRate * 0.12));
    var minSep = Math.max(1, Math.round(frameRate * 0.06));
    var last = -minSep;
    for (var i = 0; i < frames; i += 1) {
      var v = onset[i];
      if (v <= 0) continue;
      var lo = Math.max(0, i - win);
      var hi = Math.min(frames - 1, i + win);
      var sum = 0;
      var count = 0;
      for (var k = lo; k <= hi; k += 1) { sum += onset[k]; count += 1; }
      var mean = count > 0 ? sum / count : 0;
      if (v <= mean + 0.05) continue;
      var isMax = true;
      var mlo = Math.max(0, i - minSep);
      var mhi = Math.min(frames - 1, i + minSep);
      for (var m = mlo; m <= mhi; m += 1) {
        if (m !== i && onset[m] > v) { isMax = false; break; }
      }
      if (!isMax) continue;
      if (i - last < minSep) continue;
      out.push(i / frameRate);
      last = i;
    }
    return out;
  }

  // Estimates tempo (BPM) from the onset envelope. It scans candidate tempos on
  // a fine grid and, for each, sums the *interpolated* autocorrelation of the
  // onset envelope at the candidate period and its integer multiples. Scoring
  // fractional periods matters: a true period that sits near a half-integer
  // frame (for example 120 BPM at 48 kHz, ~23.44 frames) would otherwise lose
  // to its near-integer double and be reported as half tempo. A soft ~120 BPM
  // prior then breaks the remaining octave ambiguity on real material.
  function estimateTempo(onset, frameRate) {
    var frames = onset.length;
    if (frames < 8 || !(frameRate > 0)) return null;
    var minBpm = 50;
    var maxBpm = 220;
    var maxLag = Math.min(frames - 2, Math.ceil((frameRate * 60) / minBpm) + 1);
    if (maxLag < 4) return null;

    var mean = 0;
    for (var i = 0; i < frames; i += 1) mean += onset[i];
    mean /= frames;

    // Mean-subtracted autocorrelation, kept from lag 1 so we can interpolate
    // between integer lags below.
    var acf = new Float64Array(maxLag + 2);
    var peak = 0;
    for (var lag = 1; lag <= maxLag; lag += 1) {
      var s = 0;
      for (var t = 0; t + lag < frames; t += 1) {
        s += (onset[t] - mean) * (onset[t + lag] - mean);
      }
      acf[lag] = s;
      if (s > peak) peak = s;
    }
    if (!(peak > 0)) return null;

    function acfAt(x) {
      if (!(x > 0)) return 0;
      if (x >= maxLag) return acf[maxLag];
      var i0 = Math.floor(x);
      var frac = x - i0;
      return acf[i0] + (acf[i0 + 1] - acf[i0]) * frac;
    }

    var bestScore = -Infinity;
    var bestBpm = 0;
    for (var bpm = minBpm; bpm <= maxBpm + 0.001; bpm += 0.25) {
      var period = (60 * frameRate) / bpm;
      if (period <= 0 || period > maxLag) continue;
      var score = 0;
      var h = 1;
      while (h * period <= maxLag) {
        score += acfAt(h * period);
        h += 1;
      }
      var weight = Math.exp(-0.5 * Math.pow(Math.log(bpm / 120) / 0.9, 2));
      var weighted = (score / peak) * (0.55 + 0.45 * weight);
      if (weighted > bestScore) { bestScore = weighted; bestBpm = bpm; }
    }
    if (!(bestBpm > 0)) return null;
    return Math.round(bestBpm * 10) / 10;
  }

  function mixClipsToMono(clips, duration, sampleRate, master) {
    var total = Math.max(1, Math.round(duration * sampleRate));
    var out = new Float32Array(total);
    if (clips && clips.length > 0 && sampleRate > 0) {
      for (var c = 0; c < clips.length; c += 1) {
        var clip = clips[c];
        if (!clip || !clip.channels || clip.channels.length === 0) continue;
        var channels = clip.channels;
        var chCount = channels.length;
        var srcRate = clip.sampleRate > 0 ? clip.sampleRate : sampleRate;
        var srcLen = channels[0] ? channels[0].length : 0;
        if (!(srcLen > 0)) continue;
        var srcDur = srcLen / srcRate;
        var start = clip.start || 0;
        var dur = clip.duration == null ? (duration - start) : clip.duration;
        if (!(dur > 0)) continue;
        var volume = clip.volume == null ? 0.8 : clip.volume;
        var fadeIn = clip.fadeIn || 0;
        var fadeOut = clip.fadeOut || 0;
        var offset = clip.offset || 0;
        var loop = clip.loop === true;
        var firstOut = Math.max(0, Math.round(start * sampleRate));
        var lastOut = Math.min(total, Math.round((start + dur) * sampleRate));
        for (var f = firstOut; f < lastOut; f += 1) {
          var localT = f / sampleRate - start;
          if (localT < 0) continue;
          var srcT = offset + localT;
          if (loop) {
            if (srcDur > 0) srcT = srcT % srcDur;
          } else if (srcT >= srcDur) {
            continue;
          }
          var srcPos = srcT * srcRate;
          var i0 = Math.floor(srcPos);
          if (i0 < 0) i0 = 0;
          if (i0 > srcLen - 1) i0 = srcLen - 1;
          var i1 = (i0 + 1) < srcLen ? (i0 + 1) : i0;
          var frac = srcPos - i0;
          if (frac < 0) frac = 0;
          else if (frac > 1) frac = 1;
          var sample = 0;
          for (var ch = 0; ch < chCount; ch += 1) {
            var data = channels[ch];
            var a = data[i0] || 0;
            var b = data[i1] || 0;
            sample += a + (b - a) * frac;
          }
          sample /= chCount;
          var gain = volume;
          if (fadeIn > 0 && localT < fadeIn) gain *= localT / fadeIn;
          if (fadeOut > 0 && localT > dur - fadeOut) {
            var k = (dur - localT) / fadeOut;
            gain *= k < 0 ? 0 : k;
          }
          out[f] += sample * gain;
        }
      }
    }
    if (master != null && master !== 1) {
      for (var o = 0; o < total; o += 1) out[o] *= master;
    }
    for (var q = 0; q < total; q += 1) {
      var value = out[q];
      if (isNaN(value)) value = 0;
      else if (value > 1) value = 1;
      else if (value < -1) value = -1;
      out[q] = value;
    }
    return out;
  }

  function sampleEnvelope(env, frameRate, t) {
    var n = env ? env.length : 0;
    if (n === 0 || !(frameRate > 0)) return 0;
    var pos = t * frameRate;
    if (!isFinite(pos)) return 0;
    if (pos <= 0) return env[0];
    if (pos >= n - 1) return env[n - 1];
    var i = Math.floor(pos);
    var frac = pos - i;
    return env[i] * (1 - frac) + env[i + 1] * frac;
  }

  function createAudioApi(features) {
    var f = features || emptyFeatures();
    var beats = (f.beats || []).slice();
    return {
      ready: !!f.ready,
      duration: f.duration || 0,
      frameRate: f.frameRate || 0,
      bpm: f.bpm == null ? null : f.bpm,
      beats: beats,
      energy: f.energy || new Float32Array(0),
      low: f.low || new Float32Array(0),
      mid: f.mid || new Float32Array(0),
      high: f.high || new Float32Array(0),
      onset: f.onset || new Float32Array(0),
      level: function (t) { return sampleEnvelope(f.energy, f.frameRate, t); },
      lowAt: function (t) { return sampleEnvelope(f.low, f.frameRate, t); },
      midAt: function (t) { return sampleEnvelope(f.mid, f.frameRate, t); },
      highAt: function (t) { return sampleEnvelope(f.high, f.frameRate, t); },
      onsetAt: function (t) { return sampleEnvelope(f.onset, f.frameRate, t); },
      beatPulse: function (t, decay) {
        var d = decay == null ? 0.18 : decay;
        if (!(d > 0)) d = 0.18;
        if (beats.length > 0) {
          var best = -Infinity;
          for (var i = 0; i < beats.length; i += 1) {
            if (beats[i] <= t && beats[i] > best) best = beats[i];
          }
          if (best === -Infinity) return 0;
          return Math.exp(-(t - best) / d);
        }
        if (f.bpm > 0) {
          var period = 60 / f.bpm;
          var phase = t % period;
          if (phase < 0) phase += period;
          return Math.exp(-phase / d);
        }
        return 0;
      }
    };
  }

  function round3(value) {
    if (!isFinite(value)) return 0;
    return Math.round(value * 1000) / 1000;
  }

  // Averages an envelope down to 'count' buckets so the whole track fits in a
  // small JSON payload for the agent (the raw per-frame arrays can be thousands
  // of floats long).
  function downsample(values, count) {
    var out = [];
    var n = values ? values.length : 0;
    if (!(count > 0)) return out;
    if (n === 0) {
      for (var z = 0; z < count; z += 1) out.push(0);
      return out;
    }
    for (var i = 0; i < count; i += 1) {
      var lo = Math.floor((i * n) / count);
      var hi = Math.max(lo + 1, Math.floor(((i + 1) * n) / count));
      var sum = 0;
      var c = 0;
      for (var j = lo; j < hi && j < n; j += 1) { sum += values[j]; c += 1; }
      out.push(round3(c > 0 ? sum / c : 0));
    }
    return out;
  }

  function summarizeFeatures(features, options) {
    var f = features || emptyFeatures();
    var maxBeats = (options && options.maxBeats) || 300;
    var points = (options && options.curvePoints) || 24;
    if (!f.ready) {
      return {
        ready: false, duration: 0, frameRate: 0, bpm: null, beatCount: 0,
        beats: [], curvePoints: 0, curveStepSeconds: 0,
        energy: [], low: [], mid: [], high: [], onset: []
      };
    }
    var beats = f.beats || [];
    var outBeats = [];
    if (beats.length <= maxBeats) {
      for (var i = 0; i < beats.length; i += 1) outBeats.push(round3(beats[i]));
    } else {
      var step = beats.length / maxBeats;
      for (var b = 0; b < maxBeats; b += 1) {
        outBeats.push(round3(beats[Math.floor(b * step)]));
      }
    }
    return {
      ready: true,
      duration: round3(f.duration),
      frameRate: round3(f.frameRate),
      bpm: f.bpm == null ? null : f.bpm,
      beatCount: beats.length,
      beats: outBeats,
      curvePoints: points,
      curveStepSeconds: f.duration > 0 ? round3(f.duration / points) : 0,
      energy: downsample(f.energy, points),
      low: downsample(f.low, points),
      mid: downsample(f.mid, points),
      high: downsample(f.high, points),
      onset: downsample(f.onset, points)
    };
  }

  var MAX_SPEECH_SEGMENTS = 2000;
  var MAX_SPEECH_TEXT = 400;

  function normalizeSpeechSegments(segments, offset, duration) {
    var out = [];
    if (!segments || typeof segments.length !== 'number') return out;
    var limit = segments.length < MAX_SPEECH_SEGMENTS ? segments.length : MAX_SPEECH_SEGMENTS;
    for (var i = 0; i < limit; i += 1) {
      var raw = segments[i];
      if (!raw || typeof raw !== 'object') continue;
      var start = Number(raw.start);
      var end = Number(raw.end);
      if (!isFinite(start) || !isFinite(end)) continue;
      var text = typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim() : '';
      if (!text) continue;
      if (text.length > MAX_SPEECH_TEXT) text = text.slice(0, MAX_SPEECH_TEXT);
      start = start + offset;
      end = end + offset;
      if (!isFinite(start) || !isFinite(end)) continue;
      if (start < 0) start = 0;
      if (end <= start) continue;
      if (duration > 0) {
        if (start >= duration) continue;
        if (end > duration) end = duration;
      }
      out.push({ start: start, end: end, text: text });
    }
    out.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return out;
  }

  function findSpeechIndex(segments, t) {
    var lo = 0;
    var hi = segments.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var segment = segments[mid];
      if (t < segment.start) hi = mid - 1;
      else if (t >= segment.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function createSpeechApi(speech, duration) {
    var input = (speech && typeof speech === 'object') ? speech : null;
    var offset = input ? Number(input.offset) : 0;
    if (!isFinite(offset)) offset = 0;
    var total = (typeof duration === 'number' && isFinite(duration) && duration > 0) ? duration : 0;
    var segments = input ? normalizeSpeechSegments(input.segments, offset, total) : [];
    var ready = segments.length > 0;
    var language = input && typeof input.language === 'string' && input.language ? input.language : null;
    var text = ready && typeof input.text === 'string' ? input.text.trim() : '';

    function activeIndex(t) {
      if (!ready || typeof t !== 'number' || !isFinite(t)) return -1;
      return findSpeechIndex(segments, t);
    }
    function segmentAt(index) {
      if (!ready || typeof index !== 'number' || !isFinite(index)) return null;
      if (index < 0 || index >= segments.length) return null;
      return segments[index];
    }
    function activeSegment(t) {
      return segmentAt(activeIndex(t));
    }
    function activeText(t) {
      var segment = activeSegment(t);
      return segment ? segment.text : '';
    }
    function progress(t) {
      var segment = activeSegment(t);
      if (!segment) return 0;
      var span = segment.end - segment.start;
      if (!(span > 0)) return 0;
      var value = (t - segment.start) / span;
      if (value < 0) return 0;
      if (value > 1) return 1;
      return value;
    }
    function nextStart(t) {
      if (!ready) return null;
      if (typeof t !== 'number' || !isFinite(t)) t = -Infinity;
      for (var i = 0; i < segments.length; i += 1) {
        if (segments[i].start > t) return segments[i].start;
      }
      return null;
    }

    return {
      ready: ready,
      duration: ready ? segments[segments.length - 1].end : 0,
      language: language,
      text: text,
      count: segments.length,
      segments: segments,
      activeIndex: activeIndex,
      segmentAt: segmentAt,
      activeSegment: activeSegment,
      activeText: activeText,
      progress: progress,
      nextStart: nextStart
    };
  }

  root.__mobileAgentAudioAnalysis = {
    analyzeAudio: analyzeAudio,
    mixClipsToMono: mixClipsToMono,
    createAudioApi: createAudioApi,
    createSpeechApi: createSpeechApi,
    summarizeFeatures: summarizeFeatures,
    emptyFeatures: emptyFeatures,
    sampleEnvelope: sampleEnvelope,
    FFT_SIZE: FFT_SIZE,
    HOP: HOP,
    MAX_SECONDS: MAX_SECONDS,
    _internals: { fft: fft, pickPeaks: pickPeaks, estimateTempo: estimateTempo, percentile: percentile, downsample: downsample, normalizeSpeechSegments: normalizeSpeechSegments }
  };
})();
`;

/**
 * Evaluates {@link VIDEO_AUDIO_ANALYSIS_SCRIPT} and returns the resulting API.
 * Intended for tests (and any Node-side tooling); the WebView gets the API via
 * the injected script instead. Safe to call repeatedly.
 */
export function loadAudioAnalysisApi(): AudioAnalysisApi {
  new Function(VIDEO_AUDIO_ANALYSIS_SCRIPT)();
  return (globalThis as unknown as {
    __mobileAgentAudioAnalysis: AudioAnalysisApi;
  }).__mobileAgentAudioAnalysis;
}

export type AudioAnalysisDocumentOptions = {
  /** Data URI of the audio file to analyze. */
  src: string;
  /** Analyze at most this many seconds (default 90). */
  maxSeconds?: number;
  /** Target analysis sample rate (default 22050, to bound memory on long clips). */
  sampleRate?: number;
  maxBeats?: number;
  curvePoints?: number;
  /**
   * When set, also post the decoded audio as mono 16-bit PCM resampled to this
   * rate (used to feed on-device speech recognition). 0 (default) omits it.
   */
  pcmSampleRate?: number;
};

/**
 * Builds the throwaway HTML document the analysis WebView loads. It embeds the
 * shared analysis engine, then decodes the audio and posts a JSON summary back
 * over `ReactNativeWebView.postMessage`:
 *
 *   { type: "mobileAgentAudioAnalysis", summary }        // success
 *   { type: "mobileAgentAudioAnalysisError", message }   // failure
 *
 * When `pcmSampleRate` is set (> 0), the success message also carries the
 * decoded audio as mono 16-bit PCM (`pcmBase64`, base64 of little-endian
 * Int16) plus `pcmSampleRate`, which feeds on-device speech recognition.
 *
 * Call `window.__startMobileAgentAudioAnalysis()` (after load) to begin.
 */
export function buildAudioAnalysisDocument(
  options: AudioAnalysisDocumentOptions,
): string {
  const config = JSON.stringify({
    src: options.src,
    maxSeconds: options.maxSeconds ?? 90,
    sampleRate: options.sampleRate ?? 22050,
    maxBeats: options.maxBeats ?? 300,
    curvePoints: options.curvePoints ?? 24,
    pcmSampleRate: options.pcmSampleRate ?? 0,
  })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const bootstrap = [
    "(function () {",
    "  function post(payload) {",
    "    try {",
    "      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {",
    "        window.ReactNativeWebView.postMessage(JSON.stringify(payload));",
    "      }",
    "    } catch (_) {}",
    "  }",
    "  function fail(message) {",
    "    post({ type: 'mobileAgentAudioAnalysisError', message: String(message || 'Audio analysis failed.') });",
    "  }",
    "  function encodePcm16Base64(samples) {",
    "    var n = samples.length;",
    "    var bytes = new Uint8Array(n * 2);",
    "    var view = new DataView(bytes.buffer);",
    "    for (var i = 0; i < n; i += 1) {",
    "      var s = samples[i];",
    "      if (isNaN(s)) s = 0;",
    "      else if (s > 1) s = 1;",
    "      else if (s < -1) s = -1;",
    "      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);",
    "    }",
    "    var chunk = 0x4000;",
    "    var parts = [];",
    "    for (var o = 0; o < bytes.length; o += chunk) {",
    "      parts.push(String.fromCharCode.apply(null, bytes.subarray(o, o + chunk)));",
    "    }",
    "    return btoa(parts.join(''));",
    "  }",
    "  function run() {",
    "    try {",
    "      if (window.__mobileAgentAudioAnalysisStarted) return;",
    "      window.__mobileAgentAudioAnalysisStarted = true;",
    "      var cfg = window.__MOBILE_AGENT_ANALYZE__;",
    "      var aa = window.__mobileAgentAudioAnalysis;",
    "      if (!cfg || !cfg.src) return fail('No audio source was provided.');",
    "      if (!aa) return fail('The audio analysis engine is unavailable.');",
    "      var AC = window.AudioContext || window.webkitAudioContext;",
    "      if (!AC) return fail('This WebView does not support Web Audio.');",
    "      var ctx;",
    "      try { ctx = new AC({ sampleRate: cfg.sampleRate || 22050 }); }",
    "      catch (error) { try { ctx = new AC(); } catch (fallback) { return fail('Audio could not start.'); } }",
    "      var rate = ctx.sampleRate;",
    "      fetch(cfg.src)",
    "        .then(function (response) {",
    "          if (!response.ok) throw new Error('The audio file could not be read.');",
    "          return response.arrayBuffer();",
    "        })",
    "        .then(function (buffer) { return ctx.decodeAudioData(buffer); })",
    "        .then(function (audioBuffer) {",
    "          var channels = [];",
    "          var count = Math.min(audioBuffer.numberOfChannels || 1, 2);",
    "          for (var i = 0; i < count; i += 1) channels.push(audioBuffer.getChannelData(i));",
    "          var full = audioBuffer.duration || cfg.maxSeconds || 30;",
    "          var duration = cfg.maxSeconds > 0 ? Math.min(cfg.maxSeconds, full) : full;",
    "          if (!(duration > 0)) duration = 1;",
    "          var samples = aa.mixClipsToMono([",
    "            { channels: channels, sampleRate: audioBuffer.sampleRate || rate, start: 0, offset: 0, duration: duration, loop: false, volume: 1, fadeIn: 0, fadeOut: 0 }",
    "          ], duration, rate, 1);",
    "          var features = aa.analyzeAudio(samples, rate, duration);",
    "          var payload = { type: 'mobileAgentAudioAnalysis', summary: aa.summarizeFeatures(features, { maxBeats: cfg.maxBeats, curvePoints: cfg.curvePoints }) };",
    "          if (cfg.pcmSampleRate > 0) {",
    "            var pcmRate = cfg.pcmSampleRate;",
    "            var pcmSamples = pcmRate === rate ? samples : aa.mixClipsToMono([",
    "              { channels: channels, sampleRate: audioBuffer.sampleRate || rate, start: 0, offset: 0, duration: duration, loop: false, volume: 1, fadeIn: 0, fadeOut: 0 }",
    "            ], duration, pcmRate, 1);",
    "            payload.pcmBase64 = encodePcm16Base64(pcmSamples);",
    "            payload.pcmSampleRate = pcmRate;",
    "          }",
    "          post(payload);",
    "          try { ctx.close(); } catch (closeError) {}",
    "        })",
    "        .catch(function (error) { fail((error && error.message) || error); });",
    "    } catch (error) { fail((error && error.message) || error); }",
    "  }",
    "  window.__startMobileAgentAudioAnalysis = run;",
    "})();",
  ].join("\n");

  const open = "<" + "script>";
  const close = "<" + "/script>";
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "</head><body>" +
    open + "window.__MOBILE_AGENT_ANALYZE__ = " + config + ";" + close +
    open + VIDEO_AUDIO_ANALYSIS_SCRIPT + close +
    open + bootstrap + close +
    "</body></html>"
  );
}
