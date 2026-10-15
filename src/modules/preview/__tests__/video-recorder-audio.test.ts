import { afterEach, describe, expect, it, vi } from "vitest";

import { VIDEO_EXPORT_SCRIPT } from "@/modules/preview/video-recorder";
import { VIDEO_AUDIO_ANALYSIS_SCRIPT } from "@/modules/preview/video-audio-analysis";

type Posted = { type: string; [key: string]: unknown };

type RecordedOscillator = {
  type: string;
  frequency: {
    value: number;
    setCalls: [number, number][];
    rampCalls: [number, number][];
    setValueAtTime: (value: number, time: number) => void;
    exponentialRampToValueAtTime: (value: number, time: number) => void;
  };
  startCalls: number[];
  connect: () => void;
  start: (time: number) => void;
  stop: () => void;
};

type RecordedSource = {
  buffer: unknown;
  loop: boolean;
  startCalls: unknown[][];
  connect: () => void;
  start: (...args: unknown[]) => void;
  stop: () => void;
};

type RecordedGain = {
  gain: {
    value: number;
    setCalls: [number, number][];
    rampCalls: [number, number][];
    setValueAtTime: (value: number, time: number) => void;
    linearRampToValueAtTime: (value: number, time: number) => void;
    exponentialRampToValueAtTime: () => void;
  };
  connect: () => void;
};

type RecordedConvolver = {
  buffer: unknown;
  connect: () => void;
};

type RecordedDelay = {
  delayTime: { value: number };
  connect: () => void;
};

type OfflineStubs = {
  oscillators: RecordedOscillator[];
  sources: RecordedSource[];
  gains: RecordedGain[];
  convolvers: RecordedConvolver[];
  delays: RecordedDelay[];
};

function installBrowserStubs(options: {
  audio?: "full" | "missing" | "pcm" | "pcm-legacy" | "aac-unsupported";
  fetchImpl?: typeof fetch;
  /** Omit createConvolver/createDelay to simulate an ancient WebView. */
  noFxApi?: boolean;
  /** Constant fill for the fake offline-rendered stem buffer. */
  stemFill?: number;
} = {}) {
  const messages: Posted[] = [];
  const oscillators: RecordedOscillator[] = [];
  const sources: RecordedSource[] = [];
  const convolvers: RecordedConvolver[] = [];
  const delays: RecordedDelay[] = [];
  const gains: RecordedGain[] = [];
  const offline: OfflineStubs = {
    oscillators: [],
    sources: [],
    gains: [],
    convolvers: [],
    delays: [],
  };
  const g = globalThis as Record<string, unknown>;

  const canvas = {
    width: 1280,
    height: 720,
    offsetWidth: 1280,
    parentNode: null,
    nextSibling: null,
    getAttribute: () => null,
    setAttribute: () => {},
    removeAttribute: () => {},
    getContext: () => ({}),
    toDataURL: () => "data:image/jpeg;base64,/9j/4AAQ==",
  };

  g.window = {
    MOBILE_AGENT_VIDEO: null,
    ReactNativeWebView: {
      postMessage: (data: string) => {
        const message = JSON.parse(data);
        messages.push(message);
        if (message.requestId !== undefined) {
          (g.window as Record<string, (id: number) => void>).__mobileAgentExportConsumed(message.requestId);
        }
      },
    },
  };
  g.document = {
    getElementById: () => null,
    querySelectorAll: () => [canvas],
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }),
    body: { appendChild: () => {} },
  };

  if (options.audio && options.audio !== "missing") {
    const gainNode = () => {
      const gain = {
        value: 1,
        setCalls: [] as [number, number][],
        rampCalls: [] as [number, number][],
        setValueAtTime: (value: number, time: number) => {
          gain.setCalls.push([value, time]);
        },
        linearRampToValueAtTime: (value: number, time: number) => {
          gain.rampCalls.push([value, time]);
        },
        exponentialRampToValueAtTime: () => {},
      };
      const node: RecordedGain = { gain, connect: () => {} };
      gains.push(node);
      return node;
    };
    class FakeAudioContext {
      sampleRate = 48000;
      currentTime = 0;
      state = "running";
      __mobileAgentNoise: unknown = null;
      constructor() {
        if (options.noFxApi) return;
        const self = this as unknown as {
          createConvolver: () => RecordedConvolver;
          createDelay: (max: number) => RecordedDelay;
        };
        self.createConvolver = () => {
          const node: RecordedConvolver = { buffer: null, connect: () => {} };
          convolvers.push(node);
          return node;
        };
        self.createDelay = () => {
          const node: RecordedDelay = {
            delayTime: { value: 0 },
            connect: () => {},
          };
          delays.push(node);
          return node;
        };
      }
      suspend() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      createGain() {
        return gainNode();
      }
      destination = {};
      createScriptProcessor() {
        const processor = {
          onaudioprocess: null as ((event: { inputBuffer: {
            length: number; numberOfChannels: number; getChannelData: () => Float32Array;
          } }) => void) | null,
          connect: () => {
            void Promise.resolve().then(() => processor.onaudioprocess?.({ inputBuffer: {
              length: 2, numberOfChannels: 1,
              getChannelData: () => new Float32Array([0.5, -0.5]),
            } }));
          },
          disconnect: () => {},
        };
        return processor;
      }
      createOscillator() {
        const frequency = {
          value: 440,
          setCalls: [] as [number, number][],
          rampCalls: [] as [number, number][],
          setValueAtTime: (value: number, time: number) => {
            frequency.setCalls.push([value, time]);
          },
          exponentialRampToValueAtTime: (value: number, time: number) => {
            frequency.rampCalls.push([value, time]);
          },
        };
        const startCalls: number[] = [];
        const oscillator: RecordedOscillator = {
          type: "sine",
          frequency,
          startCalls,
          connect: () => {},
          start: (time: number) => {
            startCalls.push(time);
          },
          stop: () => {},
        };
        oscillators.push(oscillator);
        return oscillator;
      }
      createBufferSource() {
        const startCalls: unknown[][] = [];
        const source: RecordedSource = {
          buffer: null,
          loop: false,
          startCalls,
          connect: () => {},
          start: (...args: unknown[]) => {
            startCalls.push(args);
          },
          stop: () => {},
        };
        sources.push(source);
        return source;
      }
      createBiquadFilter() {
        return {
          type: "lowpass",
          frequency: {
            value: 800,
            setValueAtTime: () => {},
            exponentialRampToValueAtTime: () => {},
          },
          Q: { value: 1 },
          connect: () => {},
        };
      }
      createBuffer(channels: number, length: number, rate: number) {
        const channelData: Float32Array[] = [];
        for (let c = 0; c < channels; c += 1) {
          channelData.push(new Float32Array(length));
        }
        return {
          length,
          sampleRate: rate,
          numberOfChannels: channels,
          getChannelData: (ch: number) => channelData[ch],
        };
      }
      createMediaStreamDestination() {
        return {
          channelCount: 2,
          stream: { getAudioTracks: () => [{}] },
        };
      }
      decodeAudioData() {
        const length = 48000;
        const data = new Float32Array(length);
        for (let i = 0; i < length; i += 1) {
          data[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / 48000);
        }
        return Promise.resolve({
          numberOfChannels: 1,
          sampleRate: 48000,
          duration: 1,
          getChannelData: () => data,
        });
      }
    }
    class FakeAudioEncoder {
      static isConfigSupported() {
        return Promise.resolve({ supported: options.audio !== "aac-unsupported" });
      }
      configure() {}
      encode() {}
      flush() {
        return Promise.resolve();
      }
      close() {}
    }
    class FakeTrackProcessor {
      constructor() {
        if (options.audio === "pcm-legacy") throw new Error("Audio tracks not supported");
      }
      private delivered = false;
      readable = {
        getReader: () => ({
          read: () => {
            if (this.delivered || options.audio === "full") return Promise.resolve({ done: true });
            this.delivered = true;
            return Promise.resolve({ done: false, value: {
              timestamp: 0, numberOfChannels: 1, numberOfFrames: 2, format: "s16",
              allocationSize: () => 4,
              copyTo: (buffer: ArrayBuffer) => new Int16Array(buffer).set([16384, -16384]),
              close: () => {},
            } });
          },
          cancel: () => Promise.resolve(),
        }),
      };
    }
    class FakeOfflineAudioContext {
      sampleRate: number;
      numberOfChannels: number;
      length: number;
      destination = {};
      __mobileAgentNoise: unknown = null;
      private channelData: Float32Array[];
      constructor(channels: number, length: number, rate: number) {
        this.numberOfChannels = channels;
        this.length = length;
        this.sampleRate = rate;
        this.channelData = [];
        const fill = options.stemFill ?? 0.5;
        for (let c = 0; c < channels; c += 1) {
          this.channelData.push(new Float32Array(length).fill(fill));
        }
        if (options.noFxApi) {
          Object.assign(this, { createConvolver: undefined, createDelay: undefined });
        }
      }
      decodeAudioData() { return FakeAudioContext.prototype.decodeAudioData(); }
      createGain() {
        const gain = {
          value: 1,
          setCalls: [] as [number, number][],
          rampCalls: [] as [number, number][],
          setValueAtTime: (value: number, time: number) => {
            gain.setCalls.push([value, time]);
          },
          linearRampToValueAtTime: (value: number, time: number) => {
            gain.rampCalls.push([value, time]);
          },
          exponentialRampToValueAtTime: () => {},
        };
        const node: RecordedGain = { gain, connect: () => {} };
        offline.gains.push(node);
        return node;
      }
      createOscillator() {
        const frequency = {
          value: 440,
          setCalls: [] as [number, number][],
          rampCalls: [] as [number, number][],
          setValueAtTime: (value: number, time: number) => {
            frequency.setCalls.push([value, time]);
          },
          exponentialRampToValueAtTime: (value: number, time: number) => {
            frequency.rampCalls.push([value, time]);
          },
        };
        const startCalls: number[] = [];
        const oscillator: RecordedOscillator = {
          type: "sine",
          frequency,
          startCalls,
          connect: () => {},
          start: (time: number) => {
            startCalls.push(time);
          },
          stop: () => {},
        };
        offline.oscillators.push(oscillator);
        return oscillator;
      }
      createBufferSource() {
        const startCalls: unknown[][] = [];
        const source: RecordedSource = {
          buffer: null,
          loop: false,
          startCalls,
          connect: () => {},
          start: (...args: unknown[]) => {
            startCalls.push(args);
          },
          stop: () => {},
        };
        offline.sources.push(source);
        return source;
      }
      createBiquadFilter() {
        return {
          type: "lowpass",
          frequency: {
            value: 800,
            setValueAtTime: () => {},
            exponentialRampToValueAtTime: () => {},
          },
          Q: { value: 1 },
          connect: () => {},
        };
      }
      createBuffer(channels: number, length: number, rate: number) {
        const channelData: Float32Array[] = [];
        for (let c = 0; c < channels; c += 1) {
          channelData.push(new Float32Array(length));
        }
        return {
          length,
          sampleRate: rate,
          numberOfChannels: channels,
          getChannelData: (ch: number) => channelData[ch],
        };
      }
      createConvolver() {
        const node: RecordedConvolver = { buffer: null, connect: () => {} };
        offline.convolvers.push(node);
        return node;
      }
      createDelay() {
        const node: RecordedDelay = {
          delayTime: { value: 0 },
          connect: () => {},
        };
        offline.delays.push(node);
        return node;
      }
      startRendering() {
        return Promise.resolve({
          length: this.length,
          numberOfChannels: this.numberOfChannels,
          sampleRate: this.sampleRate,
          getChannelData: (ch: number) => this.channelData[ch],
        });
      }
    }
    (g.window as Record<string, unknown>).AudioContext = FakeAudioContext;
    if (options.audio !== "pcm" && options.audio !== "pcm-legacy") {
      (g.window as Record<string, unknown>).AudioEncoder = FakeAudioEncoder;
    }
    (g.window as Record<string, unknown>).MediaStreamTrackProcessor =
      FakeTrackProcessor;
    (g.window as Record<string, unknown>).OfflineAudioContext =
      FakeOfflineAudioContext;
    // The recorder string uses bare globals (window IS the global scope in a
    // WebView); mirror them onto globalThis for the Node harness.
    g.AudioContext = FakeAudioContext;
    if (options.audio !== "pcm" && options.audio !== "pcm-legacy") g.AudioEncoder = FakeAudioEncoder;
    g.MediaStreamTrackProcessor = FakeTrackProcessor;
    g.OfflineAudioContext = FakeOfflineAudioContext;
  }

  if (options.fetchImpl) {
    g.fetch = options.fetchImpl;
  }

  // Production injects the analysis script into the same document before the
  // recorder; mirror that here so the audio-reactive path is exercised.
  new Function(VIDEO_AUDIO_ANALYSIS_SCRIPT)();

  return { messages, canvas, oscillators: offline.oscillators, sources: offline.sources, convolvers: offline.convolvers, delays: offline.delays, gains: offline.gains, offline };
}

function runScript() {
  // Parses (syntax check) and executes the recorder string like a WebView would.
  new Function(VIDEO_EXPORT_SCRIPT)();
  return (globalThis as Record<string, unknown>).window as Record<
    string,
    (...args: unknown[]) => unknown
  >;
}

function setContract(contract: unknown) {
  const w = (globalThis as Record<string, unknown>).window as Record<
    string,
    unknown
  >;
  w.MOBILE_AGENT_VIDEO = contract;
  delete (w as Record<string, unknown>).__mobileAgentVideoExportScript;
  runScript();
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.fetch;
  delete g.AudioContext;
  delete g.AudioEncoder;
  delete g.MediaStreamTrackProcessor;
  delete g.OfflineAudioContext;
  vi.unstubAllGlobals();
});

describe("VIDEO_EXPORT_SCRIPT audio engine", () => {
  it("preserves note-name regex escapes in the actual injected script", async () => {
    const { messages, oscillators } = installBrowserStubs({ audio: "full" });
    setContract({ duration: 1, fps: 5, render: () => {}, audio: {
      tracks: [{ synth: { kind: "pad", notes: ["C3", "G3", "Bb3"] } }],
    } });
    const w = runScript();
    w.__startMobileAgentVideoExport();
    await vi.waitFor(() => expect(messages.some((m) => m.type === "mobileAgentVideoDone")).toBe(true), { timeout: 8000 });
    expect(oscillators).toHaveLength(6);
    expect(oscillators[0].frequency.value).toBeCloseTo(130.8128, 3);
    expect(oscillators[2].frequency.value).toBeCloseTo(195.9977, 3);
    expect(oscillators[4].frequency.value).toBeCloseTo(233.0819, 3);
  }, 15000);

  it.each(["pcm", "pcm-legacy", "aac-unsupported"] as const)("uses native PCM encoding when audio mode is %s", async (audio) => {
    const { messages } = installBrowserStubs({ audio });
    setContract({ duration: 1, fps: 5, render: () => {}, audio: {
      tracks: [{ synth: { kind: "pad", notes: ["D3", "A3"] } }],
    } });
    const w = runScript();
    w.__startMobileAgentVideoExport();
    await vi.waitFor(() => expect(messages.some((m) => m.type === "mobileAgentVideoDone")).toBe(true), { timeout: 8000 });
    expect(messages.find((m) => m.type === "mobileAgentVideoAudioConfig")).toMatchObject({
      sampleRate: 48000, channels: 2, encoding: "pcm16",
    });
    const pcm = messages.find((m) => m.type === "mobileAgentVideoAudioPcmChunk");
    expect(pcm).toBeDefined();
    const bytes = Buffer.from(pcm!.base64 as string, "base64");
    // The offline renderer fixture outputs a constant +0.5 in both channels.
    expect([0, 2, 4, 6].map((offset) => bytes.readInt16LE(offset))).toEqual([16384, 16384, 16384, 16384]);
    expect(messages.findIndex((m) => m.type === "mobileAgentVideoAudioPcmChunk")).toBeLessThan(
      messages.findIndex((m) => m.type === "mobileAgentVideoDone"),
    );
    expect(messages.some((m) => m.type === "mobileAgentVideoAudioUnsupported")).toBe(false);
  }, 15000);
  it("records a silent video exactly as before when no audio schedule exists", async () => {
    const { messages } = installBrowserStubs();
    setContract({ duration: 1, fps: 5, render: () => {} });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const types = messages.map((m) => m.type);
    expect(types[0]).toBe("mobileAgentVideoConfig");
    expect(types).not.toContain("mobileAgentVideoAudioConfig");
    expect(types).not.toContain("mobileAgentVideoError");
    expect(messages.filter((m) => m.type === "mobileAgentVideoFrame")).toHaveLength(5);
  }, 15000);

  it("posts the audio config and still finishes when the full WebAudio stack exists", async () => {
    const { messages } = installBrowserStubs({ audio: "full" });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        master: 0.9,
        tracks: [
          { synth: { kind: "pad", notes: ["C3", "G3", 47], attack: 0.2 }, start: 0, duration: 1, volume: 0.3 },
          { synth: { kind: "tone", notes: [60, "C5"], noteDur: 0.2 }, start: 0, duration: 1, volume: 0.4 },
          { synth: { kind: "noise", filterFreq: 400, filterEnd: 4000 }, start: 0, duration: 1, volume: 0.2 },
          { synth: { kind: "bogus" }, start: 0 },
          { nope: true },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const types = messages.map((m) => m.type);
    const audioConfig = messages.find(
      (m) => m.type === "mobileAgentVideoAudioConfig",
    );
    expect(audioConfig).toMatchObject({ sampleRate: 48000, channels: 2 });
    // Audio config precedes every video frame (native muxer needs it first).
    expect(types.indexOf("mobileAgentVideoAudioConfig")).toBeLessThan(
      types.indexOf("mobileAgentVideoFrame"),
    );
    expect(types).not.toContain("mobileAgentVideoError");
    expect(types).not.toContain("mobileAgentVideoAudioUnsupported");
  }, 15000);

  it("fails explicitly rather than silently omitting a requested soundtrack", async () => {
    const { messages } = installBrowserStubs();
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: { tracks: [{ synth: { kind: "tone", freq: 440 }, duration: 1 }] },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoError"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoDone");
    expect(types).toContain("mobileAgentVideoError");
  }, 15000);

  it("fails explicitly when a requested audio asset cannot be loaded", async () => {
    const { messages } = installBrowserStubs({
      audio: "full",
      fetchImpl: (() => Promise.reject(new Error("nope"))) as typeof fetch,
    });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          { file: "data:audio/mpeg;base64,QUJD", start: 0, volume: 0.5 },
          { synth: { kind: "tone", freq: 440 }, start: 0, duration: 1 },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoError"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoDone");
    expect(types).toContain("mobileAgentVideoError");
  }, 15000);

  it("hands render an audio-reactive object for decoded file audio", async () => {
    const { messages } = installBrowserStubs({
      audio: "full",
      fetchImpl: (() =>
        Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        })) as unknown as typeof fetch,
    });
    const seen: unknown[] = [];
    let globalDuringRender: unknown = null;
    setContract({
      duration: 1,
      fps: 5,
      render: (_t: number, _canvas: unknown, _ctx: unknown, audio: unknown) => {
        seen.push(audio);
        const win = (globalThis as Record<string, unknown>).window as Record<
          string,
          unknown
        >;
        globalDuringRender = win.MOBILE_AGENT_VIDEO_AUDIO;
      },
      audio: {
        master: 1,
        tracks: [
          { file: "data:audio/mpeg;base64,QUJD", start: 0, duration: 1 },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(messages.some((m) => m.type === "mobileAgentVideoError")).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    const audio = seen[seen.length - 1] as {
      ready: boolean;
      level: (t: number) => number;
      beats: number[];
      bpm: number | null;
    };
    expect(audio).toBeTruthy();
    expect(audio.ready).toBe(true);
    expect(typeof audio.level(0.5)).toBe("number");
    expect(Number.isFinite(audio.level(0.5))).toBe(true);
    expect(Array.isArray(audio.beats)).toBe(true);
    // The same object is mirrored for the page at large while rendering.
    expect(globalDuringRender).toBeTruthy();
    expect(globalDuringRender).toBe(audio);
  }, 15000);

  it("still hands render a stable object when no audio schedule exists", async () => {
    installBrowserStubs();
    const seen: unknown[] = [];
    setContract({
      duration: 1,
      fps: 5,
      render: (_t: number, _canvas: unknown, _ctx: unknown, audio: unknown) => {
        seen.push(audio);
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), {
      timeout: 8000,
    });
    const audio = seen[0] as { ready: boolean; level: (t: number) => number };
    expect(audio).toBeTruthy();
    expect(audio.ready).toBe(false);
    expect(audio.level(1)).toBe(0);
  }, 15000);

  it("hands render a deterministic speech track when the contract supplies one", async () => {
    const { messages } = installBrowserStubs();
    const seen: unknown[] = [];
    let globalDuringRender: unknown = null;
    setContract({
      duration: 2,
      fps: 5,
      render: (
        _t: number,
        _canvas: unknown,
        _ctx: unknown,
        _audio: unknown,
        speech: unknown,
      ) => {
        seen.push(speech);
        const win = (globalThis as Record<string, unknown>).window as Record<
          string,
          unknown
        >;
        globalDuringRender = win.MOBILE_AGENT_VIDEO_SPEECH;
      },
      speech: {
        language: "en",
        text: "hello world",
        segments: [
          { start: 1, end: 2, text: "world" },
          { start: 0, end: 1, text: "hello" },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(messages.some((m) => m.type === "mobileAgentVideoError")).toBe(false);
    const speech = seen[seen.length - 1] as {
      ready: boolean;
      language: string | null;
      segments: unknown[];
      activeText: (t: number) => string;
      progress: (t: number) => number;
    };
    expect(speech.ready).toBe(true);
    expect(speech.language).toBe("en");
    expect(speech.segments).toEqual([
      { start: 0, end: 1, text: "hello" },
      { start: 1, end: 2, text: "world" },
    ]);
    expect(speech.activeText(0.5)).toBe("hello");
    expect(speech.activeText(1.5)).toBe("world");
    expect(speech.progress(1.5)).toBeCloseTo(0.5, 5);
    // The same object is mirrored for the page at large while rendering.
    expect(globalDuringRender).toBe(speech);
  }, 15000);

  it("still hands render a stable speech object when the contract has no speech", async () => {
    installBrowserStubs();
    const seen: unknown[] = [];
    setContract({
      duration: 1,
      fps: 5,
      render: (
        _t: number,
        _canvas: unknown,
        _ctx: unknown,
        _audio: unknown,
        speech: unknown,
      ) => {
        seen.push(speech);
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), {
      timeout: 8000,
    });
    const speech = seen[0] as {
      ready: boolean;
      activeIndex: (t: number) => number;
      activeText: (t: number) => string;
    };
    expect(speech).toBeTruthy();
    expect(speech.ready).toBe(false);
    expect(speech.activeIndex(0.5)).toBe(-1);
    expect(speech.activeText(0.5)).toBe("");
  }, 15000);

  it("schedules drum hits at exact pattern times with the documented recipes", async () => {
    const { messages, oscillators, sources } = installBrowserStubs({
      audio: "full",
    });
    setContract({
      duration: 2,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          {
            synth: {
              kind: "drums",
              stepDur: 0.5,
              steps: [["kick", "hat"], [], ["snare"], ["clap"]],
            },
            start: 0,
            duration: 2,
            volume: 0.5,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const t0 = 0;
    // Kick body: sine swept 150 -> 40 Hz with a ~0.4 s decay, plus a click.
    const kickBodies = oscillators.filter(
      (o) => o.type === "sine" && o.frequency.setCalls.length === 1,
    );
    expect(kickBodies).toHaveLength(1);
    expect(kickBodies[0].frequency.setCalls).toEqual([[150, t0]]);
    expect(kickBodies[0].frequency.rampCalls).toEqual([[40, t0 + 0.12]]);
    expect(kickBodies[0].startCalls).toEqual([t0]);
    // Snare: triangle body plus a bandpassed noise burst, on step 2.
    const snareBodies = oscillators.filter((o) => o.type === "triangle");
    expect(snareBodies).toHaveLength(1);
    expect(snareBodies[0].frequency.value).toBe(180);
    expect(snareBodies[0].startCalls).toEqual([t0 + 2 * 0.5]);
    // Hat (step 0), snare rattle (step 2), clap bursts + tail (step 3).
    const sourceStarts = sources.map((s) => s.startCalls[0]?.[0]);
    expect(sourceStarts).toContain(t0);
    expect(sourceStarts).toContain(t0 + 2 * 0.5);
    expect(sourceStarts).toContain(t0 + 3 * 0.5);
    expect(sourceStarts).toHaveLength(6);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("ignores unknown drum hits and drops empty patterns gracefully", async () => {
    const { messages, oscillators, sources } = installBrowserStubs({
      audio: "full",
    });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          {
            synth: {
              kind: "drums",
              steps: [["kick", "cowbell"], "bogus", []],
            },
            start: 0,
            duration: 1,
          },
          { synth: { kind: "drums", steps: [] }, start: 0, duration: 1 },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    // Only the kick survived: one swept body plus its click transient.
    expect(
      oscillators.filter(
        (o) => o.type === "sine" && o.frequency.setCalls.length === 1,
      ),
    ).toHaveLength(1);
    expect(oscillators).toHaveLength(2);
    expect(sources).toHaveLength(0);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("schedules long tone and pad sequences past the old caps", async () => {
    const { messages, oscillators } = installBrowserStubs({ audio: "full" });
    setContract({
      duration: 4,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          {
            synth: {
              kind: "tone",
              wave: "square",
              notes: Array.from({ length: 40 }, (_, i) => 60 + i),
              noteDur: 0.1,
            },
            start: 0,
            duration: 4,
          },
          {
            synth: {
              kind: "pad",
              wave: "sawtooth",
              notes: ["C3", "D3", "E3", "F3", "G3", "A3", "B3", "C4", "D4", "E4"],
            },
            start: 0,
            duration: 4,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    // 40 sequential plucks (the old cap stopped at 32) …
    expect(oscillators.filter((o) => o.type === "square")).toHaveLength(40);
    // … and a 10-voice chord swell at two detuned oscillators per voice.
    expect(oscillators.filter((o) => o.type === "sawtooth")).toHaveLength(20);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("locks sample-exact scheduling of sequential notes", async () => {
    const { messages, oscillators } = installBrowserStubs({ audio: "full" });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          {
            synth: { kind: "tone", notes: [60, 62, 64, 67], noteDur: 0.25 },
            start: 0,
            duration: 1,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const t0 = 0;
    const starts = oscillators.flatMap((o) => o.startCalls);
    expect(starts).toEqual([t0, t0 + 0.25, t0 + 0.5, t0 + 0.75]);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("caps drum patterns at 512 hits with a warning", async () => {
    vi.useFakeTimers();
    try {
      const { messages, oscillators } = installBrowserStubs({ audio: "full" });
      const steps = Array.from({ length: 600 }, () => ["kick"]);
      setContract({
        duration: 45,
        fps: 5,
        render: () => {},
        audio: {
          tracks: [
            {
              synth: { kind: "drums", stepDur: 0.05, steps },
              start: 0,
              duration: 45,
            },
          ],
        },
      });
      const w = runScript();
      (w.__startMobileAgentVideoExport as () => void)();
      await vi.advanceTimersByTimeAsync(60000);

      expect(
        messages.some((m) => m.type === "mobileAgentVideoDone"),
      ).toBe(true);
      expect(
        oscillators.filter(
          (o) => o.type === "sine" && o.frequency.setCalls.length === 1,
        ),
      ).toHaveLength(512);
      const warnings = messages.filter(
        (m) => m.type === "mobileAgentVideoAudioWarning",
      );
      expect(
        warnings.some((m) => String(m.reason).indexOf("512") >= 0),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it("fails explicitly when the soundtrack exceeds the voice budget", async () => {
    vi.useFakeTimers();
    try {
      const { messages, oscillators } = installBrowserStubs({ audio: "full" });
      const steps = Array.from({ length: 512 }, () => ["kick"]);
      const tracks = Array.from({ length: 8 }, () => ({
        synth: { kind: "drums", stepDur: 0.05, steps },
        start: 0,
        duration: 45,
      }));
      setContract({
        duration: 45,
        fps: 5,
        render: () => {},
        audio: { tracks },
      });
      const w = runScript();
      (w.__startMobileAgentVideoExport as () => void)();
      await vi.advanceTimersByTimeAsync(60000);

      expect(
        messages.some((m) => m.type === "mobileAgentVideoError"),
      ).toBe(true);
      // 4096 attempted hits, 2048 claimed; each hit is a body + a click.
      expect(
        oscillators.filter(
          (o) => o.type === "sine" && o.frequency.setCalls.length === 1,
        ),
      ).toHaveLength(2048);
      expect(oscillators).toHaveLength(4096);
      const warnings = messages.filter(
        (m) => m.type === "mobileAgentVideoError",
      );
      expect(
        warnings.some(
          (m) => String(m.message).indexOf("voice limit") >= 0,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it("builds one shared reverb from a deterministic impulse and honors sends", async () => {
    const { messages, convolvers, gains } = installBrowserStubs({
      audio: "full",
    });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        fx: { reverb: { decay: 1 } },
        tracks: [
          {
            synth: { kind: "tone", freq: 440 },
            start: 0,
            duration: 1,
            volume: 0.5,
            reverb: 0.5,
          },
          {
            synth: { kind: "tone", freq: 220 },
            start: 0,
            duration: 1,
            volume: 0.5,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(convolvers).toHaveLength(1);
    const ir = convolvers[0].buffer as {
      length: number;
      sampleRate: number;
      numberOfChannels: number;
      getChannelData: (ch: number) => Float32Array;
    };
    expect(ir.numberOfChannels).toBe(2);
    expect(ir.sampleRate).toBe(48000);
    expect(ir.length).toBe(48000);
    const left = ir.getChannelData(0);
    const right = ir.getChannelData(1);
    // Peak-normalized (across both channels) …
    let peak = 0;
    for (let ch = 0; ch < 2; ch += 1) {
      const arr = ir.getChannelData(ch);
      for (let i = 0; i < arr.length; i += 1) {
        peak = Math.max(peak, Math.abs(arr[i]));
      }
    }
    expect(peak).toBeCloseTo(1, 5);
    // … decaying (early energy dwarfs the tail) …
    const meanAbs = (arr: Float32Array, from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += Math.abs(arr[i]);
      return sum / (to - from);
    };
    expect(meanAbs(left, 0, 4800)).toBeGreaterThan(
      meanAbs(left, 43200, 48000) * 5,
    );
    // … and stereo-decorrelated.
    expect(Array.from(left.slice(0, 32))).not.toEqual(
      Array.from(right.slice(0, 32)),
    );
    // One wet gain plus one send gain at 0.5; the dry cue sends nothing.
    // Gains: master + 2 cue envelopes + 2 plucks + wet + send.
    expect(gains.filter((g) => g.gain.value === 0.5)).toHaveLength(2);
    expect(gains).toHaveLength(7);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("builds the echo bus with capped feedback", async () => {
    const { messages, delays, gains } = installBrowserStubs({ audio: "full" });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        fx: { delay: { time: 0.375, feedback: 5, mix: 0.3 } },
        tracks: [
          {
            synth: { kind: "pad", notes: ["C3"] },
            delay: 0.4,
            start: 0,
            duration: 1,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(delays).toHaveLength(1);
    expect(delays[0].delayTime.value).toBe(0.375);
    expect(gains.filter((g) => g.gain.value === 0.85)).toHaveLength(1);
    expect(gains.filter((g) => g.gain.value === 0.3)).toHaveLength(1);
    expect(gains.filter((g) => g.gain.value === 0.4)).toHaveLength(1);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("accepts reverb/delay shorthands with tuned defaults", async () => {
    const { messages, convolvers, delays, gains } = installBrowserStubs({
      audio: "full",
    });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        fx: { reverb: true, delay: true },
        tracks: [
          {
            synth: { kind: "tone", freq: 440 },
            reverb: 0.3,
            delay: 0.2,
            start: 0,
            duration: 1,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(convolvers).toHaveLength(1);
    expect(delays).toHaveLength(1);
    expect(delays[0].delayTime.value).toBe(0.375);
    // Defaults: feedback 0.35, mix 0.25, wet 0.5 — plus the two sends.
    expect(gains.filter((g) => g.gain.value === 0.35)).toHaveLength(1);
    expect(gains.filter((g) => g.gain.value === 0.25)).toHaveLength(1);
    expect(gains.filter((g) => g.gain.value === 0.5)).toHaveLength(1);
    expect(gains.filter((g) => g.gain.value === 0.3)).toHaveLength(1);
    expect(gains.filter((g) => g.gain.value === 0.2)).toHaveLength(1);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("clamps effect parameters into safe ranges", async () => {
    const { messages, convolvers, delays, gains } = installBrowserStubs({
      audio: "full",
    });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        fx: { reverb: { decay: 10 }, delay: { time: 9, feedback: 5, mix: 2 } },
        tracks: [
          { synth: { kind: "tone", freq: 440 }, start: 0, duration: 1 },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const ir = convolvers[0].buffer as { length: number };
    expect(ir.length).toBe(48000 * 3);
    expect(delays[0].delayTime.value).toBe(2);
    expect(gains.filter((g) => g.gain.value === 0.85)).toHaveLength(1);
    // Master + cue envelope + pluck + wet mix (clamped to 1).
    expect(gains.filter((g) => g.gain.value === 1)).toHaveLength(4);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("creates no effect buses when the schedule has no fx block", async () => {
    const { messages, convolvers, delays } = installBrowserStubs({
      audio: "full",
    });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          { synth: { kind: "tone", freq: 440 }, start: 0, duration: 1 },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(convolvers).toHaveLength(0);
    expect(delays).toHaveLength(0);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoAudioWarning");
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("warns and continues dry when the WebView lacks effect nodes", async () => {
    const { messages, convolvers, delays } = installBrowserStubs({
      audio: "full",
      noFxApi: true,
    });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        fx: { reverb: true, delay: true },
        tracks: [
          {
            synth: { kind: "tone", freq: 440 },
            reverb: 0.4,
            delay: 0.2,
            start: 0,
            duration: 1,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(convolvers).toHaveLength(0);
    expect(delays).toHaveLength(0);
    const warnings = messages.filter(
      (m) => m.type === "mobileAgentVideoAudioWarning",
    );
    expect(
      warnings.some((m) => String(m.reason).indexOf("continuing dry") >= 0),
    ).toBe(true);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("ducks music under explicit voice ranges with attack and release", async () => {
    const { messages, gains, oscillators } = installBrowserStubs({
      audio: "full",
    });
    setContract({
      duration: 4,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          {
            synth: { kind: "tone", freq: 220 },
            start: 0,
            duration: 4,
            volume: 0.5,
            duckUnder: [{ start: 1, end: 2 }],
            duckAmount: 0.25,
            duckAttack: 0.2,
            duckRelease: 0.3,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const t0 = 0;
    const ducks = gains.filter(
      (gn) =>
        gn.gain.setCalls.length === 3 &&
        gn.gain.setCalls[0][0] === 1 &&
        gn.gain.rampCalls.length === 2 &&
        gn.gain.rampCalls[0][0] === 0.25,
    );
    expect(ducks).toHaveLength(1);
    expect(ducks[0].gain.setCalls).toEqual([
      [1, t0],
      [1, (t0 + 1) - 0.2],
      [0.25, t0 + 2],
    ]);
    expect(ducks[0].gain.rampCalls).toEqual([
      [0.25, t0 + 1],
      [1, (t0 + 2) + 0.3],
    ]);
    // The cue itself still sounds through the duck.
    expect(oscillators).toHaveLength(1);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("clips duck ranges to the cue and merges overlaps", async () => {
    const { messages, gains } = installBrowserStubs({ audio: "full" });
    setContract({
      duration: 4,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          {
            synth: { kind: "tone", freq: 220 },
            start: 0,
            duration: 4,
            duckUnder: [
              { start: -5, end: 1 },
              { start: 0.8, end: 2 },
              { start: 10, end: 20 },
            ],
            duckAmount: 0.5,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const t0 = 0;
    const ducks = gains.filter(
      (gn) =>
        gn.gain.setCalls.length === 2 &&
        gn.gain.setCalls[0][0] === 1 &&
        gn.gain.rampCalls.length === 2 &&
        gn.gain.rampCalls[0][0] === 0.5,
    );
    expect(ducks).toHaveLength(1);
    expect(ducks[0].gain.setCalls).toEqual([
      [1, t0],
      [0.5, t0 + 2],
    ]);
    expect(ducks[0].gain.rampCalls).toEqual([
      [0.5, t0],
      [1, (t0 + 2) + 0.5],
    ]);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("adds no duck node without usable ranges", async () => {
    const { messages, gains } = installBrowserStubs({ audio: "full" });
    setContract({
      duration: 2,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          {
            synth: { kind: "tone", freq: 220 },
            start: 0,
            duration: 2,
          },
          {
            synth: { kind: "tone", freq: 330 },
            start: 0,
            duration: 2,
            duckUnder: [{ start: 2, end: 1 }, { start: "x", end: 1 }, null, "str", 5],
            duckAmount: 0.25,
          },
          {
            synth: { kind: "tone", freq: 440 },
            start: 0,
            duration: 2,
            duckUnder: [{ start: 0.5, end: 1 }],
            duckAmount: 1,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    // Master + 3 cue envelopes + 3 plucks; invalid ranges and amount 1
    // both skip the duck node.
    expect(gains).toHaveLength(7);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  function captureMixedSamples() {
    const w = (globalThis as Record<string, unknown>).window as Record<
      string,
      unknown
    >;
    const analysisObj = w.__mobileAgentAudioAnalysis as {
      analyzeAudio: (
        samples: Float32Array,
        rate: number,
        dur: number,
      ) => unknown;
    };
    let mixed: Float32Array | null = null;
    const orig = analysisObj.analyzeAudio.bind(analysisObj);
    analysisObj.analyzeAudio = (samples, rate, dur) => {
      mixed = samples;
      return orig(samples, rate, dur);
    };
    return () => mixed;
  }

  function meanOf(data: ArrayLike<number>) {
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) sum += data[i];
    return data.length > 0 ? sum / data.length : NaN;
  }

  it("renders synth stems into the reactive analysis", async () => {
    const { messages, offline } = installBrowserStubs({ audio: "full" });
    const seenAudio: { ready: boolean }[] = [];
    const mixedSamples = captureMixedSamples();
    setContract({
      duration: 2,
      fps: 5,
      render: (
        _t: number,
        _canvas: unknown,
        _ctx: unknown,
        audio: unknown,
      ) => {
        seenAudio.push(audio as { ready: boolean });
      },
      audio: {
        tracks: [
          {
            synth: {
              kind: "drums",
              stepDur: 0.5,
              steps: [["kick", "hat"], ["snare"]],
            },
            start: 0,
            duration: 2,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    // Stems scheduled offline: kick body + click, snare body, hat + rattle.
    expect(offline.oscillators).toHaveLength(3);
    expect(offline.sources).toHaveLength(2);
    // The fake stem renders a constant 0.5; the mix carries it straight
    // through (single clip, volume 1, master 1).
    const mixed = mixedSamples();
    expect(mixed).not.toBeNull();
    expect(meanOf(mixed ?? [])).toBeCloseTo(0.5, 4);
    expect(seenAudio.length).toBeGreaterThan(0);
    expect(seenAudio[0].ready).toBe(true);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("mixes file cues and synth cues in the same offline renderer", async () => {
    const { messages, offline } = installBrowserStubs({
      audio: "full",
      fetchImpl: (() =>
        Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        })) as unknown as typeof fetch,
    });
    setContract({
      duration: 1,
      fps: 5,
      render: () => {},
      audio: {
        tracks: [
          { file: "data:audio/mpeg;base64,QUJD", start: 0, volume: 0.5 },
          {
            synth: { kind: "drums", stepDur: 0.25, steps: [["kick"]] },
            start: 0,
            duration: 1,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    // Both file and synth audio must be present in the exported mix.
    expect(offline.oscillators).toHaveLength(2);
    expect(offline.sources).toHaveLength(1);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("fails if the offline renderer is missing instead of using live capture", async () => {
    const { messages } = installBrowserStubs({ audio: "full" });
    delete (globalThis as Record<string, unknown>).OfflineAudioContext;
    delete ((globalThis as Record<string, unknown>).window as Record<string, unknown>).OfflineAudioContext;
    const seenAudio: { ready: boolean }[] = [];
    setContract({
      duration: 1,
      fps: 5,
      render: (
        _t: number,
        _canvas: unknown,
        _ctx: unknown,
        audio: unknown,
      ) => {
        seenAudio.push(audio as { ready: boolean });
      },
      audio: {
        tracks: [
          { synth: { kind: "tone", freq: 440 }, start: 0, duration: 1 },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoError"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(seenAudio).toHaveLength(0);
    const types = messages.map((m) => m.type);
    expect(types).toContain("mobileAgentVideoError");
    expect(types).not.toContain("mobileAgentVideoDone");
  }, 15000);

  it("applies sends and ducking inside stem renders", async () => {
    const { messages, offline } = installBrowserStubs({ audio: "full" });
    setContract({
      duration: 2,
      fps: 5,
      render: () => {},
      audio: {
        fx: { reverb: { decay: 0.5 }, delay: true },
        tracks: [
          {
            synth: { kind: "tone", freq: 330 },
            start: 0,
            duration: 2,
            reverb: 0.3,
            duckUnder: [{ start: 0.5, end: 1 }],
            duckAmount: 0.5,
          },
        ],
      },
    });
    const w = runScript();
    (w.__startMobileAgentVideoExport as () => void)();

    await vi.waitFor(
      () => {
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    expect(offline.convolvers).toHaveLength(1);
    expect(offline.delays).toHaveLength(1);
    expect(
      offline.gains.filter((gn) => gn.gain.value === 0.3),
    ).toHaveLength(1);
    const ducks = offline.gains.filter(
      (gn) =>
        gn.gain.setCalls.length === 3 &&
        gn.gain.setCalls[0][0] === 1 &&
        gn.gain.rampCalls.length === 2 &&
        gn.gain.rampCalls[0][0] === 0.5,
    );
    expect(ducks).toHaveLength(1);
    // Stem time starts at 0: dip at 0.5 - 0.3, full duck at 0.5, out at 1.5.
    expect(ducks[0].gain.setCalls).toEqual([[1, 0], [1, 0.5 - 0.3], [0.5, 1]]);
    expect(ducks[0].gain.rampCalls).toEqual([
      [0.5, 0.5],
      [1, 1.5],
    ]);
    const types = messages.map((m) => m.type);
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);
});
