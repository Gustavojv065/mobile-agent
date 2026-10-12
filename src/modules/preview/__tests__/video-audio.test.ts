import { describe, expect, it } from "vitest";

import {
  MAX_AUDIO_FILE_BYTES,
  assertAudioFileUsable,
  buildAudioDataUri,
  extractWorkspaceAudioIds,
  resolveAudioMimeType,
} from "@/modules/preview/video-audio";

describe("extractWorkspaceAudioIds", () => {
  it("finds workspace file ids referenced by an audio schedule", () => {
    const html = `<script>window.MOBILE_AGENT_VIDEO = { audio: { tracks: [
      { file: "workspace://abc-123", start: 0 },
      { file: "workspace://xyz_456", start: 2 }
    ] } };</script>`;

    expect(extractWorkspaceAudioIds(html)).toEqual(["abc-123", "xyz_456"]);
  });

  it("dedupes repeated references and ignores other schemes", () => {
    const html = `["workspace://same", "workspace://same", "https://x/y.mp3", "file:///a.mp3"]`;

    expect(extractWorkspaceAudioIds(html)).toEqual(["same"]);
  });

  it("returns an empty list when nothing is referenced", () => {
    expect(extractWorkspaceAudioIds("<p>silent</p>")).toEqual([]);
  });
});

describe("resolveAudioMimeType", () => {
  it("prefers a supported declared mime type", () => {
    expect(resolveAudioMimeType("audio/mpeg", "song.wav")).toBe("audio/mpeg");
  });

  it("falls back to the file extension when the mime is missing or generic", () => {
    expect(resolveAudioMimeType(null, "song.mp3")).toBe("audio/mpeg");
    expect(resolveAudioMimeType("application/octet-stream", "bed.WAV")).toBe(
      "audio/wav",
    );
    expect(resolveAudioMimeType(undefined, "voice.m4a")).toBe("audio/mp4");
  });

  it("returns null for unsupported formats", () => {
    expect(resolveAudioMimeType("audio/flac", "song.flac")).toBe(null);
    expect(resolveAudioMimeType(null, "notes.txt")).toBe(null);
  });
});

describe("assertAudioFileUsable", () => {
  it("accepts a supported file under the size cap", () => {
    expect(assertAudioFileUsable("song.mp3", "audio/mpeg", 1024)).toBe(
      "audio/mpeg",
    );
  });

  it("rejects unsupported formats with a helpful message", () => {
    expect(() => assertAudioFileUsable("song.flac", "audio/flac", 100)).toThrow(
      /not a supported format/,
    );
  });

  it("rejects empty and oversized files", () => {
    expect(() => assertAudioFileUsable("empty.mp3", "audio/mpeg", 0)).toThrow(
      /empty/,
    );
    expect(() =>
      assertAudioFileUsable("huge.mp3", "audio/mpeg", MAX_AUDIO_FILE_BYTES + 1),
    ).toThrow(/too large/);
  });
});

describe("buildAudioDataUri", () => {
  it("encodes bytes as a data URI the WebView can fetch", () => {
    const uri = buildAudioDataUri(
      "audio/mpeg",
      Uint8Array.from([1, 2, 3, 250]),
    );

    expect(uri.startsWith("data:audio/mpeg;base64,")).toBe(true);
    expect(Buffer.from(uri.split(",")[1], "base64")).toEqual(
      Buffer.from([1, 2, 3, 250]),
    );
  });
});
