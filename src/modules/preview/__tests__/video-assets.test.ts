import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  exists: true,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
  resolveWorkspaceFile: vi.fn(),
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  resolveWorkspaceFile: mocks.resolveWorkspaceFile,
}));

const nativeMocks = vi.hoisted(() => ({
  transcodeClip: vi.fn(),
  outExists: true,
  outBytes: new Uint8Array([0x00, 0x00, 0x00, 0x18]),
  deleted: [] as string[],
}));

vi.mock("html-video-export", () => ({
  getHtmlVideoExportModule: () => ({ transcodeClip: nativeMocks.transcodeClip }),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(
      public dir: unknown,
      public name: string,
    ) {
      this.uri = `file:///cache/${name}`;
    }
    get exists() {
      return nativeMocks.outExists;
    }
    async bytes() {
      return nativeMocks.outBytes;
    }
    delete() {
      nativeMocks.deleted.push(this.name);
    }
  },
  Paths: { cache: "mock-cache-dir" },
}));

const {
  assertImageFileUsable,
  assertVideoFileUsable,
  extractWorkspaceImageIds,
  extractWorkspaceVideoIds,
  hasWorkspaceRefs,
  inlineAudioAssets,
  inlineImageAssets,
  inlineVideoAssets,
  resolveImageMimeType,
  resolveVideoMimeType,
} = await import("@/modules/preview/video-assets");

function repository() {
  return { getById: mocks.getById } as never;
}

function workspaceFile(displayName: string, mimeType: string | null) {
  mocks.getById.mockImplementation(async (id: string) => ({
    id,
    displayName,
    mimeType,
    relativePath: `${id}/${displayName}`,
  }));
  mocks.resolveWorkspaceFile.mockReturnValue({
    get exists() {
      return mocks.exists;
    },
    bytes: async () => mocks.bytes,
  });
}

beforeEach(() => {
  mocks.getById.mockReset();
  mocks.resolveWorkspaceFile.mockReset();
  mocks.exists = true;
  mocks.bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
});

describe("extractWorkspaceImageIds", () => {
  it("finds img sources and dedupes repeats", () => {
    const html = `<img src="workspace://pic-1"><IMG SRC='workspace://pic-1'><img src="workspace://pic-2">`;

    expect(extractWorkspaceImageIds(html)).toEqual(["pic-1", "pic-2"]);
  });

  it("ignores audio tracks and video tags", () => {
    const html = `<video src="workspace://clip-1"></video>
      <script>var s = { file: "workspace://song-1" };</script>
      <img src="https://example.com/x.png">`;

    expect(extractWorkspaceImageIds(html)).toEqual([]);
  });
});

describe("extractWorkspaceVideoIds", () => {
  it("finds video and source tags", () => {
    const html = `<video src="workspace://clip-1"><source src="workspace://clip-2"></video>`;

    expect(extractWorkspaceVideoIds(html)).toEqual(["clip-1", "clip-2"]);
  });

  it("ignores audio tracks and img tags", () => {
    const html = `<img src="workspace://pic-1">
      <script>var s = { file: "workspace://song-1" };</script>`;

    expect(extractWorkspaceVideoIds(html)).toEqual([]);
  });
});

describe("resolveImageMimeType", () => {
  it("prefers a supported declared mime type", () => {
    expect(resolveImageMimeType("image/png", "photo.jpg")).toBe("image/png");
  });

  it("falls back to the file extension", () => {
    expect(resolveImageMimeType(null, "photo.webp")).toBe("image/webp");
    expect(resolveImageMimeType("application/octet-stream", "pic.gif")).toBe(
      "image/gif",
    );
  });

  it("returns null for unsupported types", () => {
    expect(resolveImageMimeType("image/svg+xml", "art.svg")).toBeNull();
    expect(resolveImageMimeType(null, "clip.mp4")).toBeNull();
  });
});

describe("resolveVideoMimeType", () => {
  it("prefers a supported declared mime type", () => {
    expect(resolveVideoMimeType("video/webm", "clip.mp4")).toBe("video/webm");
  });

  it("falls back to the file extension", () => {
    expect(resolveVideoMimeType(null, "clip.m4v")).toBe("video/mp4");
  });

  it("returns null for unsupported types", () => {
    expect(resolveVideoMimeType("video/quicktime", "clip.mov")).toBeNull();
    expect(resolveVideoMimeType(null, "song.mp3")).toBeNull();
  });
});

describe("assertImageFileUsable", () => {
  it("rejects unsupported formats, empties, and oversized files", () => {
    expect(() => assertImageFileUsable("art.svg", "image/svg+xml", 100)).toThrow(
      /not a supported image/,
    );
    expect(() => assertImageFileUsable("a.png", "image/png", 0)).toThrow(
      /empty/,
    );
    expect(() =>
      assertImageFileUsable("big.jpg", "image/jpeg", 16 * 1024 * 1024),
    ).toThrow(/too large/);
  });
});

describe("assertVideoFileUsable", () => {
  it("rejects unsupported formats, empties, and oversized files", () => {
    expect(() => assertVideoFileUsable("c.mov", "video/quicktime", 100)).toThrow(
      /not a supported video/,
    );
    expect(() => assertVideoFileUsable("c.mp4", "video/mp4", 0)).toThrow(
      /empty/,
    );
    expect(() =>
      assertVideoFileUsable("big.mp4", "video/mp4", 16 * 1024 * 1024),
    ).toThrow(/too large/);
  });
});

describe("inlineImageAssets", () => {
  it("replaces every img reference with a data URI", async () => {
    workspaceFile("photo.jpg", "image/jpeg");
    const html = `<img id="a" src="workspace://img-1"><img src="workspace://img-1">`;

    const { html: out, imageFiles } = await inlineImageAssets(html, repository());

    expect(imageFiles).toEqual(["photo.jpg"]);
    expect(out).not.toContain("workspace://");
    expect(out).toContain("data:image/jpeg;base64,");
    expect(mocks.getById).toHaveBeenCalledWith("img-1");
  });

  it("passes through HTML with no images", async () => {
    const { html: out, imageFiles } = await inlineImageAssets(
      "<p>nope</p>",
      repository(),
    );

    expect(out).toBe("<p>nope</p>");
    expect(imageFiles).toEqual([]);
    expect(mocks.getById).not.toHaveBeenCalled();
  });

  it("fails clearly for unknown, missing, or unusable files", async () => {
    mocks.getById.mockResolvedValue(null);
    await expect(
      inlineImageAssets(`<img src="workspace://gone">`, repository()),
    ).rejects.toThrow(/No workspace image file found/);

    workspaceFile("song.mp3", "audio/mpeg");
    await expect(
      inlineImageAssets(`<img src="workspace://img-1">`, repository()),
    ).rejects.toThrow(/not a supported image/);

    workspaceFile("photo.jpg", "image/jpeg");
    mocks.exists = false;
    await expect(
      inlineImageAssets(`<img src="workspace://img-1">`, repository()),
    ).rejects.toThrow(/no longer available/);
  });
});

describe("inlineVideoAssets", () => {
  it("replaces video and source references with data URIs", async () => {
    workspaceFile("clip.mp4", "video/mp4");
    const html = `<video id="bg" muted playsinline src="workspace://vid-1"></video>`;

    const { html: out, videoFiles } = await inlineVideoAssets(html, repository());

    expect(videoFiles).toEqual(["clip.mp4"]);
    expect(out).not.toContain("workspace://");
    expect(out).toContain("data:video/mp4;base64,");
  });

  it("fails clearly for an audio file in a video tag", async () => {
    workspaceFile("song.mp3", "audio/mpeg");
    await expect(
      inlineVideoAssets(`<video src="workspace://vid-1">`, repository()),
    ).rejects.toThrow(/not a supported video/);
  });
});

function bigWorkspaceFile(displayName: string, mimeType: string | null, sizeBytes: number) {
  mocks.getById.mockImplementation(async (id: string) => ({
    id,
    displayName,
    mimeType,
    relativePath: `${id}/${displayName}`,
  }));
  mocks.resolveWorkspaceFile.mockReturnValue({
    get exists() {
      return true;
    },
    size: sizeBytes,
    uri: "file:///workspace/big-clip.mp4",
    bytes: async () => {
      throw new Error("original bytes must never be read for over-cap clips");
    },
  });
}

describe("inlineVideoAssets over-cap transcoding", () => {
  const FIFTY_MB = 50 * 1024 * 1024;

  beforeEach(() => {
    nativeMocks.transcodeClip.mockReset();
    nativeMocks.transcodeClip.mockImplementation(async () => ({
      path: "/cache/clip-vid-1.mp4",
      width: 1280,
      height: 720,
      sizeBytes: 8_000_000,
    }));
    nativeMocks.outExists = false;
    nativeMocks.outBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18]);
    nativeMocks.deleted = [];
  });

  it("compresses over-cap clips and warns instead of throwing", async () => {
    bigWorkspaceFile("big-clip.mp4", "video/mp4", FIFTY_MB);
    const { html: out, videoFiles, warnings } = await inlineVideoAssets(
      `<video src="workspace://vid-1">`,
      repository(),
    );

    expect(nativeMocks.transcodeClip).toHaveBeenCalledTimes(1);
    const [inPath, outPath, maxBytes, maxDim] = nativeMocks.transcodeClip.mock.calls[0] as [string, string, number, number];
    expect(inPath).toBe("/workspace/big-clip.mp4");
    expect(outPath).toContain("clip-vid-1");
    expect(maxBytes).toBe(12 * 1024 * 1024);
    expect(maxDim).toBe(1280);
    expect(videoFiles).toEqual(["big-clip.mp4"]);
    expect(out).toContain("data:video/mp4;base64,");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/compressed/);
  });

  it("reuses an existing transcoded file without re-running the native op", async () => {
    bigWorkspaceFile("big-clip.mp4", "video/mp4", FIFTY_MB);
    nativeMocks.outExists = true;
    const { warnings } = await inlineVideoAssets(`<video src="workspace://vid-1">`, repository());
    // Cached hit: bytes inlined, warning still reported, no native call.
    expect(nativeMocks.transcodeClip).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
  });

  it("throws the oversize error when the transcode still does not fit", async () => {
    bigWorkspaceFile("big-clip.mp4", "video/mp4", FIFTY_MB);
    nativeMocks.outBytes = new Uint8Array(20 * 1024 * 1024);
    await expect(
      inlineVideoAssets(`<video src="workspace://vid-1">`, repository()),
    ).rejects.toThrow(/too large/);
    expect(nativeMocks.deleted.length).toBeGreaterThan(0);
  });

  it("throws the oversize error when transcoding fails", async () => {
    bigWorkspaceFile("big-clip.mp4", "video/mp4", FIFTY_MB);
    nativeMocks.transcodeClip.mockRejectedValueOnce(new Error("codec missing"));
    await expect(
      inlineVideoAssets(`<video src="workspace://vid-1">`, repository()),
    ).rejects.toThrow(/too large|could not be compressed/);
  });
});

describe("inlineAudioAssets", () => {
  const schedule = (id: string) =>
    `<script>window.MOBILE_AGENT_VIDEO = { audio: { tracks: [{ file: "workspace://${id}" }] } };</script>`;

  it("replaces audio-track references with data URIs", async () => {
    workspaceFile("song.mp3", "audio/mpeg");

    const { html: out, audioFiles } = await inlineAudioAssets(
      schedule("song-1"),
      repository(),
    );

    expect(audioFiles).toEqual(["song.mp3"]);
    expect(out).not.toContain("workspace://");
    expect(out).toContain("data:audio/mpeg;base64,");
  });

  it("returns the document untouched when there are no audio tracks", async () => {
    const { html: out, audioFiles } = await inlineAudioAssets(
      "<p>silent</p>",
      repository(),
    );

    expect(out).toBe("<p>silent</p>");
    expect(audioFiles).toEqual([]);
    expect(mocks.getById).not.toHaveBeenCalled();
  });

  it("fails clearly for missing or unavailable files", async () => {
    mocks.getById.mockResolvedValue(null);
    await expect(
      inlineAudioAssets(schedule("gone"), repository()),
    ).rejects.toThrow(/No workspace audio file found/);

    workspaceFile("gone.mp3", "audio/mpeg");
    mocks.exists = false;
    await expect(
      inlineAudioAssets(schedule("gone"), repository()),
    ).rejects.toThrow(/no longer available/);
  });
});

describe("hasWorkspaceRefs", () => {
  it("detects image, clip, and audio-track references", () => {
    expect(hasWorkspaceRefs("<p>silent</p>")).toBe(false);
    expect(hasWorkspaceRefs(`<img src="workspace://pic-1">`)).toBe(true);
    expect(
      hasWorkspaceRefs(`<video src="workspace://clip-1"></video>`),
    ).toBe(true);
    expect(
      hasWorkspaceRefs(
        `<script>var s = { file: "workspace://song-1" };</script>`,
      ),
    ).toBe(true);
    expect(hasWorkspaceRefs(`<img src="https://example.com/x.png">`)).toBe(
      false,
    );
  });
});
