import type { WebViewMessageEvent } from "react-native-webview";

import type { HtmlVideoExportNativeModule } from "html-video-export";

/**
 * Messages posted by the recorder script embedded in the preview document
 * (see video-recorder.ts). They arrive after the page's own download messages
 * through the same WebView `onMessage` channel.
 */
export type VideoExportConfigMessage = {
  type: "mobileAgentVideoConfig";
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  duration: number;
};

export type VideoExportMessage =
  | VideoExportConfigMessage
  | { type: "mobileAgentVideoCsd"; spsHex: string; ppsHex: string }
  | {
      type: "mobileAgentVideoEncodedChunk";
      index: number;
      frameCount: number;
      keyFrame: boolean;
      timestamp: number;
      base64: string;
    }
  | { type: "mobileAgentVideoFrame"; index: number; frameCount: number; base64: string }
  | { type: "mobileAgentVideoDone"; emitted?: number }
  | { type: "mobileAgentVideoUnsupported" }
  | { type: "mobileAgentVideoError"; message: string };

export function isVideoExportMessage(value: unknown): value is VideoExportMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("mobileAgentVideo");
}

export type VideoExportControllerOptions = {
  outputPath: string;
  module: HtmlVideoExportNativeModule;
  onProgress: (progress: number) => void;
  onFinishing: () => void;
  onResult: (result: { uri: string; sizeBytes: number }) => void | Promise<void>;
  onError: (message: string, kind?: "unsupported") => void;
};

type VideoExportSession = "idle" | "recording" | "finishing" | "done" | "failed";

/**
 * Drives the native video export from WebView messages.
 *
 * Messages are processed through a promise chain so ordering is preserved even
 * when the native calls overlap the WebView's postMessage stream. The chain
 * also acts as backpressure for the JPEG fallback: when it falls too far
 * behind real time, frames are dropped rather than buffered forever.
 */
export class VideoExportController {
  private chain: Promise<void> = Promise.resolve();
  private session: VideoExportSession = "idle";
  private config: VideoExportConfigMessage | null = null;
  private lastProgress = 0;
  private queued = 0;

  private readonly module: HtmlVideoExportNativeModule;
  private readonly outputPath: string;
  private readonly onProgress: (progress: number) => void;
  private readonly onFinishing: () => void;
  private readonly onResult: VideoExportControllerOptions["onResult"];
  private readonly onError: VideoExportControllerOptions["onError"];

  constructor(options: VideoExportControllerOptions) {
    this.module = options.module;
    this.outputPath = options.outputPath;
    this.onProgress = options.onProgress;
    this.onFinishing = options.onFinishing;
    this.onResult = options.onResult;
    this.onError = options.onError;
  }

  handleMessage(event: WebViewMessageEvent): void {
    let data: unknown;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!isVideoExportMessage(data)) return;
    this.enqueue(data);
  }

  /** Stops the in-flight export (also called when the preview is dismissed). */
  cancel(): Promise<void> {
    this.session = "failed";
    return this.chain.then(async () => {
      try {
        await this.module.cancel();
      } catch {
        // The native export may already have been torn down.
      }
    });
  }

  /** Resolves once every queued message has been processed. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  private enqueue(message: VideoExportMessage): void {
    this.queued += 1;
    this.chain = this.chain
      .then(() => this.process(message))
      .catch((error) => {
        this.fail(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.queued -= 1;
      });
  }

  private async process(message: VideoExportMessage): Promise<void> {
    switch (message.type) {
      case "mobileAgentVideoConfig": {
        this.config = message;
        return;
      }
      case "mobileAgentVideoCsd": {
        const config = this.config;
        if (!config) throw new Error("Video export config was not received.");
        if (this.session === "recording") return;
        await this.module.beginH264(
          this.outputPath,
          config.width,
          config.height,
          config.fps,
          config.frameCount,
          message.spsHex,
          message.ppsHex,
        );
        this.session = "recording";
        return;
      }
      case "mobileAgentVideoEncodedChunk": {
        if (this.session === "failed" || this.session === "done") return;
        if (this.session !== "recording") {
          throw new Error("Encoded video arrived before the export started.");
        }
        await this.module.pushH264Chunk(
          message.keyFrame,
          Math.round(message.timestamp),
          message.base64,
        );
        this.reportProgress(message.index, message.frameCount);
        return;
      }
      case "mobileAgentVideoFrame": {
        if (this.session === "failed" || this.session === "done") return;
        const config = this.config;
        if (!config) throw new Error("Video export config was not received.");
        if (this.session !== "recording") {
          await this.module.beginFrames(
            this.outputPath,
            config.width,
            config.height,
            config.fps,
            config.frameCount,
          );
          this.session = "recording";
        }
        if (this.queued > 24) {
          // The native encoder cannot keep up; drop rather than buffer forever.
          this.reportProgress(message.index, message.frameCount);
          return;
        }
        await this.module.pushJpegFrame(message.index, message.base64);
        this.reportProgress(message.index, message.frameCount);
        return;
      }
      case "mobileAgentVideoDone": {
        if (this.session === "done" || this.session === "failed") return;
        this.session = "finishing";
        this.onFinishing();
        const result = await this.module.finish();
        this.session = "done";
        await this.onResult(result);
        return;
      }
      case "mobileAgentVideoUnsupported": {
        this.fail(
          "This HTML cannot be exported as a video: it needs a canvas and a window.MOBILE_AGENT_VIDEO contract. Ask the agent to make a recordable video.",
          "unsupported",
        );
        return;
      }
      case "mobileAgentVideoError": {
        this.fail(message.message || "Video export failed.");
        return;
      }
    }
  }

  private reportProgress(index: number, frameCount: number): void {
    const progress = frameCount > 0 ? Math.min(1, index / frameCount) : 0;
    if (progress - this.lastProgress >= 0.01 || progress >= 1) {
      this.lastProgress = progress;
      this.onProgress(progress);
    }
  }

  private fail(message: string, kind?: "unsupported"): void {
    if (this.session === "failed" || this.session === "done") return;
    this.session = "failed";
    void this.module.cancel().catch(() => {});
    if (kind === undefined) this.onError(message);
    else this.onError(message, kind);
  }
}