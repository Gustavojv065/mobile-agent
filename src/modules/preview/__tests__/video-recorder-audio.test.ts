import { afterEach, describe, expect, it, vi } from "vitest";

import { VIDEO_EXPORT_SCRIPT } from "@/modules/preview/video-recorder";
import { VIDEO_AUDIO_ANALYSIS_SCRIPT } from "@/modules/preview/video-audio-analysis";

type Posted = { type: string; [key: string]: unknown };

function installBrowserStubs(options: {
  audio?: "full" | "missing" | "pcm" | "pcm-legacy" | "aac-unsupported";
  fetchImpl?: typeof fetch;
} = {}) {
  const messages: Posted[] = [];
  const oscillators: { frequency: { value: number } }[] = [];
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
        messages.push(JSON.parse(data));
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
    const gainNode = () => ({
      gain: {
        value: 1,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
      },
      connect: () => {},
    });
    class FakeAudioContext {
      sampleRate = 48000;
      currentTime = 0;
      state = "running";
      __mobileAgentNoise: unknown = null;
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
        const oscillator = {
          type: "sine",
          frequency: { value: 440 },
          connect: () => {},
          start: () => {},
          stop: () => {},
        };
        oscillators.push(oscillator);
        return oscillator;
      }
      createBufferSource() {
        return {
          buffer: null,
          loop: false,
          connect: () => {},
          start: () => {},
          stop: () => {},
        };
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
      createBuffer(_channels: number, length: number, _rate: number) {
        return { getChannelData: () => new Float32Array(length) };
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
    (g.window as Record<string, unknown>).AudioContext = FakeAudioContext;
    if (options.audio !== "pcm" && options.audio !== "pcm-legacy") {
      (g.window as Record<string, unknown>).AudioEncoder = FakeAudioEncoder;
    }
    (g.window as Record<string, unknown>).MediaStreamTrackProcessor =
      FakeTrackProcessor;
    // The recorder string uses bare globals (window IS the global scope in a
    // WebView); mirror them onto globalThis for the Node harness.
    g.AudioContext = FakeAudioContext;
    if (options.audio !== "pcm" && options.audio !== "pcm-legacy") g.AudioEncoder = FakeAudioEncoder;
    g.MediaStreamTrackProcessor = FakeTrackProcessor;
  }

  if (options.fetchImpl) {
    g.fetch = options.fetchImpl;
  }

  // Production injects the analysis script into the same document before the
  // recorder; mirror that here so the audio-reactive path is exercised.
  new Function(VIDEO_AUDIO_ANALYSIS_SCRIPT)();

  return { messages, canvas, oscillators };
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
    const negative = audio === "pcm-legacy" ? -16383 : -16384;
    expect([0, 2, 4, 6].map((offset) => bytes.readInt16LE(offset))).toEqual([16384, 16384, negative, negative]);
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

  it("degrades to a silent video with a warning when audio APIs are missing", async () => {
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
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const types = messages.map((m) => m.type);
    expect(types).toContain("mobileAgentVideoAudioUnsupported");
    expect(types).not.toContain("mobileAgentVideoError");
  }, 15000);

  it("skips undecodable file cues with a warning and keeps recording", async () => {
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
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true);
      },
      { timeout: 8000 },
    );

    const types = messages.map((m) => m.type);
    expect(types).toContain("mobileAgentVideoAudioWarning");
    expect(types).toContain("mobileAgentVideoAudioConfig");
    expect(types).not.toContain("mobileAgentVideoError");
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
});
