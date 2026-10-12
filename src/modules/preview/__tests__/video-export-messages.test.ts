import { describe, expect, it, vi } from "vitest";
import type { WebViewMessageEvent } from "react-native-webview";

import {
  isVideoExportMessage,
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
    finish: vi.fn(async () => ({ uri: "file:///cache/video.mp4", sizeBytes: 1234, hasAudio: false })),
    cancel: vi.fn(async () => {}),
  } as unknown as HtmlVideoExportNativeModule;
}

describe("isVideoExportMessage", () => {
  it("accepts only mobileAgentVideo* payloads", () => {
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
    expect(onResult).toHaveBeenCalledWith({ uri: "file:///cache/video.mp4", sizeBytes: 1234, hasAudio: false, audioWarnings: [] });
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
    expect(module.beginFrames).toHaveBeenCalledWith("file:///cache/video.mp4", 640, 360, 24, 240);
    expect(module.pushJpegFrame).toHaveBeenCalledTimes(2);
    expect(module.pushJpegFrame).toHaveBeenNthCalledWith(1, 0, "/9j/4AAQ==");
    expect(module.finish).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
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
      audioWarnings: [],
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
      audioWarnings: ["no encoder", "cue skipped"],
    });
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
