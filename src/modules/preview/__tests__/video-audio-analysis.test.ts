import { describe, expect, it } from "vitest";

import {
  buildAudioAnalysisDocument,
  loadAudioAnalysisApi,
  VIDEO_AUDIO_ANALYSIS_SCRIPT,
  type AudioAnalysisApi,
  type AudioFeatures,
} from "@/modules/preview/video-audio-analysis";

function api(): AudioAnalysisApi {
  return loadAudioAnalysisApi();
}

function internals(): {
  fft: (re: Float64Array, im: Float64Array) => void;
  pickPeaks: (onset: Float32Array, frameRate: number) => number[];
  estimateTempo: (onset: Float32Array, frameRate: number) => number | null;
  percentile: (values: ArrayLike<number>, p: number) => number;
} {
  return (api() as unknown as { _internals: ReturnType<typeof internals> })
    ._internals;
}

function sine(freq: number, seconds: number, sampleRate: number, amp = 0.8) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

function allFinite(values: Float32Array): boolean {
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

function mean(values: Float32Array): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

describe("audio analysis script packaging", () => {
  it("is safe to embed in a single HTML <script> tag", () => {
    expect(VIDEO_AUDIO_ANALYSIS_SCRIPT).not.toContain("</script>");
    expect(VIDEO_AUDIO_ANALYSIS_SCRIPT).not.toContain("`");
    expect(VIDEO_AUDIO_ANALYSIS_SCRIPT).not.toContain("${");
  });

  it("exposes the expected API surface", () => {
    const a = api();
    expect(typeof a.analyzeAudio).toBe("function");
    expect(typeof a.mixClipsToMono).toBe("function");
    expect(typeof a.createAudioApi).toBe("function");
    expect(typeof a.createSpeechApi).toBe("function");
    expect(a.FFT_SIZE).toBe(2048);
    expect(a.HOP).toBe(1024);
  });
});

describe("fft", () => {
  it("transforms an impulse into a flat magnitude spectrum", () => {
    const re = new Float64Array(8);
    const im = new Float64Array(8);
    re[0] = 1;
    internals().fft(re, im);
    for (let k = 0; k < 8; k += 1) {
      expect(Math.hypot(re[k], im[k])).toBeCloseTo(1, 6);
    }
  });

  it("concentrates a cosine on its frequency bin", () => {
    const n = 16;
    const bin = 3;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      re[i] = Math.cos((2 * Math.PI * bin * i) / n);
    }
    internals().fft(re, im);
    const mag = (k: number) => Math.hypot(re[k], im[k]);
    expect(mag(bin)).toBeGreaterThan(6);
    expect(mag(bin - 1)).toBeLessThan(1);
    expect(mag(bin + 1)).toBeLessThan(1);
  });
});

describe("estimateTempo", () => {
  it("recovers the tempo of a periodic onset track", () => {
    const frameRate = 48;
    const frames = frameRate * 12;
    const onset = new Float32Array(frames);
    const period = frameRate * 0.5; // 120 BPM
    for (let i = 0; i * period < frames; i += 1) {
      onset[Math.round(i * period)] = 1;
    }
    const bpm = internals().estimateTempo(onset, frameRate);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm as number) - 120)).toBeLessThan(4);
  });

  it("does not collapse a mid-tempo track to half speed", () => {
    const frameRate = 48;
    const frames = frameRate * 12;
    const onset = new Float32Array(frames);
    const period = frameRate * (60 / 90); // 90 BPM
    for (let i = 0; i * period < frames; i += 1) {
      onset[Math.round(i * period)] = 1;
    }
    const bpm = internals().estimateTempo(onset, frameRate);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm as number) - 90)).toBeLessThan(4);
  });

  it("returns null for a flat onset track", () => {
    const onset = new Float32Array(64);
    expect(internals().estimateTempo(onset, 46.875)).toBeNull();
  });

  it("keeps a near-half-integer 120 BPM from collapsing to half tempo", () => {
    // At the recorder's real frame rate (48000 / 1024 = 46.875), 120 BPM has a
    // period of ~23.44 frames. An integer-lag comb used to prefer lag 47 (the
    // near-integer double) and report ~60 BPM; the fractional scan must not.
    const frameRate = 48000 / 1024;
    const frames = Math.round(frameRate * 16);
    const onset = new Float32Array(frames);
    const period = frameRate * 0.5;
    for (let i = 0; i * period < frames; i += 1) {
      onset[Math.round(i * period)] = 1;
    }
    const bpm = internals().estimateTempo(onset, frameRate);
    expect(bpm).not.toBeNull();
    expect(Math.abs((bpm as number) - 120)).toBeLessThan(4);
  });

  it("recovers common tempos at the recorder frame rate", () => {
    const frameRate = 48000 / 1024;
    for (const target of [90, 100, 128]) {
      const frames = Math.round(frameRate * 16);
      const onset = new Float32Array(frames);
      const period = frameRate * (60 / target);
      for (let i = 0; i * period < frames; i += 1) {
        const idx = Math.round(i * period);
        if (idx < frames) onset[idx] = 1;
      }
      const bpm = internals().estimateTempo(onset, frameRate);
      expect(bpm, `tempo ${target}`).not.toBeNull();
      expect(
        Math.abs((bpm as number) - target),
        `tempo ${target} -> ${bpm}`,
      ).toBeLessThan(4);
    }
  });

  it("lands on the right octave across a range of tempos", () => {
    for (const target of [70, 100, 128, 140, 175]) {
      const frameRate = 48;
      const frames = frameRate * 16;
      const onset = new Float32Array(frames);
      const period = frameRate * (60 / target);
      for (let i = 0; i * period < frames; i += 1) {
        const idx = Math.round(i * period);
        if (idx < frames) onset[idx] = 1;
      }
      const bpm = internals().estimateTempo(onset, frameRate);
      expect(bpm, `tempo ${target}`).not.toBeNull();
      // A pure impulse train is octave-ambiguous (70 and 140 sound identical),
      // so accept the target or its double/half, but reject unrelated values.
      const ratio = (bpm as number) / target;
      const onOctave = [0.5, 1, 2].some((k) => Math.abs(ratio - k) < 0.05);
      expect(onOctave, `tempo ${target} -> ${bpm}`).toBe(true);
    }
  });
});

describe("pickPeaks", () => {
  it("finds spaced peaks and ignores their shoulders", () => {
    const frameRate = 46.875;
    const onset = new Float32Array(200);
    onset[20] = 1;
    onset[21] = 0.6;
    onset[90] = 1;
    onset[160] = 1;
    const beats = internals().pickPeaks(onset, frameRate);
    expect(beats).toHaveLength(3);
    expect(beats[0]).toBeCloseTo(20 / frameRate, 5);
    expect(beats[1]).toBeCloseTo(90 / frameRate, 5);
    expect(beats[2]).toBeCloseTo(160 / frameRate, 5);
  });
});

describe("analyzeAudio", () => {
  it("returns empty (not ready) features for no samples", () => {
    const features = api().analyzeAudio(new Float32Array(0), 48000, 10);
    expect(features.ready).toBe(false);
    expect(features.duration).toBe(0);
    expect(features.beats).toEqual([]);
    expect(features.bpm).toBeNull();
  });

  it("reports a 440 Hz tone as mid-band dominant with finite values", () => {
    const features = api().analyzeAudio(sine(440, 2, 48000), 48000, 2);
    expect(features.ready).toBe(true);
    expect(features.duration).toBeCloseTo(2, 1);
    expect(features.frameRate).toBeCloseTo(48000 / 1024, 6);
    expect(mean(features.mid)).toBeGreaterThan(mean(features.low));
    expect(mean(features.mid)).toBeGreaterThan(mean(features.high));
    for (const env of [
      features.energy,
      features.low,
      features.mid,
      features.high,
      features.onset,
    ]) {
      expect(allFinite(env)).toBe(true);
    }
  });

  it("collapses silence to all zeros without producing NaN", () => {
    const features = api().analyzeAudio(new Float32Array(48000), 48000, 1);
    expect(features.ready).toBe(true);
    expect(features.beats).toEqual([]);
    expect(features.bpm).toBeNull();
    expect(allFinite(features.energy)).toBe(true);
    expect(mean(features.energy)).toBe(0);
    expect(mean(features.mid)).toBe(0);
  });

  it("is deterministic across runs", () => {
    const samples = sine(220, 1, 48000);
    const first = api().analyzeAudio(samples, 48000, 1);
    const second = api().analyzeAudio(samples, 48000, 1);
    expect(Array.from(first.energy)).toEqual(Array.from(second.energy));
    expect(Array.from(first.onset)).toEqual(Array.from(second.onset));
    expect(first.beats).toEqual(second.beats);
    expect(first.bpm).toBe(second.bpm);
  });

  it("caps analysis at the requested duration", () => {
    const features = api().analyzeAudio(sine(440, 5, 48000), 48000, 1);
    expect(features.duration).toBeCloseTo(1, 1);
  });
});

describe("mixClipsToMono", () => {
  const oneChannel = (value: number, length: number, sampleRate: number) => ({
    channels: [new Float32Array(length).fill(value)],
    sampleRate,
  });

  it("places a clip at its start time", () => {
    const clip = {
      ...oneChannel(0.5, 1000, 1000),
      start: 0.5,
      offset: 0,
      duration: 0.5,
      loop: false,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    };
    const out = api().mixClipsToMono([clip], 1, 1000, 1);
    expect(out).toHaveLength(1000);
    expect(out[100]).toBe(0);
    expect(out[700]).toBeCloseTo(0.5, 5);
  });

  it("loops short sources across the clip duration", () => {
    const clip = {
      ...oneChannel(1, 100, 1000),
      start: 0,
      offset: 0,
      duration: 0.3,
      loop: true,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    };
    const out = api().mixClipsToMono([clip], 0.3, 1000, 1);
    expect(out[50]).toBeCloseTo(1, 5);
    expect(out[150]).toBeCloseTo(1, 5);
    expect(out[250]).toBeCloseTo(1, 5);
  });

  it("stops a non-looping source when it runs out", () => {
    const clip = {
      ...oneChannel(1, 100, 1000),
      start: 0,
      offset: 0,
      duration: 0.3,
      loop: false,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    };
    const out = api().mixClipsToMono([clip], 0.3, 1000, 1);
    expect(out[50]).toBeCloseTo(1, 5);
    expect(out[150]).toBe(0);
  });

  it("applies volume, master gain and fades", () => {
    const clip = {
      ...oneChannel(1, 1000, 1000),
      start: 0,
      offset: 0,
      duration: 1,
      loop: false,
      volume: 0.5,
      fadeIn: 0.5,
      fadeOut: 0.5,
    };
    const out = api().mixClipsToMono([clip], 1, 1000, 0.5);
    expect(out[0]).toBeCloseTo(0, 3); // fade-in start
    expect(out[500]).toBeCloseTo(0.25, 3); // 1 * 0.5 volume * 0.5 master
    expect(out[999]).toBeLessThan(0.25); // fade-out tail
  });

  it("returns silence for no clips", () => {
    const out = api().mixClipsToMono([], 1, 1000, 1);
    expect(out).toHaveLength(1000);
    expect(mean(out)).toBe(0);
  });

  it("downmixes stereo channels to mono", () => {
    const clip = {
      channels: [new Float32Array(100).fill(1), new Float32Array(100).fill(0)],
      sampleRate: 1000,
      start: 0,
      offset: 0,
      duration: 0.1,
      loop: false,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    };
    const out = api().mixClipsToMono([clip], 0.1, 1000, 1);
    expect(out[50]).toBeCloseTo(0.5, 5);
  });

  it("honors an offset into the source", () => {
    const ramp = new Float32Array(100);
    for (let i = 0; i < ramp.length; i += 1) ramp[i] = i / 100;
    const clip = {
      channels: [ramp],
      sampleRate: 1000,
      start: 0,
      offset: 0.05,
      duration: 0.05,
      loop: false,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    };
    const out = api().mixClipsToMono([clip], 0.05, 1000, 1);
    // First output sample reads the source at 0.05 s (sample 50).
    expect(out[0]).toBeCloseTo(0.5, 2);
  });

  it("sums overlapping clips and clamps the mix to [-1, 1]", () => {
    const clipAt = (start: number) => ({
      channels: [new Float32Array(1000).fill(0.9)],
      sampleRate: 1000,
      start,
      offset: 0,
      duration: 1,
      loop: false,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
    const out = api().mixClipsToMono([clipAt(0), clipAt(0)], 1, 1000, 1);
    expect(out[500]).toBeCloseTo(1, 5); // 1.8 clamped to 1
    expect(Math.max(...Array.from(out))).toBeLessThanOrEqual(1);
    expect(Math.min(...Array.from(out))).toBeGreaterThanOrEqual(-1);
  });
});

describe("createAudioApi", () => {
  function features(partial: Partial<AudioFeatures>): AudioFeatures {
    return {
      ready: true,
      duration: 2,
      frameRate: 1,
      bpm: null,
      beats: [],
      energy: new Float32Array([0, 0.5, 1]),
      low: new Float32Array(3),
      mid: new Float32Array(3),
      high: new Float32Array(3),
      onset: new Float32Array(3),
      pitch: new Float32Array(3),
      pitchConf: new Float32Array(3),
      key: null,
      keyConfidence: null,
      tuningCents: null,
      notes: [],
      voicedRatio: 0,
      ...partial,
    };
  }

  it("interpolates and clamps envelope lookups", () => {
    const a = api().createAudioApi(features({}));
    expect(a.level(-5)).toBe(0);
    expect(a.level(0)).toBe(0);
    expect(a.level(1)).toBeCloseTo(0.5, 6);
    expect(a.level(2)).toBe(1);
    expect(a.level(99)).toBe(1);
  });

  it("returns a silent, stable object when features are missing", () => {
    const a = api().createAudioApi(null);
    expect(a.ready).toBe(false);
    expect(a.level(1)).toBe(0);
    expect(a.lowAt(1)).toBe(0);
    expect(a.beatPulse(1)).toBe(0);
    expect(a.beats).toEqual([]);
    expect(a.bpm).toBeNull();
    expect(a.pitchAt(1)).toBe(0);
    expect(a.pitchConfAt(1)).toBe(0);
    expect(a.key).toBeNull();
    expect(a.keyConfidence).toBeNull();
    expect(a.tuningCents).toBeNull();
  });

  it("decays beat pulses from the most recent beat", () => {
    const a = api().createAudioApi(features({ beats: [1] }));
    expect(a.beatPulse(1)).toBeCloseTo(1, 6);
    expect(a.beatPulse(1.18, 0.18)).toBeCloseTo(Math.exp(-1), 5);
    expect(a.beatPulse(0.5)).toBe(0);
  });

  it("falls back to a bpm grid when no onsets were found", () => {
    const a = api().createAudioApi(features({ beats: [], bpm: 120 }));
    expect(a.beatPulse(0, 0.18)).toBeCloseTo(1, 6);
    expect(a.beatPulse(0.25, 0.18)).toBeLessThan(0.5);
  });

  it("uses only the most recent beat at or before t", () => {
    const a = api().createAudioApi(features({ beats: [0, 1, 2] }));
    expect(a.beatPulse(1.5)).toBeCloseTo(Math.exp(-0.5 / 0.18), 5);
    // Beats ignore the bpm fallback once onsets exist.
    expect(a.beatPulse(2.01)).toBeCloseTo(Math.exp(-0.01 / 0.18), 5);
    expect(a.beatPulse(2.9, 0.1)).toBeCloseTo(Math.exp(-0.9 / 0.1), 5);
  });
});

describe("summarizeFeatures", () => {
  function features(partial: Partial<AudioFeatures>): AudioFeatures {
    return {
      ready: true,
      duration: 4,
      frameRate: 2,
      bpm: 120,
      beats: [0.5, 1, 1.5, 2],
      energy: new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.5, 0.25, 0]),
      low: new Float32Array(8),
      mid: new Float32Array(8),
      high: new Float32Array(8),
      onset: new Float32Array(8),
      pitch: new Float32Array(8),
      pitchConf: new Float32Array(8),
      key: null,
      keyConfidence: null,
      tuningCents: null,
      notes: [],
      voicedRatio: 0,
      ...partial,
    };
  }

  it("reports a not-ready summary for empty features", () => {
    const s = api().summarizeFeatures(null);
    expect(s.ready).toBe(false);
    expect(s.beats).toEqual([]);
    expect(s.energy).toEqual([]);
    expect(s.bpm).toBeNull();
    expect(s.pitch).toEqual([]);
    expect(s.notes).toEqual([]);
    expect(s.noteCount).toBe(0);
    expect(s.key).toBeNull();
    expect(s.keyConfidence).toBeNull();
    expect(s.tuningCents).toBeNull();
    expect(s.voicedRatio).toBe(0);
  });

  it("downsamples curves to the requested resolution", () => {
    const s = api().summarizeFeatures(features({}), { curvePoints: 4 });
    expect(s.curvePoints).toBe(4);
    expect(s.energy).toHaveLength(4);
    expect(s.low).toHaveLength(4);
    expect(s.high).toHaveLength(4);
    expect(s.onset).toHaveLength(4);
    expect(s.energy.every((v) => v >= 0 && v <= 1)).toBe(true);
  });

  it("keeps beat count while capping the returned list", () => {
    const many = Array.from({ length: 50 }, (_, i) => i * 0.1);
    const s = api().summarizeFeatures(features({ beats: many }), {
      maxBeats: 10,
    });
    expect(s.beatCount).toBe(50);
    expect(s.beats).toHaveLength(10);
    expect(s.beats).toEqual([...s.beats].sort((a, b) => a - b));
  });

  it("is JSON serializable (no typed arrays leak out)", () => {
    const s = api().summarizeFeatures(features({}), { curvePoints: 6 });
    expect(() => JSON.stringify(s)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(s));
    expect(parsed.energy).toHaveLength(6);
  });
});

describe("api shape guards (TS types vs injected JS)", () => {
  // There is no TypeScript mirror of the injected script, so these tests fail
  // loudly if the JS object drifts from the documented AudioReactiveApi /
  // AudioAnalysisSummary types.
  it("createAudioApi exposes exactly the AudioReactiveApi surface", () => {
    const a = api().createAudioApi(null);
    expect(Object.keys(a).sort()).toEqual(
      [
        "beatPulse",
        "beats",
        "bpm",
        "duration",
        "energy",
        "frameRate",
        "high",
        "key",
        "keyConfidence",
        "tuningCents",
        "level",
        "low",
        "lowAt",
        "highAt",
        "mid",
        "midAt",
        "onset",
        "onsetAt",
        "pitch",
        "pitchAt",
        "pitchConf",
        "pitchConfAt",
        "ready",
      ].sort(),
    );
  });

  it("summarizeFeatures exposes exactly the AudioAnalysisSummary surface", () => {
    const s = api().summarizeFeatures(null);
    expect(Object.keys(s).sort()).toEqual(
      [
        "beatCount",
        "beats",
        "bpm",
        "curvePoints",
        "curveStepSeconds",
        "duration",
        "energy",
        "frameRate",
        "high",
        "key",
        "keyConfidence",
        "tuningCents",
        "low",
        "mid",
        "noteCount",
        "notes",
        "onset",
        "pitch",
        "ready",
        "voicedRatio",
      ].sort(),
    );
  });

  it("emptyFeatures is a usable, not-ready feature object", () => {
    const f = api().emptyFeatures();
    expect(f.ready).toBe(false);
    expect(f.beats).toEqual([]);
    expect(f.energy).toBeInstanceOf(Float32Array);
    expect(f.energy).toHaveLength(0);
  });
});

describe("analyzeAudio edge cases", () => {
  it("does not emit NaN/Infinity for hostile sample values", () => {
    const n = 48000;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      samples[i] = i % 3 === 0 ? NaN : i % 3 === 1 ? Infinity : -Infinity;
    }
    const f = api().analyzeAudio(samples, 48000, 1);
    for (const env of [f.energy, f.low, f.mid, f.high, f.onset]) {
      expect(allFinite(env)).toBe(true);
    }
    expect(Number.isFinite(f.duration)).toBe(true);
  });

  it("handles input shorter than one FFT frame", () => {
    const f = api().analyzeAudio(sine(440, 0.01, 48000), 48000, 1);
    expect(f.ready).toBe(true);
    expect(f.energy.length).toBeGreaterThanOrEqual(1);
    expect(allFinite(f.energy)).toBe(true);
    expect(f.bpm).toBeNull();
    expect(f.beats).toEqual([]);
  });

  it("detects beats in a click track near the true positions", () => {
    const sampleRate = 48000;
    const duration = 4;
    const n = duration * sampleRate;
    const samples = new Float32Array(n);
    const clickLen = Math.round(0.004 * sampleRate);
    for (let beat = 0; beat < 8; beat += 1) {
      const at = Math.round(beat * 0.5 * sampleRate);
      for (let i = 0; i < clickLen && at + i < n; i += 1) {
        samples[at + i] = i < clickLen / 2 ? 1 : -1;
      }
    }
    const f = api().analyzeAudio(samples, sampleRate, duration);
    expect(f.beats.length).toBeGreaterThanOrEqual(6);
    for (const beat of f.beats.slice(0, 7)) {
      const nearest = Math.round(beat / 0.5) * 0.5;
      expect(Math.abs(beat - nearest)).toBeLessThan(0.08);
    }
    expect(f.bpm).not.toBeNull();
    expect(Math.abs((f.bpm as number) - 120)).toBeLessThan(6);
  });
});

describe("melody (pitch, notes, key)", () => {
  // Deterministic pseudo-random noise (seeded LCG) so tests stay stable.
  function noise(seconds: number, sampleRate: number, amp = 0.5) {
    const n = Math.round(seconds * sampleRate);
    const out = new Float32Array(n);
    let state = 123456789;
    for (let i = 0; i < n; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      out[i] = amp * (state / 0x3fffffff - 1);
    }
    return out;
  }

  function concat(...parts: Float32Array[]) {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  function voicedMedianPitch(f: AudioFeatures): number {
    const voiced: number[] = [];
    for (let i = 0; i < f.pitch.length; i += 1) {
      if (f.pitch[i] > 0) voiced.push(f.pitch[i]);
    }
    if (voiced.length === 0) return 0;
    voiced.sort((a, b) => a - b);
    return voiced[Math.floor(voiced.length / 2)];
  }

  it("tracks a clean 440 Hz tone near its true frequency", () => {
    const f = api().analyzeAudio(sine(440, 2, 22050), 22050, 2);
    expect(f.ready).toBe(true);
    expect(f.voicedRatio).toBeGreaterThan(0.8);
    expect(Math.abs(voicedMedianPitch(f) - 440)).toBeLessThan(6);
    expect(f.pitch).toHaveLength(f.energy.length);
    expect(f.pitchConf).toHaveLength(f.energy.length);
    expect(allFinite(f.pitch)).toBe(true);
    expect(allFinite(f.pitchConf)).toBe(true);
  });

  it("reports A4 with ~zero tuning offset for a concert-pitch tone", () => {
    const f = api().analyzeAudio(sine(440, 2, 22050), 22050, 2);
    const a4 = f.notes.filter((n) => n.midi === 69);
    expect(a4.length).toBeGreaterThan(0);
    expect(a4[0].note).toBe("A4");
    expect(f.tuningCents).not.toBeNull();
    expect(Math.abs(f.tuningCents as number)).toBeLessThan(10);
  });

  it("segments a two-note line into A3 then A4", () => {
    const line = concat(sine(220, 1, 22050), sine(440, 1, 22050));
    const f = api().analyzeAudio(line, 22050, 2);
    const midis = f.notes.map((n) => n.midi);
    expect(midis).toContain(57);
    expect(midis).toContain(69);
    expect(f.notes.length).toBeGreaterThanOrEqual(2);
    for (const n of f.notes) {
      expect(n.end).toBeGreaterThan(n.start);
      expect(n.note).toMatch(/^[A-G]#?\d$/);
      expect(n.freq).toBeGreaterThan(0);
    }
    // Notes are ascending in time and non-overlapping.
    for (let i = 1; i < f.notes.length; i += 1) {
      expect(f.notes[i].start).toBeGreaterThanOrEqual(f.notes[i - 1].start);
    }
  });

  it("hears C major in a C-E-G arpeggio", () => {
    const arp = concat(
      sine(261.63, 0.5, 22050, 0.7),
      sine(329.63, 0.5, 22050, 0.7),
      sine(392.0, 0.5, 22050, 0.7),
    );
    const f = api().analyzeAudio(arp, 22050, 2);
    const midis = new Set(f.notes.map((n) => n.midi));
    expect(midis.has(60)).toBe(true);
    expect(midis.has(64)).toBe(true);
    expect(midis.has(67)).toBe(true);
    expect(f.key).toBe("C major");
    expect(f.keyConfidence).not.toBeNull();
  });

  it("stays silent on silence: no pitch, no notes, no key", () => {
    const f = api().analyzeAudio(new Float32Array(22050), 22050, 1);
    expect(f.ready).toBe(true);
    expect(f.voicedRatio).toBe(0);
    expect(Array.from(f.pitch).every((v) => v === 0)).toBe(true);
    expect(f.notes).toEqual([]);
    expect(f.key).toBeNull();
    expect(f.keyConfidence).toBeNull();
    expect(f.tuningCents).toBeNull();
  });

  it("refuses to hear melody in broadband noise", () => {
    const f = api().analyzeAudio(noise(2, 22050), 22050, 2);
    expect(f.ready).toBe(true);
    expect(f.voicedRatio).toBeLessThan(0.3);
    expect(f.notes).toEqual([]);
  });

  it("keeps note freq consistent with note midi under interference", () => {
    // Sustained 55 Hz with brief 140 Hz blips: the blips must not drag the
    // reported freq far from the reported midi (the A1/142 Hz failure).
    const sr = 22050;
    const total = Math.round(2 * sr);
    const samples = new Float32Array(total);
    for (let i = 0; i < total; i += 1) {
      // Quiet base with loud single-frame blips an octave-plus away: the
      // blips flip some frame winners but never the smoothed midi track.
      samples[i] = 0.5 * Math.sin((2 * Math.PI * 55 * i) / sr);
      const phase = i / sr % 0.23;
      if (phase < 0.03) {
        samples[i] += 1.0 * Math.sin((2 * Math.PI * 140 * i) / sr);
      }
    }
    const f = api().analyzeAudio(samples, sr, 2);
    expect(f.notes.length).toBeGreaterThan(0);
    for (const note of f.notes) {
      const midiFloat = 69 + 12 * Math.log2(note.freq / 440);
      expect(Math.abs(midiFloat - note.midi)).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic across runs", () => {
    const samples = concat(sine(220, 1, 22050), sine(440, 1, 22050));
    const first = api().analyzeAudio(samples, 22050, 2);
    const second = api().analyzeAudio(samples, 22050, 2);
    expect(Array.from(first.pitch)).toEqual(Array.from(second.pitch));
    expect(Array.from(first.pitchConf)).toEqual(
      Array.from(second.pitchConf),
    );
    expect(first.notes).toEqual(second.notes);
    expect(first.key).toBe(second.key);
    expect(first.tuningCents).toBe(second.tuningCents);
  });

  it("summarizes pitch, notes and key as JSON-safe output", () => {
    const f = api().analyzeAudio(sine(440, 2, 22050), 22050, 2);
    const s = api().summarizeFeatures(f, { curvePoints: 8 });
    expect(s.pitch).toHaveLength(8);
    expect(s.noteCount).toBe(f.notes.length);
    expect(s.notes.length).toBeLessThanOrEqual(200);
    expect(s.voicedRatio).toBeGreaterThan(0.8);
    expect(() => JSON.stringify(s)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(s));
    expect(parsed.pitch).toHaveLength(8);
    expect(parsed.notes[0].note).toBe("A4");
  });

  it("caps long note lists but keeps the total count", () => {
    const parts: Float32Array[] = [];
    for (let i = 0; i < 12; i += 1) {
      parts.push(sine(i % 2 === 0 ? 220 : 440, 0.4, 22050));
    }
    const f = api().analyzeAudio(concat(...parts), 22050, 5);
    const s = api().summarizeFeatures(f, { maxNotes: 3 });
    expect(s.noteCount).toBe(f.notes.length);
    expect(s.notes).toHaveLength(Math.min(3, f.notes.length));
  });

  it("exposes pitch lookups on the render-time audio object", () => {
    const f = api().analyzeAudio(sine(440, 2, 22050), 22050, 2);
    const a = api().createAudioApi(f);
    expect(a.pitchAt(1)).toBeGreaterThan(0);
    expect(a.pitchConfAt(1)).toBeGreaterThan(0);
    expect(a.pitchAt(99)).toBe(a.pitchAt(2));
    const silent = api().createAudioApi(null);
    expect(silent.pitchAt(1)).toBe(0);
  });
});

describe("createSpeechApi", () => {
  const SPEECH = {
    language: "en",
    text: "hello world",
    segments: [
      { start: 2, end: 3.5, text: "world" },
      { start: 0, end: 2, text: "  hello   " },
      { start: 9, end: 9, text: "zero length" },
      { start: 5, end: 6, text: "" },
      { start: NaN, end: 7, text: "nan" },
      { start: 4, end: 5, text: "there" },
    ],
  };

  it("is always an object, ready or not", () => {
    const s = api().createSpeechApi(null);
    expect(s.ready).toBe(false);
    expect(s.segments).toEqual([]);
    expect(s.count).toBe(0);
    expect(s.duration).toBe(0);
    expect(s.language).toBeNull();
    expect(s.text).toBe("");
    expect(s.activeIndex(1)).toBe(-1);
    expect(s.activeSegment(1)).toBeNull();
    expect(s.activeText(1)).toBe("");
    expect(s.progress(1)).toBe(0);
    expect(s.nextStart(1)).toBeNull();
    expect(s.segmentAt(0)).toBeNull();
  });

  it("normalizes, sorts, trims and drops invalid spans", () => {
    const s = api().createSpeechApi(SPEECH, 10);
    expect(s.ready).toBe(true);
    expect(s.language).toBe("en");
    expect(s.text).toBe("hello world");
    expect(s.count).toBe(3);
    expect(s.segments).toEqual([
      { start: 0, end: 2, text: "hello" },
      { start: 2, end: 3.5, text: "world" },
      { start: 4, end: 5, text: "there" },
    ]);
    expect(s.duration).toBe(5);
  });

  it("clamps spans to the video duration", () => {
    const s = api().createSpeechApi(
      {
        segments: [
          { start: 4, end: 9, text: "clipped" },
          { start: 8, end: 9, text: "outside" },
        ],
      },
      5,
    );
    expect(s.segments).toEqual([{ start: 4, end: 5, text: "clipped" }]);
  });

  it("shifts every span by offset", () => {
    const s = api().createSpeechApi(
      { offset: 3, segments: [{ start: 0, end: 1, text: "a" }] },
      10,
    );
    expect(s.segments).toEqual([{ start: 3, end: 4, text: "a" }]);
  });

  it("resolves the active span, text, progress and next start", () => {
    const s = api().createSpeechApi(SPEECH, 10);
    expect(s.activeIndex(1)).toBe(0);
    expect(s.activeText(1)).toBe("hello");
    expect(s.activeText(3)).toBe("world");
    expect(s.progress(2.75)).toBeCloseTo(0.5, 5);
    expect(s.activeSegment(4.5)).toEqual({ start: 4, end: 5, text: "there" });
    expect(s.activeIndex(4)).toBe(2); // start is inclusive
    expect(s.activeIndex(5)).toBe(-1); // end is exclusive
    expect(s.activeIndex(3.5)).toBe(-1); // gap between spans
    expect(s.segmentAt(99)).toBeNull();
    expect(s.nextStart(0)).toBe(2);
    expect(s.nextStart(4)).toBeNull();
    expect(s.nextStart(-5)).toBe(0);
  });

  it("exposes exactly the SpeechApi surface", () => {
    const s = api().createSpeechApi(null);
    expect(Object.keys(s).sort()).toEqual(
      [
        "activeIndex",
        "activeSegment",
        "activeText",
        "count",
        "duration",
        "language",
        "nextStart",
        "progress",
        "ready",
        "segmentAt",
        "segments",
        "text",
      ].sort(),
    );
  });

  it("caps individual span text length", () => {
    const long = "y".repeat(500);
    const s = api().createSpeechApi(
      { segments: [{ start: 0, end: 1, text: long }] },
      5,
    );
    expect(s.segments[0].text).toBe("y".repeat(400));
  });

  it("caps the number of spans it will track", () => {
    const many: { start: number; end: number; text: string }[] = [];
    for (let i = 0; i < 2500; i += 1) {
      many.push({ start: i, end: i + 0.5, text: "x" });
    }
    const s = api().createSpeechApi({ segments: many }, 0);
    expect(s.count).toBe(2000);
  });
});

describe("buildAudioAnalysisDocument", () => {
  it("embeds the engine, the config and the bootstrap hook", () => {
    const html = buildAudioAnalysisDocument({
      src: "data:audio/mpeg;base64,QUJD",
      maxSeconds: 30,
    });
    expect(html).toContain(VIDEO_AUDIO_ANALYSIS_SCRIPT);
    expect(html).toContain("window.__MOBILE_AGENT_ANALYZE__");
    expect(html).toContain("window.__startMobileAgentAudioAnalysis");
    expect(html).toContain("mobileAgentAudioAnalysis");
    expect(html).toContain("data:audio/mpeg;base64,QUJD");
  });

  it("escapes angle brackets so the config cannot break out of its script tag", () => {
    const html = buildAudioAnalysisDocument({
      src: "data:audio/mpeg;base64,PA==<>",
    });
    // The escaped payload keeps the raw angle brackets out of the document.
    expect(html).not.toContain("base64,PA==<>");
    expect(html).toContain("base64,PA==\\u003c\\u003e");
  });

  it("fills in safe defaults for every config field", () => {
    const html = buildAudioAnalysisDocument({ src: "data:audio/mpeg;base64,QQ==" });
    expect(html).toContain('"maxSeconds":90');
    expect(html).toContain('"sampleRate":22050');
    expect(html).toContain('"maxBeats":300');
    expect(html).toContain('"curvePoints":24');
  });

  it("omits PCM unless a pcmSampleRate is requested", () => {
    const off = buildAudioAnalysisDocument({ src: "data:audio/mpeg;base64,QQ==" });
    expect(off).toContain('"pcmSampleRate":0');

    const on = buildAudioAnalysisDocument({
      src: "data:audio/mpeg;base64,QQ==",
      pcmSampleRate: 16000,
    });
    expect(on).toContain('"pcmSampleRate":16000');
  });

  it("ships the PCM16 encoder only in the decode bootstrap", () => {
    const html = buildAudioAnalysisDocument({ src: "data:audio/mpeg;base64,QQ==" });
    expect(html).toContain("encodePcm16Base64");
    expect(html).toContain("pcmBase64");
    expect(html).toContain("pcmSampleRate");
    // The encoder must live in the document bootstrap, not the reusable engine.
    expect(VIDEO_AUDIO_ANALYSIS_SCRIPT).not.toContain("encodePcm16Base64");
  });

  it("only runs once even if the start hook is called twice", () => {
    const html = buildAudioAnalysisDocument({ src: "data:audio/mpeg;base64,QQ==" });
    expect(html).toContain("__mobileAgentAudioAnalysisStarted");
  });
});
