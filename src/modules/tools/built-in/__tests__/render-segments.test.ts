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

function segResult(index: number, hasAudio = true, encoder = "c2.samsung.avc.encoder") {
  return {
    uri: `file:///cache/job-seg-${index}.mp4`,
    hasAudio,
    audioWarnings: index === 0 ? ["first-seg-note"] : [],
    encoder,
    timings: {
      frames: 900,
      prepareAvgMs: 10,
      prepareMaxMs: 40,
      captureAvgMs: 5,
      captureMaxMs: 12,
      bridgeAvgMs: 3,
      bridgeMaxMs: 9,
      audioPrepMs: 50,
      pageLoadMs: 100,
      firstFrameMs: 400,
    },
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
    // Single-pass: wall time only, no concat; fixed costs pass through.
    expect(out.phases?.totalMs).toBeGreaterThanOrEqual(0);
    expect(out.phases?.concatMs).toBeUndefined();
    expect(out.phases?.pageLoadTotalMs).toBe(100);
    expect(out.phases?.firstFrameTotalMs).toBe(400);
    expect(out.phases?.audioPrepTotalMs).toBe(50);
  });

  it("splits long timelines into 30 s jobs and concatenates", async () => {
    const progress: number[] = [];
    const out = await renderSegments({
      contractDuration: 65,
      documentHtml: DOC,
      sourceFileId: "src-2",
      onProgress: (p) => progress.push(p.bytesWritten / p.totalBytes * 100),
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

  it("sums fixed per-segment costs across every fresh segment", async () => {
    const out = await renderSegments({
      contractDuration: 65,
      documentHtml: DOC,
      sourceFileId: "src-phases",
    });

    // Three fresh segments, each reporting 100/400/50 ms of fixed cost.
    expect(out.phases?.totalMs).toBeGreaterThanOrEqual(0);
    expect(out.phases?.concatMs).toBeGreaterThanOrEqual(0);
    expect(out.phases?.pageLoadTotalMs).toBe(300);
    expect(out.phases?.firstFrameTotalMs).toBe(1200);
    expect(out.phases?.audioPrepTotalMs).toBe(150);
  });

  it("does not report 100 percent until joining has succeeded", async () => {
    const progress: number[] = [];
    mocks.concatSegments.mockImplementationOnce(async () => {
      expect(Math.max(...progress)).toBe(99);
      expect(progress).not.toContain(100);
    });
    await renderSegments({
      contractDuration: 65, documentHtml: DOC, sourceFileId: "src-progress",
      onProgress: (p) => progress.push(p.bytesWritten / p.totalBytes * 100),
    });
    expect(progress.at(-1)).toBe(100);
    expect(progress.filter((p) => p === 100)).toHaveLength(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
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

  const pinsOf = () =>
    mocks.requestVideoRender.mock.calls.map(
      (call) => (call[1] as { pinnedEncoder?: string }).pinnedEncoder,
    );

  it("pins every later segment to the first segment's encoder", async () => {
    await renderSegments({
      contractDuration: 65,
      documentHtml: DOC,
      sourceFileId: "src-pin-1",
    });

    // One output video = one set of H.264 parameters: the device picks on
    // the first segment, every later one must stay on that codec.
    expect(pinsOf()).toEqual([
      undefined,
      "c2.samsung.avc.encoder",
      "c2.samsung.avc.encoder",
    ]);
    // The sidecar records the encoder so a later resume can re-pin.
    const sidecar = JSON.parse(
      mocks.files.get("/cache/render-src-pin-1-seg-0.json")?.content ?? "{}",
    );
    expect(sidecar.encoder).toBe("c2.samsung.avc.encoder");
  });

  it("re-pins a resumed run from the cached segment's sidecar encoder", async () => {
    // Simulates resume after a process restart: the in-memory pin is gone,
    // but segment 0's sidecar remembers which codec made it.
    mocks.files.set("/cache/render-src-pin-2-seg-0.mp4", {
      exists: true,
      content: "video",
    });
    mocks.files.set("/cache/render-src-pin-2-seg-0.json", {
      exists: true,
      content: JSON.stringify({ hasAudio: false, encoder: "c2.android.avc.encoder" }),
    });

    await renderSegments({
      contractDuration: 65,
      documentHtml: DOC,
      sourceFileId: "src-pin-2",
    });

    expect(pinsOf()).toEqual([
      "c2.android.avc.encoder",
      "c2.android.avc.encoder",
    ]);
    expect(mocks.requestVideoRender).toHaveBeenCalledTimes(2);
  });

  it("re-renders a cached segment recorded under a different encoder", async () => {
    mocks.files.set("/cache/render-src-pin-3-seg-0.mp4", { exists: true, content: "video" });
    mocks.files.set(
      "/cache/render-src-pin-3-seg-0.json",
      { exists: true, content: JSON.stringify({ encoder: "c2.samsung.avc.encoder" }) },
    );
    mocks.files.set("/cache/render-src-pin-3-seg-1.mp4", { exists: true, content: "video" });
    mocks.files.set(
      "/cache/render-src-pin-3-seg-1.json",
      { exists: true, content: JSON.stringify({ encoder: "c2.android.avc.encoder" }) },
    );

    await renderSegments({
      contractDuration: 65,
      documentHtml: DOC,
      sourceFileId: "src-pin-3",
    });

    // Segment 0 sets the run's pin; segment 1 was made by another codec, so
    // it is dropped and re-rendered under the pin instead of poisoning concat.
    const offsets = mocks.requestVideoRender.mock.calls.map(
      (call) => (call[1] as { segment: { offset: number } }).segment.offset,
    );
    expect(offsets).toEqual([30, 60]);
    expect(pinsOf()).toEqual([
      "c2.samsung.avc.encoder",
      "c2.samsung.avc.encoder",
    ]);
    expect(mocks.concatSegments).toHaveBeenCalledTimes(1);
  });

  it("keeps a cached segment whose sidecar has no encoder record", async () => {
    // Pre-pin builds recorded no encoder: reuse the footage and let concat's
    // parameter check be the safety net (fail loud, never restart silently).
    mocks.files.set("/cache/render-src-pin-4-seg-0.mp4", { exists: true, content: "video" });
    mocks.files.set("/cache/render-src-pin-4-seg-0.json", {
      exists: true,
      content: JSON.stringify({ hasAudio: true }),
    });

    await renderSegments({
      contractDuration: 65,
      documentHtml: DOC,
      sourceFileId: "src-pin-4",
    });

    expect(mocks.requestVideoRender).toHaveBeenCalledTimes(2);
    // No pin until a segment actually renders; then it takes effect.
    expect(pinsOf()).toEqual([undefined, "c2.samsung.avc.encoder"]);
  });

  it("keeps finished segments and never retries when concat rejects H.264 parameters", async () => {
    mocks.concatSegments.mockRejectedValueOnce(
      new Error(
        "Segment 3 was encoded with different H.264 parameters (SPS/PPS) than segment 1 (an encoder switch mid-run). Delete the render cache and re-run the export.",
      ),
    );

    const progress: number[] = [];
    await expect(renderSegments({
      contractDuration: 65,
      documentHtml: DOC,
      sourceFileId: "src-heal",
      onProgress: (p) => progress.push(p.bytesWritten / p.totalBytes * 100),
    })).rejects.toThrow(/Completed segments were kept.*did not restart automatically/);
    expect(mocks.requestVideoRender).toHaveBeenCalledTimes(3);
    expect(mocks.concatSegments).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i += 1) {
      expect(mocks.files.has(`/cache/render-src-heal-seg-${i}.mp4`)).toBe(true);
      expect(mocks.files.has(`/cache/render-src-heal-seg-${i}.json`)).toBe(true);
    }
    expect(Math.max(...progress)).toBe(99);
    expect(progress).not.toContain(100);

    // A USER-initiated retry can reuse every finished segment and only join.
    mocks.requestVideoRender.mockClear();
    await renderSegments({ contractDuration: 65, documentHtml: DOC, sourceFileId: "src-heal" });
    expect(mocks.requestVideoRender).not.toHaveBeenCalled();
    expect(mocks.concatSegments).toHaveBeenCalledTimes(2);
  });

  it("also keeps segments and fails without retry on a resolution mismatch", async () => {
    mocks.concatSegments.mockRejectedValueOnce(
      new Error(
        "Segment 2 resolution 1280x720 differs from segment 1 720x1280 (a stale render-cache file from a different scene size). Delete the render cache and re-run the export.",
      ),
    );

    await expect(renderSegments({ contractDuration: 65, documentHtml: DOC, sourceFileId: "src-heal-res" })).rejects.toThrow(/resolution/);
    expect(mocks.requestVideoRender).toHaveBeenCalledTimes(3);
    expect(mocks.concatSegments).toHaveBeenCalledTimes(1);
    expect(mocks.files.has("/cache/render-src-heal-res-seg-0.mp4")).toBe(true);
  });

  it("does not retry concat failures that are not cache mismatches", async () => {
    mocks.concatSegments.mockRejectedValueOnce(
      new Error("Need 1–32 segments to concatenate."),
    );

    await expect(
      renderSegments({ contractDuration: 65, documentHtml: DOC, sourceFileId: "src-noheal" }),
    ).rejects.toThrow(/Need 1–32/);

    expect(mocks.concatSegments).toHaveBeenCalledTimes(1);
    expect(mocks.requestVideoRender).toHaveBeenCalledTimes(3);
  });
});
