import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestVideoRender: vi.fn(),
  concatSegments: vi.fn(),
  files: new Map<string, { exists: boolean; content: string }>(),
}));

function key(uri: string) {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

vi.mock("@/modules/preview/video-render", () => ({
  requestVideoRender: mocks.requestVideoRender,
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  createWorkspaceFileService: () => ({}),
  resolveWorkspaceFile: vi.fn(),
}));

vi.mock("html-video-export", () => ({
  getHtmlVideoExportModule: () => ({ concatSegments: mocks.concatSegments }),
}));

vi.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache" } },
  File: class {
    uri: string;
    constructor(uriOrDir: string | { uri: string }, name?: string) {
      if (typeof uriOrDir === "string" && name !== undefined) {
        this.uri = `${uriOrDir}/cache/${name}`;
      } else if (typeof uriOrDir === "string") {
        this.uri = uriOrDir;
      } else {
        const base = uriOrDir.uri.replace(/\/$/, "");
        this.uri = name !== undefined ? `${base}/${name}` : base;
      }
    }
    get exists() {
      return mocks.files.get(key(this.uri))?.exists ?? false;
    }
    async bytes() {
      return new Uint8Array([1, 2, 3]);
    }
    async text() {
      return mocks.files.get(key(this.uri))?.content ?? "";
    }
    async write(content: string) {
      mocks.files.set(key(this.uri), { exists: true, content });
    }
    async move(dest: { uri: string }, _opts?: unknown) {
      mocks.files.set(key(dest.uri), { exists: true, content: "video" });
    }
    async delete() {
      mocks.files.delete(key(this.uri));
    }
  },
}));

const { renderSegments } = await import(
  "@/modules/tools/built-in/render-video"
);

const DOC = "<html>MOBILE_AGENT_VIDEO</html>";

function segResult(index: number, hasAudio = true) {
  return {
    uri: `file:///cache/job-seg-${index}.mp4`,
    hasAudio,
    audioWarnings: index === 0 ? ["first-seg-note"] : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.clear();
  mocks.requestVideoRender.mockImplementation(async (_html: string, opts: { segment?: { offset: number; length: number }; onProgress?: (p: number) => void }) => {
    const seg = opts.segment;
    const index = seg ? Math.round(seg.offset / 30) : 0;
    opts.onProgress?.(0.5);
    opts.onProgress?.(1);
    return segResult(index);
  });
  mocks.concatSegments.mockResolvedValue({ ok: true });
});

describe("renderSegments", () => {
  it("renders short timelines as one job with no segment args", async () => {
    const out = await renderSegments({
      contractDuration: 20,
      documentHtml: DOC,
      sourceFileId: "src-1",
    });

    expect(mocks.requestVideoRender).toHaveBeenCalledTimes(1);
    expect(mocks.requestVideoRender).toHaveBeenCalledWith(
      DOC,
      expect.objectContaining({ segment: undefined }),
    );
    expect(mocks.concatSegments).not.toHaveBeenCalled();
    expect(out.uri).toBe("file:///cache/job-seg-0.mp4");
    expect(out.warnings).toEqual([]);
    expect(out.audioWarnings).toEqual(["first-seg-note"]);
  });

  it("splits long timelines into 30 s jobs and concatenates", async () => {
    const progress: number[] = [];
    const out = await renderSegments({
      contractDuration: 65,
      documentHtml: DOC,
      sourceFileId: "src-2",
      onProgress: (p) => progress.push(p.bytesWritten),
    });

    expect(mocks.requestVideoRender).toHaveBeenCalledTimes(3);
    const segments = mocks.requestVideoRender.mock.calls.map(
      (call) => (call[1] as { segment: { offset: number; length: number } }).segment,
    );
    expect(segments).toEqual([
      { offset: 0, length: 30 },
      { offset: 30, length: 30 },
      { offset: 60, length: 5 },
    ]);
    expect(mocks.concatSegments).toHaveBeenCalledTimes(1);
    expect(out.warnings.join(" ")).toMatch(/3 segments/);
    expect(out.hasAudio).toBe(true);
    expect(progress[0]).toBeGreaterThanOrEqual(0);
    expect(progress[progress.length - 1]).toBeGreaterThan(progress[0]);
  });

  it("resumes by reusing finished segments and their audio flags", async () => {
    mocks.files.set("/cache/render-src-3-seg-0.mp4", { exists: true, content: "video" });
    mocks.files.set(
      "/cache/render-src-3-seg-0.json",
      { exists: true, content: JSON.stringify({ hasAudio: true, audioWarnings: ["kept-note"] }) },
    );
    const out = await renderSegments({
      contractDuration: 65,
      documentHtml: DOC,
      sourceFileId: "src-3",
    });

    expect(mocks.requestVideoRender).toHaveBeenCalledTimes(2);
    expect(out.hasAudio).toBe(true);
    expect(out.audioWarnings).toContain("kept-note");
    const concatArgs = mocks.concatSegments.mock.calls[0][0] as string[];
    expect(concatArgs).toHaveLength(3);
    expect(concatArgs[0]).toContain("seg-0");
  });

  it("names the failed segment and its time range", async () => {
    mocks.requestVideoRender.mockImplementation(async (_html: string, opts: { segment?: { offset: number; length: number } }) => {
      if (opts.segment && opts.segment.offset === 30) throw new Error("boom");
      return segResult(0);
    });
    await expect(
      renderSegments({ contractDuration: 65, documentHtml: DOC, sourceFileId: "src-4" }),
    ).rejects.toThrow(/Segment 2\/3.*t=30-60.*boom/);
  });
});
