import { describe, expect, it } from "vitest";

import {
  MAX_AUDIO_FILE_BYTES,
  assertAudioFileUsable,
  buildAudioDataUri,
  extractWorkspaceAudioIds,
  readContractAspect,
  readContractDuration,
  resolveAudioMimeType,
  replaceWorkspaceAudioRef,
} from "@/modules/preview/video-audio";

describe("extractWorkspaceAudioIds", () => {
  it("rewrites only exact audio-file keys, not the same video's DOM source or prefixed keys", () => {
    const html = `<video src="workspace://main"></video><script>var x={
      file: 'workspace://main', profile: 'workspace://main', sourceFile: 'workspace://main',
      other: { file: "workspace://main-long" }
    };</script>`;
    const out = replaceWorkspaceAudioRef(html, "main", "http://127.0.0.1/audio");
    expect(out).toContain("file: 'http://127.0.0.1/audio'");
    expect(out).toContain('<video src="workspace://main">');
    expect(out).toContain("profile: 'workspace://main'");
    expect(out).toContain("sourceFile: 'workspace://main'");
    expect(out).toContain('file: "workspace://main-long"');
  });
  it("finds workspace file ids referenced by an audio schedule", () => {
    const html = `<script>window.MOBILE_AGENT_VIDEO = { audio: { tracks: [
      { file: "workspace://abc-123", start: 0 },
      { file: "workspace://xyz_456", start: 2 }
    ] } };</script>`;

    expect(extractWorkspaceAudioIds(html)).toEqual(["abc-123", "xyz_456"]);
  });

  it("dedupes repeated references and ignores other schemes", () => {
    const html = `<script>var x = { file: "workspace://same", other: "workspace://same" };</script>`;

    expect(extractWorkspaceAudioIds(html)).toEqual(["same"]);
  });

  it("ignores workspace ids outside file tracks", () => {
    const html = `<img src="workspace://pic-1"><video src="workspace://clip-1"></video>
      <script>var scene = { profile: "workspace://abc", sourceFile: "workspace://def",
        audio: { tracks: [{ file: "workspace://song-1" }] } };</script>`;

    expect(extractWorkspaceAudioIds(html)).toEqual(["song-1"]);
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

  it("accepts video containers (only the audio track is decoded)", () => {
    expect(resolveAudioMimeType("video/mp4", "clip.mp4")).toBe("video/mp4");
    expect(resolveAudioMimeType("video/quicktime", "clip.mov")).toBe(
      "video/quicktime",
    );
    expect(resolveAudioMimeType("video/webm", "clip.webm")).toBe("video/webm");
    expect(resolveAudioMimeType(null, "clip.mp4")).toBe("video/mp4");
    expect(resolveAudioMimeType(null, "clip.mov")).toBe("video/quicktime");
    expect(resolveAudioMimeType(null, "clip.m4v")).toBe("video/mp4");
    expect(resolveAudioMimeType(undefined, "clip.MP4")).toBe("video/mp4");
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

  it("accepts a video file under the size cap for soundtrack analysis", () => {
    expect(assertAudioFileUsable("clip.mp4", "video/mp4", 1024)).toBe(
      "video/mp4",
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

describe("readContractDuration", () => {
  it("reads the contract-level duration", () => {
    expect(
      readContractDuration(
        '<script>window.MOBILE_AGENT_VIDEO = { duration: 18, fps: 30, render: function () {} };</script>',
      ),
    ).toBe(18);
  });

  it("reads fractional durations and ignores later cue timings", () => {
    expect(
      readContractDuration(
        'MOBILE_AGENT_VIDEO = { duration: 6.5, audio: { tracks: [{ start: 0, duration: 6 }] } }',
      ),
    ).toBe(6.5);
  });

  it("prefers a later top-level declaration over a stale first one", () => {
    expect(
      readContractDuration(
        "window.MOBILE_AGENT_VIDEO = { duration: 25, fps: 30, render: function () {}, duration: 21 };",
      ),
    ).toBe(21);
  });

  it("prefers a post-creation override assignment", () => {
    expect(
      readContractDuration(
        "window.MOBILE_AGENT_VIDEO = { duration: 25 }; window.MOBILE_AGENT_VIDEO.duration = 21;",
      ),
    ).toBe(21);
  });

  it("ignores durations inside strings", () => {
    expect(
      readContractDuration(
        'MOBILE_AGENT_VIDEO = { duration: 10, label: "duration: 99" };',
      ),
    ).toBe(10);
  });

  it("returns null when the contract or duration is absent", () => {
    expect(readContractDuration("<html></html>")).toBeNull();
    expect(
      readContractDuration(
        '<script>window.MOBILE_AGENT_VIDEO = { fps: 30 };</script>',
      ),
    ).toBeNull();
  });
});

describe("readContractAspect", () => {
  it("reads the declared canvas ratio (portrait and landscape)", () => {
    expect(
      readContractAspect(
        "window.MOBILE_AGENT_VIDEO = { duration: 18, width: 1080, height: 1920, render: function () {} };",
      ),
    ).toBeCloseTo(1080 / 1920);
    expect(
      readContractAspect(
        "window.MOBILE_AGENT_VIDEO = { duration: 18, width: 1920, height: 1080, render: function () {} };",
      ),
    ).toBeCloseTo(1920 / 1080);
  });

  it("uses the last top-level keys and ignores nested or quoted ones", () => {
    expect(
      readContractAspect(
        'window.MOBILE_AGENT_VIDEO = { width: 640, height: 480, label: "width: 16, height: 9", audio: { width: 9, height: 9 } };',
      ),
    ).toBeCloseTo(640 / 480);
    expect(
      readContractAspect(
        "window.MOBILE_AGENT_VIDEO = { width: 640, height: 480, height: 360 };",
      ),
    ).toBeCloseTo(640 / 360);
  });

  it("returns null when either dimension is missing or invalid", () => {
    expect(
      readContractAspect(
        "window.MOBILE_AGENT_VIDEO = { width: 1080, render: function () {} };",
      ),
    ).toBeNull();
    expect(
      readContractAspect(
        "window.MOBILE_AGENT_VIDEO = { height: 1920, render: function () {} };",
      ),
    ).toBeNull();
    expect(
      readContractAspect(
        "window.MOBILE_AGENT_VIDEO = { width: 0, height: -1920, render: function () {} };",
      ),
    ).toBeNull();
    expect(readContractAspect("<html></html>")).toBeNull();
  });
});
