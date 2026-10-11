import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export type HtmlVideoExportNativeModule = {
  /**
   * Starts an MP4 whose H.264 elementary stream is produced by the WebView's
   * hardware encoder (WebCodecs). The native side only muxes the compressed
   * chunks, so this path costs almost no CPU/GPU on the device.
   */
  beginH264(
    outputPath: string,
    width: number,
    height: number,
    fps: number,
    frameCount: number,
    spsHex: string,
    ppsHex: string,
  ): Promise<{ ok: boolean }>;
  pushH264Chunk(
    keyFrame: boolean,
    timestampMicros: number,
    base64: string,
  ): Promise<void>;
  /** Fallback for WebViews without WebCodecs: JPEG frames re-encoded on the hardware encoder. */
  beginFrames(
    outputPath: string,
    width: number,
    height: number,
    fps: number,
    frameCount: number,
  ): Promise<{ ok: boolean }>;
  pushJpegFrame(index: number, base64: string): Promise<void>;
  finish(): Promise<{ uri: string; sizeBytes: number }>;
  cancel(): Promise<void>;
};

const HtmlVideoExport =
  Platform.OS === "android"
    ? requireOptionalNativeModule<HtmlVideoExportNativeModule>(
        "HtmlVideoExport",
      )
    : null;

export function getHtmlVideoExportModule(): HtmlVideoExportNativeModule | null {
  return HtmlVideoExport;
}