import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startAssetServer: vi.fn(),
  module: true as boolean,
}));

vi.mock("html-video-export", () => ({
  getHtmlVideoExportModule: () =>
    mocks.module ? { startAssetServer: mocks.startAssetServer } : null,
}));

vi.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache" } },
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  getWorkspaceDirectory: () => ({ uri: "file:///workspace" }),
  resolveWorkspaceFile: vi.fn(),
}));

const {
  cacheFileUrl,
  ensureAssetServer,
  resetAssetServerForTests,
  servedCacheUrl,
  workspaceFileUrl,
} = await import("@/modules/preview/asset-server");

describe("asset-server urls", () => {
  it("builds segment-encoded workspace and cache urls", () => {
    expect(workspaceFileUrl("http://127.0.0.1:1", "abc/my clip.mp4")).toBe(
      "http://127.0.0.1:1/files/abc/my%20clip.mp4",
    );
    expect(cacheFileUrl("http://127.0.0.1:1", "clip-x.mp4")).toBe(
      "http://127.0.0.1:1/cache/clip-x.mp4",
    );
    expect(servedCacheUrl("http://127.0.0.1:1", "file:///cache/scene-a.html")).toBe(
      "http://127.0.0.1:1/cache/scene-a.html",
    );
  });
});

describe("ensureAssetServer", () => {
  beforeEach(() => {
    resetAssetServerForTests();
    mocks.startAssetServer.mockReset();
    mocks.module = true;
    mocks.startAssetServer.mockResolvedValue({ port: 4321 });
  });

  it("starts once and caches the base url", async () => {
    expect(await ensureAssetServer()).toBe("http://127.0.0.1:4321");
    expect(await ensureAssetServer()).toBe("http://127.0.0.1:4321");
    expect(mocks.startAssetServer).toHaveBeenCalledTimes(1);
    expect(mocks.startAssetServer).toHaveBeenCalledWith("/workspace", "/cache");
  });

  it("returns null when the native module is missing", async () => {
    mocks.module = false;
    expect(await ensureAssetServer()).toBeNull();
  });

  it("returns null when start throws", async () => {
    mocks.startAssetServer.mockRejectedValueOnce(new Error("nope"));
    expect(await ensureAssetServer()).toBeNull();
  });
});
