import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolExecutionRecord } from "@/core/types/app-state";
import type { AudioAnalysisSummary } from "@/modules/preview/video-audio-analysis";

const mocks = vi.hoisted(() => ({
  exists: true,
  bytes: new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]),
  getById: vi.fn(),
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  resolveWorkspaceFile: () => ({
    get exists() {
      return mocks.exists;
    },
    bytes: async () => mocks.bytes,
  }),
}));

const { createAnalyzeAudioTool } = await import(
  "@/modules/tools/built-in/analyze-audio"
);
const { subscribeAudioAnalysis } = await import(
  "@/modules/preview/video-audio-analysis-job"
);

const SUMMARY: AudioAnalysisSummary = {
  ready: true,
  duration: 12.5,
  frameRate: 46.875,
  bpm: 120,
  beatCount: 2,
  beats: [0.5, 1],
  curvePoints: 2,
  curveStepSeconds: 6.25,
  energy: [0.2, 0.9],
  low: [0.1, 0.8],
  mid: [0.3, 0.4],
  high: [0.05, 0.2],
  onset: [0, 1],
};

function repository(record: unknown) {
  mocks.getById.mockResolvedValue(record);
  return { getById: mocks.getById } as never;
}

const mp3Record = {
  id: "file-1",
  displayName: "song.mp3",
  mimeType: "audio/mpeg",
  relativePath: "audio/song.mp3",
};

describe("analyzeAudio tool", () => {
  let unsubscribe: (() => void) | null = null;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    mocks.exists = true;
    mocks.getById.mockReset();
  });

  it("rejects an unknown file id", async () => {
    const tool = createAnalyzeAudioTool({
      repository: repository(null),
      onRecord: () => {},
    });
    await expect(tool.execute!({ fileId: "nope" }, {} as never)).rejects.toThrow(
      /No workspace file found/,
    );
  });

  it("rejects a file that is no longer present locally", async () => {
    mocks.exists = false;
    const tool = createAnalyzeAudioTool({
      repository: repository(mp3Record),
      onRecord: () => {},
    });
    await expect(tool.execute!({ fileId: "file-1" }, {} as never)).rejects.toThrow(
      /no longer available/,
    );
  });

  it("rejects an unsupported audio format", async () => {
    const tool = createAnalyzeAudioTool({
      repository: repository({
        ...mp3Record,
        displayName: "notes.txt",
        mimeType: "text/plain",
      }),
      onRecord: () => {},
    });
    await expect(tool.execute!({ fileId: "file-1" }, {} as never)).rejects.toThrow(
      /not a supported format/,
    );
  });

  it("resolves the summary from the analysis host and records success", async () => {
    const records: ToolExecutionRecord[] = [];
    unsubscribe = subscribeAudioAnalysis((job) => {
      job.resolve({ summary: SUMMARY });
    });
    const tool = createAnalyzeAudioTool({
      repository: repository(mp3Record),
      onRecord: (record) => records.push(record),
    });

    const out = (await tool.execute!({ fileId: "file-1" }, {} as never)) as {
      fileId: string;
      displayName: string;
      bpm: number | null;
      beats: number[];
    };
    expect(out).toMatchObject({
      fileId: "file-1",
      displayName: "song.mp3",
      ready: true,
      bpm: 120,
      beats: [0.5, 1],
    });
    expect(records.at(-1)).toMatchObject({
      toolName: "analyzeAudio",
      status: "completed",
    });
  });

  it("records a failure and rejects when analysis fails", async () => {
    const records: ToolExecutionRecord[] = [];
    unsubscribe = subscribeAudioAnalysis((job) => {
      job.reject(new Error("The audio file could not be read."));
    });
    const tool = createAnalyzeAudioTool({
      repository: repository(mp3Record),
      onRecord: (record) => records.push(record),
    });

    await expect(tool.execute!({ fileId: "file-1" }, {} as never)).rejects.toThrow(
      /could not be read/,
    );
    expect(records.at(-1)).toMatchObject({
      toolName: "analyzeAudio",
      status: "failed",
    });
  });

  it("rejects when no analysis host is mounted", async () => {
    const tool = createAnalyzeAudioTool({
      repository: repository(mp3Record),
      onRecord: () => {},
    });
    await expect(tool.execute!({ fileId: "file-1" }, {} as never)).rejects.toThrow(
      /only available on builds/,
    );
  });
});
