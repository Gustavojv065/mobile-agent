import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createSceneDocument } from "../scene-document";

const mocks = vi.hoisted(() => ({ create: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "unique-id" }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    uri: string;
    constructor(base: string, name: string) { this.uri = `${base}/${name}`; }
    create = mocks.create;
    write = mocks.write;
    delete = mocks.remove;
  },
}));

describe("file-backed scene documents", () => {
  beforeEach(() => vi.resetAllMocks());

  it("writes the exact large document and returns only a file URI", () => {
    const html = `<html>${"x".repeat(22_031_405)}</html>`;
    const document = createSceneDocument(html);
    expect(mocks.write).toHaveBeenCalledWith(html);
    expect(document.uri).toBe("file:///cache/scene-unique-id.html");
    expect(document).not.toHaveProperty("html");
    document.dispose();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("cleans up partial files and surfaces write failures", () => {
    mocks.write.mockImplementation(() => { throw new Error("disk full"); });
    expect(() => createSceneDocument("<html/>")).toThrow("disk full");
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("tolerates cache eviction during cleanup", () => {
    const document = createSceneDocument("<html/>");
    mocks.remove.mockImplementation(() => { throw new Error("gone"); });
    expect(() => document.dispose()).not.toThrow();
  });

  it("uses file sources for preview, mix and export instead of huge source props", () => {
    for (const name of ["video-preview-host", "video-mix-host", "video-render-host"]) {
      const source = readFileSync(new URL(`../../../components/ui/${name}.tsx`, import.meta.url), "utf8");
      expect(source).toContain("createSceneDocument(");
      expect(source).toContain("source={{ uri:");
      expect(source).not.toContain("source={{ html:");
      expect(source).toContain("documentRef.current?.dispose()");
    }
  });

  it("loads the manual export page from a file so inlined media survives", () => {
    const source = readFileSync(new URL("../../../components/ui/code-preview-dialog.tsx", import.meta.url), "utf8");
    expect(source).toContain("createSceneDocument(");
    expect(source).toContain("source={documentUri ? { uri: documentUri } : undefined}");
    expect(source).not.toContain("source={{ html: buildVideoExportDocument(");
    expect(source).toContain("documentRef.current?.dispose()");
  });
});
