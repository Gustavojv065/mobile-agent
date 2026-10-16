import { afterEach, describe, expect, it, vi } from "vitest";

import { VIDEO_EXPORT_SCRIPT } from "@/modules/preview/video-recorder";
import { VIDEO_AUDIO_ANALYSIS_SCRIPT } from "@/modules/preview/video-audio-analysis";

type Posted = { type: string; [key: string]: unknown };

function installStubs(options: {
  withWebCodecs?: boolean;
  autoConsume?: boolean;
  withAudio?: boolean;
  video?: object;
} = {}) {
  const messages: Posted[] = [];
  const createVideoEncoder = vi.fn(() => { throw new Error("Native export must not construct a WebCodecs encoder."); });
  const g = globalThis as Record<string, unknown>;
  class FakeOfflineAudioContext {
    sampleRate = 48000;
    destination = {};
    constructor(_channels: number, private frames: number, _rate: number) {}
    createGain() {
      return {
        gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} },
        connect() {},
      };
    }
    createBufferSource() {
      return { connect() {}, start() {}, stop() {}, buffer: null, loop: false };
    }
    decodeAudioData() {
      return Promise.resolve({ duration: 1 });
    }
    startRendering() {
      return Promise.resolve({
        length: this.frames,
        numberOfChannels: 2,
        sampleRate: 48000,
        getChannelData: (channel: number) => new Float32Array(this.frames).fill(channel === 0 ? 0.25 : -0.25),
      });
    }
  }
  if (options.withAudio) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
  }

  const canvas = {
    width: 320,
    height: 240,
    offsetWidth: 320,
    parentNode: null,
    nextSibling: null,
    getAttribute: () => null,
    setAttribute: () => {},
    removeAttribute: () => {},
    getContext: () => ({}),
    toDataURL: () => "data:image/jpeg;base64,/9j/4AAQ==",
  };

  g.window = {
    MOBILE_AGENT_VIDEO: {
      duration: 1,
      fps: 5,
      width: 320,
      height: 240,
      render: () => {},
      ...(options.withAudio ? { audio: { tracks: [{ file: "data:audio/wav;base64,AAAA" }] } } : {}),
    },
    ReactNativeWebView: {
      postMessage: (data: string) => {
        const message = JSON.parse(data);
        messages.push(message);
        if (options.autoConsume !== false && message.requestId !== undefined) {
          (g.window as Record<string, (id: number) => void>).__mobileAgentExportConsumed(message.requestId);
        }
      },
    },
    ...(options.withWebCodecs !== false ? { VideoEncoder: createVideoEncoder, VideoFrame: class {} } : {}),
    OfflineAudioContext: FakeOfflineAudioContext,
  };
  g.document = {
    getElementById: () => null,
    querySelectorAll: (selector: string) => selector === "video" ? (options.video ? [options.video] : []) : [canvas],
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }),
    body: { appendChild: () => {} },
  };
  if (options.withWebCodecs !== false) {
    g.VideoEncoder = createVideoEncoder;
    g.VideoFrame = class {};
  }

  new Function(VIDEO_AUDIO_ANALYSIS_SCRIPT)();
  new Function(VIDEO_EXPORT_SCRIPT)();

  const w = g.window as Record<string, () => void>;
  return {
    messages,
    createVideoEncoder,
    start: () => w.__startMobileAgentVideoExport(),
    consume: (id: number) => (g.window as Record<string, (id: number) => void>).__mobileAgentExportConsumed(id),
    cancel: () => w.__cancelMobileAgentVideoExport(),
  };
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.window;
  delete g.document;
  delete g.VideoEncoder;
  delete g.VideoFrame;
  vi.unstubAllGlobals();
});

describe("VIDEO_EXPORT_SCRIPT native encoding", () => {
  it("uses native frames even when WebCodecs is available", async () => {
    const { messages, createVideoEncoder, start } = installStubs();
    start();

    await vi.waitFor(
      () =>
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true),
      { timeout: 8000 },
    );

    expect(createVideoEncoder).not.toHaveBeenCalled();
    expect(messages.filter((m) => m.type === "mobileAgentVideoFrame")).toHaveLength(5);
    expect(messages.some((m) => m.type === "mobileAgentVideoCsd")).toBe(false);
    const timings = messages.filter((m) => m.type === "mobileAgentVideoStageTimings");
    expect(timings.length).toBeGreaterThanOrEqual(1);
    expect(timings[timings.length - 1]).toMatchObject({ frames: 5, final: true });
  }, 15000);

  it("works when WebCodecs is unavailable", async () => {
    const { messages, createVideoEncoder, start } = installStubs({ withWebCodecs: false });
    start();

    await vi.waitFor(
      () =>
        expect(
          messages.some((m) => m.type === "mobileAgentVideoDone"),
        ).toBe(true),
      { timeout: 8000 },
    );

    expect(createVideoEncoder).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === "mobileAgentVideoEncodedChunk")).toBe(false);
  }, 15000);

  it("never produces a second frame before native acknowledges the first", async () => {
    const { messages, start, consume, cancel } = installStubs({ autoConsume: false });
    start();
    await vi.waitFor(() => expect(messages.filter((m) => m.type === "mobileAgentVideoFrame")).toHaveLength(1));
    const first = messages.find((m) => m.type === "mobileAgentVideoFrame")!;
    consume(Number(first.requestId) + 100); // Stale/unrelated ACK cannot release it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages.filter((m) => m.type === "mobileAgentVideoFrame")).toHaveLength(1);
    consume(Number(first.requestId));
    await vi.waitFor(() => expect(messages.filter((m) => m.type === "mobileAgentVideoFrame")).toHaveLength(2));
    cancel();
  });

  it("exports the complete offline soundtrack with sample-derived timestamps", async () => {
    const { messages, start } = installStubs({ withAudio: true });
    start();
    await vi.waitFor(() => expect(messages.some((m) => m.type === "mobileAgentVideoDone")).toBe(true), { timeout: 8000 });
    expect(messages.find((m) => m.type === "mobileAgentVideoAudioConfig")).toMatchObject({ encoding: "pcm16", sampleRate: 48000, channels: 2 });
    const pcm = messages.filter((m) => m.type === "mobileAgentVideoAudioPcmChunk");
    expect(pcm.length).toBeGreaterThan(1);
    let bytesSent = 0;
    for (const chunk of pcm) {
      expect(chunk.pts).toBe(Math.round(bytesSent / 4 * 1_000_000 / 48000));
      const bytes = Buffer.from(String(chunk.base64), "base64");
      expect(bytes.readInt16LE(0)).toBe(8192);
      expect(bytes.readInt16LE(2)).toBe(-8192);
      bytesSent += bytes.length;
    }
    expect(bytesSent).toBe(48000 * 2 * 2);
    expect(messages.findIndex((m) => m.type === "mobileAgentVideoAudioPcmChunk")).toBeGreaterThan(
      messages.findLastIndex((m) => m.type === "mobileAgentVideoFrame"),
    );
  });

  it("waits for source-video seeks before posting frames", async () => {
    const events = new Map<string, () => void>();
    let time = 0.5;
    let finishSeek: (() => void) | undefined;
    const video = {
      duration: 1, readyState: 2, seeking: false, loop: false,
      pause() {},
      get currentTime() { return time; },
      set currentTime(value: number) {
        time = value;
        video.seeking = true;
        finishSeek = () => { video.seeking = false; events.get("seeked")?.(); };
      },
      addEventListener(name: string, listener: () => void) { events.set(name, listener); },
      removeEventListener(name: string) { events.delete(name); },
    };
    const { messages, start, cancel } = installStubs({ video });
    start();
    await vi.waitFor(() => expect(finishSeek).toBeDefined());
    expect(time).toBe(0);
    expect(messages.filter((m) => m.type === "mobileAgentVideoFrame")).toHaveLength(0);
    finishSeek!();
    await vi.waitFor(() => expect(messages.filter((m) => m.type === "mobileAgentVideoFrame")).toHaveLength(1));
    cancel();
    finishSeek?.(); // Release any second-frame seek started before cancellation.
  });
});
