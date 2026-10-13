import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getThumbnailAsync: vi.fn(),
  createDocumentFile: vi.fn(),
  onRecord: vi.fn(),
  files: new Map<string, { bytes: Uint8Array }>(),
}));

vi.mock("expo-video-thumbnails", () => ({
  getThumbnailAsync: mocks.getThumbnailAsync,
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  createWorkspaceFileService: () => ({
    createDocumentFile: mocks.createDocumentFile,
  }),
  resolveWorkspaceFile: () => ({
    exists: true,
    uri: "file:///workspace/vid.mp4",
  }),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    async bytes() {
      return mocks.files.get(this.uri)?.bytes ?? new Uint8Array(0);
    }
    delete() {}
  },
}));

const { createVideoFrameTool } = await import(
  "@/modules/tools/built-in/video-frame"
);

const VIDEO_RECORD = {
  id: "video-1",
  displayName: "clip.mp4",
  relativePath: "video-1/clip.mp4",
};

function makeTool(supportsImageInput = true) {
  mocks.getById.mockResolvedValue(VIDEO_RECORD);
  mocks.getThumbnailAsync.mockResolvedValue({
    uri: "file:///cache/frame.jpg",
    width: 1280,
    height: 720,
  });
  mocks.files.set("file:///cache/frame.jpg", {
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
  });
  mocks.createDocumentFile.mockResolvedValue({
    id: "frame-1",
    displayName: "clip-frame-12s.jpg",
    size: 4,
  });
  return createVideoFrameTool({
    repository: { getById: mocks.getById } as never,
    onRecord: mocks.onRecord,
    supportsImageInput,
  });
}

async function execute(tool: ReturnType<typeof makeTool>, input: object) {
  const def = tool as unknown as {
    execute: (input: object, opts: object) => Promise<unknown>;
  };
  return def.execute(input, {});
}

describe("getVideoFrame", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.files.clear();
  });

  it("returns inline image content on vision-capable models", async () => {
    const output = (await execute(makeTool(true), {
      fileId: "video-1",
      time: 12,
    })) as Record<string, unknown>;

    expect(mocks.getThumbnailAsync).toHaveBeenCalledWith(
      "file:///workspace/vid.mp4",
      { time: 12000, quality: 0.9 },
    );
    expect(mocks.createDocumentFile).toHaveBeenCalledWith({
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      mimeType: "image/jpeg",
      name: "clip-frame-12s.jpg",
    });
    const content = output.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toMatchObject({
      type: "file",
      mediaType: "image/jpeg",
    });
    expect(output).toMatchObject({
      fileId: "frame-1",
      link: "workspace://frame-1",
      time: 12,
    });
  });

  it("falls back to file link + ocr guidance without image input", async () => {
    const output = (await execute(makeTool(false), {
      fileId: "video-1",
      time: 12,
    })) as Record<string, unknown>;

    expect(output).not.toHaveProperty("content");
    expect(output.text).toMatch(/ocr/);
    expect(output).toMatchObject({
      fileId: "frame-1",
      link: "workspace://frame-1",
    });
  });

  it("fails clearly for unknown videos", async () => {
    mocks.getById.mockResolvedValue(null);
    const tool = createVideoFrameTool({
      repository: { getById: mocks.getById } as never,
      onRecord: mocks.onRecord,
    });
    await expect(execute(tool, { fileId: "nope", time: 1 })).rejects.toThrow(
      /No workspace file found/,
    );
  });
});
