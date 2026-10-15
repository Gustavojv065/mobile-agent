import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDocumentFileFromFile: vi.fn(),
  requestPageShot: vi.fn(),
  hasPageShotHost: vi.fn(),
  onRecord: vi.fn(),
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  createWorkspaceFileService: () => ({
    createDocumentFileFromFile: mocks.createDocumentFileFromFile,
  }),
  resolveWorkspaceFile: vi.fn(),
}));

vi.mock("@/modules/preview/page-shot", () => ({
  hasPageShotHost: mocks.hasPageShotHost,
  requestPageShot: mocks.requestPageShot,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
  },
}));

const { createScreenshotPageTool } = await import(
  "@/modules/tools/built-in/screenshot-page"
);

function makeTool() {
  return createScreenshotPageTool({
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

describe("screenshotPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasPageShotHost.mockReturnValue(true);
    mocks.requestPageShot.mockResolvedValue({ tmpUri: "file:///cache/shot.png" });
    mocks.createDocumentFileFromFile.mockResolvedValue({
      id: "shot-1",
      displayName: "screenshot-1.png",
      size: 4321,
    });
  });

  it("persists the capture and returns a workspace link", async () => {
    const out = (await execute(makeTool(), { url: "https://example.com" })) as Record<
      string,
      unknown
    >;

    expect(mocks.requestPageShot).toHaveBeenCalledWith({
      url: "https://example.com/",
      signal: undefined,
    });
    expect(mocks.createDocumentFileFromFile).toHaveBeenCalledWith({
      source: expect.objectContaining({ uri: "file:///cache/shot.png" }),
      mimeType: "image/png",
      name: expect.stringMatching(/^screenshot-\d+\.png$/),
    });
    expect(out).toMatchObject({
      fileId: "shot-1",
      link: "workspace://shot-1",
      mimeType: "image/png",
    });
  });

  it.each(["http://localhost:3000/", "http://127.0.0.1/", "ftp://example.com/x"])(
    "blocks %s",
    async (url) => {
      await expect(execute(makeTool(), { url })).rejects.toThrow();
      expect(mocks.requestPageShot).not.toHaveBeenCalled();
    },
  );

  it("fails fast with no host", async () => {
    mocks.hasPageShotHost.mockReturnValue(false);
    await expect(execute(makeTool(), { url: "https://example.com" })).rejects.toThrow(
      /Android/,
    );
  });
});
