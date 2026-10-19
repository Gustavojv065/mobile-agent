import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export type HtmlVideoExportNativeModule = {
  /**
   * @deprecated Retained only so stale documents receive a safe rejection.
   * Reload the scene and use beginFrames/pushJpegFrame instead.
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
  /**
   * Declares the AAC audio track before `beginH264`/`beginFrames` starts the
   * muxer. Must be called first: MediaMuxer needs every track up front.
   * Chunks pushed before the session begins are buffered natively.
   */
  setAudioFormat(sampleRate: number, channels: number): Promise<void>;
  /**
   * Declares a raw PCM audio track (signed 16-bit little-endian interleaved
   * samples) from the offline Web Audio mix. The native module
   * encodes the PCM with MediaCodec and muxes it as AAC. Must be called before
   * `beginFrames`, like `setAudioFormat`.
   */
  setAudioPcmFormat(sampleRate: number, channels: number): Promise<void>;
  /** Raw AAC access units (no ADTS headers) with microsecond timestamps. */
  pushAudioChunk(timestampMicros: number, base64: string): Promise<void>;
  /** Raw signed 16-bit little-endian interleaved PCM with microsecond timestamps. */
  pushPcmChunk(timestampMicros: number, base64: string): Promise<void>;
  /** Starts native AVC encoding of sequential JPEG frames. */
  beginFrames(
    outputPath: string,
    width: number,
    height: number,
    fps: number,
    frameCount: number,
  ): Promise<{ ok: boolean }>;
  pushJpegFrame(index: number, base64: string): Promise<void>;
  /**
   * Shrinks an over-cap scene clip (decode → Surface → AVC re-encode, audio
   * dropped: clips play muted) so it fits the inline budget. `maxBytes` is
   * the acceptance ceiling, `maxDimension` the first rung of the
   * 1280→854→640 downscale ladder. Paths are plain filesystem paths
   * (no file:// scheme). Throws when nothing fits or the clip is undecodable.
   */
  transcodeClip(
    inputPath: string,
    outputPath: string,
    maxBytes: number,
    maxDimension: number,
  ): Promise<{ path: string; width: number; height: number; sizeBytes: number }>;
  /**
   * Serves workspace + cache files over loopback HTTP so scene pages load
   * clips without base64 inflation (same origin: canvas stays clean, range
   * requests work). Plain directory paths in, `{ port }` out. Reference
   * counted: every start needs a matching stop call.
   */
  startAssetServer(
    workspaceDir: string,
    cacheDir: string,
  ): Promise<{ port: number }>;
  /** Releases one asset-server consumer; stops it when none remain. */
  stopAssetServer(): Promise<void>;
  /**
   * Concatenates same-encoding MP4 segments by sample-copy remux (no
   * re-encode): timestamps offset per segment, audio + video carried over.
   * Plain filesystem paths. Throws on missing segments, track mismatch,
   * or empty output — never writes a partial file silently.
   */
  concatSegments(inputs: string[], outputPath: string): Promise<{ ok: boolean }>;
  /**
   * Decodes at most `maxSeconds` seconds of a file's audio track into raw
   * interleaved PCM on a cache file (native rate/channels, 16-bit LE).
   * Plain filesystem paths. Sample handling stays in JS — this only feeds
   * the decoder. Throws on missing audio tracks, unsupported decoder output,
   * and decode failures; partial output is deleted, never returned.
   */
  decodeAudioPcm(
    inputPath: string,
    outputPath: string,
    maxSeconds: number,
  ): Promise<{
    pcmPath: string;
    bytes: number;
    sampleRate: number;
    channels: number;
    durationSeconds: number;
  }>;
  /**
   * Reads up to `byteCount` bytes at `byteOffset` from a decoder-produced PCM
   * file, base64-encoded. Empty on EOF; short reads are normal for the last
   * window.
   */
  readPcmSegment(
    pcmPath: string,
    byteOffset: number,
    byteCount: number,
  ): Promise<{ base64: string; bytes: number }>;
  finish(): Promise<{
    uri: string;
    sizeBytes: number;
    hasAudio: boolean;
    /** Last muxed audio timestamp in microseconds (0 when silent). */
    audioDurationUs: number;
    /** Codec that encoded this segment (empty for older native builds). */
    encoder?: string;
  }>;
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
