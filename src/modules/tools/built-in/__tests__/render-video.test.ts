import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTextFile: vi.fn(),
  createDocumentFileFromFile: vi.fn(),
  requestVideoRender: vi.fn(),
  onRecord: vi.fn(),
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  createWorkspaceFileService: () => ({
    createTextFile: mocks.createTextFile,
    createDocumentFileFromFile: mocks.createDocumentFileFromFile,
  }),
  resolveWorkspaceFile: vi.fn(),
}));

vi.mock("@/modules/preview/video-render", () => ({
  requestVideoRender: mocks.requestVideoRender,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
  },
}));

const { createRenderVideoTool } = await import(
  "@/modules/tools/built-in/render-video"
);

const HTML_6S =
  '<html><script>window.MOBILE_AGENT_VIDEO = { duration: 6, fps: 30, render: function () {} };</script></html>';

function makeTool() {
  mocks.createTextFile.mockResolvedValue({
    id: "source-1",
    displayName: "clip.source.html",
  });
  mocks.createDocumentFileFromFile.mockResolvedValue({
    id: "video-1",
    displayName: "clip.mp4",
    size: 1234,
  });
  mocks.requestVideoRender.mockResolvedValue({
    uri: "file:///cache/v.mp4",
    sizeBytes: 1234,
    hasAudio: true,
    audioWarnings: [],
  });
  return createRenderVideoTool({
    repository: {} as never,
    onRecord: mocks.onRecord,
  });
}

async function execute(tool: ReturnType<typeof makeTool>, input: object) {
  const def = tool as unknown as {
    execute: (input: object, opts: object) => Promise<unknown>;
  };
  return def.execute(input, {});
}

describe("renderVideo source persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves the source HTML and returns its fileId with the render", async () => {
    const output = (await execute(makeTool(), {
      html: HTML_6S,
      name: "clip.mp4",
      duration: 6,
    })) as Record<string, unknown>;

    expect(mocks.createTextFile).toHaveBeenCalledWith({
      content: HTML_6S,
      mimeType: "text/html",
      name: "clip.source.html",
    });
    expect(output).toMatchObject({
      fileId: "video-1",
      duration: 6,
      hasAudio: true,
      sourceFileId: "source-1",
      sourceLink: "workspace://source-1",
    });
  });

  it("still saves the source when the duration check fails", async () => {
    await expect(
      execute(makeTool(), { html: HTML_6S, name: "clip.mp4", duration: 20 }),
    ).rejects.toThrow(/does not match the requested duration/);
    expect(mocks.createTextFile).toHaveBeenCalledTimes(1);
    expect(mocks.requestVideoRender).not.toHaveBeenCalled();
  });

  it("renders without a requested duration and reports the contract one", async () => {
    const output = (await execute(makeTool(), {
      html: HTML_6S,
      name: "clip.mp4",
    })) as Record<string, unknown>;
    expect(output).toMatchObject({ duration: 6, sourceFileId: "source-1" });
  });
});
