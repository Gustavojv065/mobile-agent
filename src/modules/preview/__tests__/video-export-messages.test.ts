import { describe, expect, it, vi } from "vitest";
import type { WebViewMessageEvent } from "react-native-webview";

import {
  isVideoExportMessage,
  summarizeExportTimings,
  VideoExportController,
} from "@/modules/preview/video-export-messages";
import type { HtmlVideoExportNativeModule } from "html-video-export";

function post(controller: VideoExportController, data: unknown): void {
  controller.handleMessage({
    nativeEvent: { data: JSON.stringify(data) },
  } as WebViewMessageEvent);
}

function fakeModule() {
  return {
    beginH264: vi.fn(async () => ({ ok: true })),
    pushH264Chunk: vi.fn(async () => {}),
    beginFrames: vi.fn(async () => ({ ok: true })),
    pushJpegFrame: vi.fn(async () => {}),
    setAudioFormat: vi.fn(async () => {}),
    setAudioPcmFormat: vi.fn(async () => {}),
    pushAudioChunk: vi.fn(async () => {}),
    pushPcmChunk: vi.fn(async () => {}),
    finish: vi.fn(async () => ({ uri: "file:///cache/video.mp4", sizeBytes: 1234, hasAudio: false, audioDurationUs: 0 })),
    cancel: vi.fn(async () => {}),
  } as unknown as HtmlVideoExportNativeModule;
}

describe("summarizeExportTimings", () => {
  const fast = {
    frames: 300,
    prepareAvgMs: 10,
    prepareMaxMs: 20,
    captureAvgMs: 8,
    captureMaxMs: 15,
    bridgeAvgMs: 8,
    bridgeMaxMs: 14,
  };

  it("stays silent when the per-frame work fits the frame budget", () => {
    expect(summarizeExportTimings(fast, 30)).toEqual([]);
  });

  it("ignores tiny probes and no-timing payloads", () => {
    expect(summarizeExportTimings({ ...fast, frames: 5 }, 30)).toEqual([]);
  });

  it("names the slow stages when the page overruns the budget", () => {
    const notes = summarizeExportTimings(
      { ...fast, prepareAvgMs: 40, captureAvgMs: 30 },
      30,
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("scene seek/render averaged 40 ms/frame");
    expect(notes[1]).toContain("canvas JPEG capture averaged 30 ms/frame");
  });

  it("falls back to a total-cost note when no single stage dominates", () => {
    const notes = summarizeExportTimings(
      { ...fast, prepareAvgMs: 15, captureAvgMs: 15, bridgeAvgMs: 15 },
      30,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("per-frame work averaged 45 ms");
  });
});

describe("isVideoExportMessage", () => {  it("accepts only mobileAgentVideo* payloads", () => {
    expect(isVideoExportMessage({ type: "mobileAgentVideoConfig", width: 10 })).toBe(true);
    expect(isVideoExportMessage({ type: "mobileAgentVideoDone" })).toBe(true);
    expect(isVideoExportMessage({ type: "mobileAgentVideoAudioConfig" })).toBe(true);
    expect(isVideoExportMessage({ type: "mobileAgentVideoAudioChunk" })).toBe(true);
    expect(isVideoExportMessage({ type: "mobileAgentVideoAudioWarning" })).toBe(true);
    expect(isVideoExportMessage({ type: "mobileAgentDownload", filename: "a" })).toBe(false);
    expect(isVideoExportMessage(42)).toBe(false);
    expect(isVideoExportMessage(null)).toBe(false);
  });
});

describe("VideoExportController — H.264 (GPU) path", () => {
  it("starts the muxer on csd, pushes chunks, then finishes and reports the result", async () => {
    const module = fakeModule();
    const onProgress = vi.fn();
    const onFinishing = vi.fn();
    const onResult = vi.fn();
    const onError = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress,
      onFinishing,
      onResult,
      onError,
    });

    post(controller, { type: "mobileAgentVideoConfig", width: 1280, height: 720, fps: 30, frameCount: 300, duration: 10 });
    post(controller, { type: "mobileAgentVideoCsd", spsHex: "6742001f96", ppsHex: "68ce3c80" });
    post(controller, { type: "mobileAgentVideoEncodedChunk", index: 0, frameCount: 100, keyFrame: true, timestamp: 0, base64: "AAAAAf8=" });
    post(controller, { type: "mobileAgentVideoEncodedChunk", index: 5, frameCount: 100, keyFrame: false, timestamp: 166666, base64: "AAAAAe8=" });
    post(controller, { type: "mobileAgentVideoDone", emitted: 2 });

    await controller.whenIdle();

    expect(module.beginH264).toHaveBeenCalledTimes(1);
    expect(module.beginH264).toHaveBeenCalledWith(
      "file:///cache/video.mp4",
      1280,
      720,
      30,
      300,
      "6742001f96",
      "68ce3c80",
    );
    expect(module.pushH264Chunk).toHaveBeenCalledTimes(2);
    expect(module.pushH264Chunk).toHaveBeenNthCalledWith(1, true, 0, "AAAAAf8=");
    expect(module.pushH264Chunk).toHaveBeenNthCalledWith(2, false, 166666, "AAAAAe8=");
    expect(module.finish).toHaveBeenCalledTimes(1);
    expect(onFinishing).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ uri: "file:///cache/video.mp4", sizeBytes: 1234, hasAudio: false, audioDurationUs: 0, audioWarnings: [], timings: undefined, perfWarnings: [], visualWarnings: [] });
    expect(onError).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalled();
  });
});

describe("VideoExportController — JPEG fallback path", () => {
  it("lazily starts the frame encoder and pushes decoded frames", async () => {
    const module = fakeModule();
    const onError = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult: vi.fn(),
      onError,
    });

    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 24, frameCount: 240, duration: 10 });
    post(controller, { type: "mobileAgentVideoFrame", index: 0, frameCount: 240, base64: "/9j/4AAQ==" });
    post(controller, { type: "mobileAgentVideoFrame", index: 1, frameCount: 240, base64: "/9j/4AAQ==" });
    post(controller, { type: "mobileAgentVideoDone", emitted: 2 });

    await controller.whenIdle();

    expect(module.beginFrames).toHaveBeenCalledTimes(1);
    expect(module.beginFrames).toHaveBeenCalledWith("file:///cache/video.mp4", 640, 360, 24, 240, null);
    expect(module.pushJpegFrame).toHaveBeenCalledTimes(2);
    expect(module.pushJpegFrame).toHaveBeenNthCalledWith(1, 0, "/9j/4AAQ==");
    expect(module.finish).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("forwards the run's pinned encoder into beginFrames", async () => {
    const module = fakeModule();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      pinnedEncoder: "c2.android.avc.encoder",
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult: vi.fn(),
      onError: vi.fn(),
    });

    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 24, frameCount: 1, duration: 1 });
    post(controller, { type: "mobileAgentVideoFrame", index: 0, frameCount: 1, base64: "/9j/4AAQ==" });
    await controller.whenIdle();

    // Segment resume: the codec recorded by finished segments must survive
    // into this segment's encoder so every segment shares one SPS/PPS.
    expect(module.beginFrames).toHaveBeenCalledWith(
      "file:///cache/video.mp4",
      640,
      360,
      24,
      1,
      "c2.android.avc.encoder",
    );
  });

  it("acknowledges a frame only after native consumes it", async () => {
    const module = fakeModule();
    let consume!: () => void;
    vi.mocked(module.pushJpegFrame).mockImplementation(() => new Promise<void>((resolve) => { consume = resolve; }));
    const onConsumed = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4", module,
      onProgress: vi.fn(), onFinishing: vi.fn(), onResult: vi.fn(), onError: vi.fn(), onConsumed,
    });
    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 24, frameCount: 1, duration: 1 });
    post(controller, { type: "mobileAgentVideoFrame", index: 0, frameCount: 1, base64: "/9j/4AAQ==", requestId: 7 });
    await vi.waitFor(() => expect(module.pushJpegFrame).toHaveBeenCalledOnce());
    expect(onConsumed).not.toHaveBeenCalled();
    consume();
    await controller.whenIdle();
    expect(onConsumed).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("does not drop frames when the controller queue exceeds the old limit", async () => {
    const module = fakeModule();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4", module,
      onProgress: vi.fn(), onFinishing: vi.fn(), onResult: vi.fn(), onError: vi.fn(),
    });
    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 24, frameCount: 40, duration: 2 });
    for (let index = 0; index < 40; index += 1) {
      post(controller, { type: "mobileAgentVideoFrame", index, frameCount: 40, base64: "/9j/4AAQ==" });
    }
    await controller.whenIdle();
    expect(module.pushJpegFrame).toHaveBeenCalledTimes(40);
  });
});

describe("VideoExportController — audio track", () => {
  function audioController(module: ReturnType<typeof fakeModule>, onResult = vi.fn()) {
    return new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult,
      onError: vi.fn(),
    });
  }

  it("starts PCM encoding before chunks arrive, including before video CSD", async () => {
    const module = fakeModule();
    const controller = audioController(module);
    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 30, frameCount: 30, duration: 1 });
    post(controller, { type: "mobileAgentVideoAudioConfig", sampleRate: 48000, channels: 2, encoding: "pcm16" });
    post(controller, { type: "mobileAgentVideoAudioPcmChunk", pts: 0, base64: "AAAAAA==" });
    post(controller, { type: "mobileAgentVideoCsd", spsHex: "6742001f96", ppsHex: "68ce3c80" });
    post(controller, { type: "mobileAgentVideoDone" });
    await controller.whenIdle();

    expect(module.setAudioPcmFormat).toHaveBeenCalledExactlyOnceWith(48000, 2);
    expect(module.pushPcmChunk).toHaveBeenCalledExactlyOnceWith(0, "AAAAAA==");
    expect(module.setAudioFormat).not.toHaveBeenCalled();
    expect(module.pushAudioChunk).not.toHaveBeenCalled();
    expect(vi.mocked(module.setAudioPcmFormat).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(module.pushPcmChunk).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(module.pushPcmChunk).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(module.beginH264).mock.invocationCallOrder[0],
    );
  });

  it("configures audio before begin and pushes chunks in order", async () => {
    const module = fakeModule();
    (module.finish as ReturnType<typeof vi.fn>).mockResolvedValue({
      uri: "file:///cache/video.mp4",
      sizeBytes: 999,
      hasAudio: true,
      audioDurationUs: 9_500_000,
    });
    const onResult = vi.fn();
    const controller = audioController(module, onResult);

    post(controller, { type: "mobileAgentVideoConfig", width: 1280, height: 720, fps: 30, frameCount: 300, duration: 10 });
    post(controller, { type: "mobileAgentVideoAudioConfig", sampleRate: 48000, channels: 2 });
    post(controller, { type: "mobileAgentVideoCsd", spsHex: "6742001f96", ppsHex: "68ce3c80" });
    post(controller, { type: "mobileAgentVideoAudioChunk", pts: 0, base64: "QUJD" });
    post(controller, { type: "mobileAgentVideoAudioChunk", pts: 21333, base64: "REVG" });
    post(controller, { type: "mobileAgentVideoEncodedChunk", index: 0, frameCount: 300, keyFrame: true, timestamp: 0, base64: "AAAAAf8=" });
    post(controller, { type: "mobileAgentVideoDone", emitted: 1 });

    await controller.whenIdle();

    expect(module.setAudioFormat).toHaveBeenCalledTimes(1);
    expect(module.setAudioFormat).toHaveBeenCalledWith(48000, 2);
    expect(module.pushAudioChunk).toHaveBeenCalledTimes(2);
    expect(module.pushAudioChunk).toHaveBeenNthCalledWith(1, 0, "QUJD");
    expect(module.pushAudioChunk).toHaveBeenNthCalledWith(2, 21333, "REVG");
    expect(onResult).toHaveBeenCalledWith({
      uri: "file:///cache/video.mp4",
      sizeBytes: 999,
      hasAudio: true,
      audioDurationUs: 9_500_000,
      audioWarnings: [],
      timings: undefined,
      perfWarnings: [],
      visualWarnings: [],
    });
  });

  it("warns when the captured soundtrack stops early", async () => {
    const module = fakeModule();
    (module.finish as ReturnType<typeof vi.fn>).mockResolvedValue({
      uri: "file:///cache/video.mp4",
      sizeBytes: 999,
      hasAudio: true,
      audioDurationUs: 6_000_000,
    });
    const onResult = vi.fn();
    const controller = audioController(module, onResult);

    post(controller, { type: "mobileAgentVideoConfig", width: 1280, height: 720, fps: 30, frameCount: 300, duration: 10 });
    post(controller, { type: "mobileAgentVideoAudioConfig", sampleRate: 48000, channels: 2 });
    post(controller, { type: "mobileAgentVideoCsd", spsHex: "6742001f96", ppsHex: "68ce3c80" });
    post(controller, { type: "mobileAgentVideoEncodedChunk", index: 0, frameCount: 300, keyFrame: true, timestamp: 0, base64: "AAAAAf8=" });
    post(controller, { type: "mobileAgentVideoDone", emitted: 1 });

    await controller.whenIdle();

    expect(onResult).toHaveBeenCalledWith({
      uri: "file:///cache/video.mp4",
      sizeBytes: 999,
      hasAudio: true,
      audioDurationUs: 6_000_000,
      audioWarnings: [expect.stringContaining("Only 6.0s of audio was captured")],
      timings: undefined,
      perfWarnings: [],
      visualWarnings: [],
    });
  });

  it("collects audio warnings without failing the render", async () => {
    const module = fakeModule();
    const onResult = vi.fn();
    const onError = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult,
      onError,
    });

    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 24, frameCount: 240, duration: 10 });
    post(controller, { type: "mobileAgentVideoAudioUnsupported", reason: "no encoder" });
    post(controller, { type: "mobileAgentVideoAudioWarning", reason: "cue skipped" });
    post(controller, { type: "mobileAgentVideoFrame", index: 0, frameCount: 240, base64: "/9j/4AAQ==" });
    post(controller, { type: "mobileAgentVideoDone", emitted: 1 });

    await controller.whenIdle();

    expect(onError).not.toHaveBeenCalled();
    expect(module.setAudioFormat).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith({
      uri: "file:///cache/video.mp4",
      sizeBytes: 1234,
      hasAudio: false,
      audioDurationUs: 0,
      audioWarnings: ["no encoder", "cue skipped"],
      timings: undefined,
      perfWarnings: [],
      visualWarnings: [],
    });
  });

  it("surfaces the page's clip diagnostics as visual warnings", async () => {
    const module = fakeModule();
    const onResult = vi.fn();
    const onError = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult,
      onError,
    });

    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 24, frameCount: 240, duration: 10 });
    post(controller, {
      type: "mobileAgentVideoDone",
      emitted: 1,
      visualWarnings: [
        'Clip "clip-a.mp4" ran past its source length (3s) at t=8s: holding its last decoded frame.',
        42,
        { not: "a string" },
      ],
    });

    await controller.whenIdle();

    expect(onError).not.toHaveBeenCalled();
    // Non-string entries are dropped: the warnings travel into tool output
    // and the AI-readable render result, so they must stay plain text.
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        visualWarnings: [
          'Clip "clip-a.mp4" ran past its source length (3s) at t=8s: holding its last decoded frame.',
        ],
      }),
    );
  });

  it("fails clearly when audio arrives before its configuration", async () => {
    const module = fakeModule();
    const onError = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult: vi.fn(),
      onError,
    });

    post(controller, { type: "mobileAgentVideoAudioChunk", pts: 0, base64: "QUJD" });

    await controller.whenIdle();

    expect(onError).toHaveBeenCalledWith("Audio arrived before its configuration.");
    expect(module.finish).not.toHaveBeenCalled();
  });
});

describe("VideoExportController — config tracking", () => {
  it("fires onConfig and reports hasConfig/isRecording through the session", async () => {
    const module = fakeModule();
    const onConfig = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult: vi.fn(),
      onError: vi.fn(),
      onConfig,
    });

    expect(controller.hasConfig()).toBe(false);
    expect(controller.isRecording()).toBe(false);

    post(controller, { type: "mobileAgentVideoConfig", width: 1280, height: 720, fps: 30, frameCount: 300, duration: 10 });
    await controller.whenIdle();

    expect(controller.hasConfig()).toBe(true);
    expect(controller.isRecording()).toBe(false);
    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(onConfig).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mobileAgentVideoConfig", width: 1280 }),
    );

    post(controller, { type: "mobileAgentVideoCsd", spsHex: "6742001f96", ppsHex: "68ce3c80" });
    await controller.whenIdle();

    expect(controller.isRecording()).toBe(true);
  });

  it("works without onConfig (host paths that do not need start tracking)", async () => {
    const module = fakeModule();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult: vi.fn(),
      onError: vi.fn(),
    });

    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 24, frameCount: 240, duration: 10 });
    await controller.whenIdle();

    expect(controller.hasConfig()).toBe(true);
  });
});

describe("VideoExportController — failures", () => {
  it("reports unsupported pages without starting a session", async () => {
    const module = fakeModule();
    const onError = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult: vi.fn(),
      onError,
    });

    post(controller, { type: "mobileAgentVideoUnsupported" });
    await controller.whenIdle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("MOBILE_AGENT_VIDEO"), "unsupported");
    expect(module.beginFrames).not.toHaveBeenCalled();
    expect(module.finish).not.toHaveBeenCalled();
  });

  it("forwards encoder errors from the page", async () => {
    const module = fakeModule();
    const onError = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult: vi.fn(),
      onError,
    });

    post(controller, { type: "mobileAgentVideoError", message: "boom" });
    await controller.whenIdle();

    expect(onError).toHaveBeenCalledWith("boom");
    expect(module.cancel).toHaveBeenCalled();
  });

  it("passes the page's timing summary through and flags slow stages", async () => {
    const module = fakeModule();
    const onResult = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult,
      onError: vi.fn(),
    });

    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 30, frameCount: 300, duration: 10 });
    post(controller, {
      type: "mobileAgentVideoDone",
      emitted: 2,
      timings: {
        frames: 300,
        prepareAvgMs: 12,
        prepareMaxMs: 20,
        captureAvgMs: 45,
        captureMaxMs: 60,
        bridgeAvgMs: 8,
        bridgeMaxMs: 10,
      },
    });

    await controller.whenIdle();

    expect(onResult).toHaveBeenCalledWith({
      uri: "file:///cache/video.mp4",
      sizeBytes: 1234,
      hasAudio: false,
      audioDurationUs: 0,
      audioWarnings: [],
      timings: expect.objectContaining({ captureAvgMs: 45 }),
      perfWarnings: [expect.stringContaining("canvas JPEG capture averaged 45 ms/frame")],
      visualWarnings: [],
    });
  });

  it("aborts the pending export on cancel without finishing", async () => {
    const module = fakeModule();
    const onResult = vi.fn();
    const controller = new VideoExportController({
      outputPath: "file:///cache/video.mp4",
      module,
      onProgress: vi.fn(),
      onFinishing: vi.fn(),
      onResult,
      onError: vi.fn(),
    });

    post(controller, { type: "mobileAgentVideoConfig", width: 640, height: 360, fps: 24, frameCount: 240, duration: 10 });
    post(controller, { type: "mobileAgentVideoFrame", index: 0, frameCount: 240, base64: "YQ==" });
    const canceled = controller.cancel();
    post(controller, { type: "mobileAgentVideoFrame", index: 1, frameCount: 240, base64: "Yg==" });
    post(controller, { type: "mobileAgentVideoDone", emitted: 2 });

    await canceled;
    await controller.whenIdle();

    expect(module.cancel).toHaveBeenCalled();
    expect(module.finish).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});
