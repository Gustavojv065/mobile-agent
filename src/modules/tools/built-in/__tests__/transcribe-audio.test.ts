import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolExecutionRecord } from "@/core/types/app-state";
import type { AudioAnalysisSummary } from "@/modules/preview/video-audio-analysis";

const mocks = vi.hoisted(() => ({
  exists: true,
  bytes: new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00]),
  getById: vi.fn(),
  transcribePcm16: vi.fn(),
  transcribePcm16WithSystem: vi.fn(),
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  resolveWorkspaceFile: () => ({
    get exists() {
      return mocks.exists;
    },
    bytes: async () => mocks.bytes,
  }),
}));

vi.mock("@/modules/voice/transcribe", () => ({
  transcribePcm16: mocks.transcribePcm16,
}));

// The real system engine reaches for `react-native` (platform detection) and
// `expo-file-system`, neither of which is loadable here; it has its own tests.
vi.mock("@/modules/voice/system-transcribe", () => ({
  transcribePcm16WithSystem: mocks.transcribePcm16WithSystem,
}));

const { createTranscribeAudioTool } = await import(
  "@/modules/tools/built-in/transcribe-audio"
);
const { subscribeAudioAnalysis } = await import(
  "@/modules/preview/video-audio-analysis-job"
);

const SUMMARY: AudioAnalysisSummary = {
  ready: true,
  duration: 12.5,
  frameRate: 16,
  bpm: null,
  beatCount: 0,
  beats: [],
  curvePoints: 2,
  curveStepSeconds: 6.25,
  energy: [0.1, 0.2],
  low: [0, 0],
  mid: [0, 0],
  high: [0, 0],
  onset: [0, 0],
  pitch: [0, 0],
  noteCount: 0,
  notes: [],
  key: null,
  keyConfidence: null,
  tuningCents: null,
  voicedRatio: 0,
};

const TRANSCRIPT = {
  text: "hello world",
  language: "en",
  duration: 1.5,
  segments: [{ start: 0, end: 1.5, text: "hello world" }],
};

const SYSTEM_TRANSCRIPT = {
  text: "hello world",
  language: "en",
  duration: 1.5,
  segments: [{ start: 0, end: 1.5, text: "hello world" }],
  hasWordTimings: true,
  onDevice: true,
};

function repository(record: unknown) {
  mocks.getById.mockResolvedValue(record);
  return { getById: mocks.getById } as never;
}

const mp3Record = {
  id: "file-1",
  displayName: "speech.mp3",
  mimeType: "audio/mpeg",
  relativePath: "audio/speech.mp3",
};

describe("transcribeAudio tool", () => {
  let unsubscribe: (() => void) | null = null;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    mocks.exists = true;
    mocks.getById.mockReset();
    mocks.transcribePcm16.mockReset();
    mocks.transcribePcm16WithSystem.mockReset();
  });

  it("rejects an unknown file id", async () => {
    const tool = createTranscribeAudioTool({
      repository: repository(null),
      onRecord: () => {},
    });
    await expect(tool.execute!({ fileId: "nope" }, {} as never)).rejects.toThrow(
      /No workspace file found/,
    );
  });

  it("rejects a file that is no longer present locally", async () => {
    mocks.exists = false;
    const tool = createTranscribeAudioTool({
      repository: repository(mp3Record),
      onRecord: () => {},
    });
    await expect(tool.execute!({ fileId: "file-1" }, {} as never)).rejects.toThrow(
      /no longer available/,
    );
  });

  it("rejects an unsupported audio format", async () => {
    const tool = createTranscribeAudioTool({
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

  it("requests 16 kHz PCM and returns the mapped transcript", async () => {
    const records: ToolExecutionRecord[] = [];
    let requestedPcmRate: number | undefined;
    unsubscribe = subscribeAudioAnalysis((job) => {
      requestedPcmRate = job.pcmSampleRate;
      job.resolve({ summary: SUMMARY, pcm: { base64: "AAAA", sampleRate: 16000 } });
    });
    mocks.transcribePcm16.mockResolvedValue(TRANSCRIPT);

    const tool = createTranscribeAudioTool({
      repository: repository(mp3Record),
      onRecord: (record) => records.push(record),
    });

    const out = (await tool.execute!({ fileId: "file-1" }, {} as never)) as {
      fileId: string;
      displayName: string;
      engine: string;
      language: string;
      duration: number;
      text: string;
      segmentCount: number;
      segments: unknown[];
    };

    expect(requestedPcmRate).toBe(16000);
    expect(mocks.transcribePcm16).toHaveBeenCalledWith(
      "AAAA",
      16000,
      expect.objectContaining({ language: "auto" }),
    );
    expect(mocks.transcribePcm16WithSystem).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      fileId: "file-1",
      displayName: "speech.mp3",
      engine: "whisper",
      language: "en",
      duration: 1.5,
      text: "hello world",
      segmentCount: 1,
      segments: [{ start: 0, end: 1.5, text: "hello world" }],
    });
    expect(out).not.toHaveProperty("warning");
    expect(records.at(-1)).toMatchObject({
      toolName: "transcribeAudio",
      status: "completed",
    });
  });

  it("passes an explicit language through", async () => {
    unsubscribe = subscribeAudioAnalysis((job) => {
      job.resolve({ summary: SUMMARY, pcm: { base64: "AAAA", sampleRate: 16000 } });
    });
    mocks.transcribePcm16.mockResolvedValue(TRANSCRIPT);

    const tool = createTranscribeAudioTool({
      repository: repository(mp3Record),
      onRecord: () => {},
    });
    await tool.execute!({ fileId: "file-1", language: "es" }, {} as never);

    expect(mocks.transcribePcm16).toHaveBeenCalledWith(
      "AAAA",
      16000,
      expect.objectContaining({ language: "es" }),
    );
  });

  it("fails when the decode host returns no PCM", async () => {
    const records: ToolExecutionRecord[] = [];
    unsubscribe = subscribeAudioAnalysis((job) => {
      job.resolve({ summary: SUMMARY });
    });

    const tool = createTranscribeAudioTool({
      repository: repository(mp3Record),
      onRecord: (record) => records.push(record),
    });

    await expect(tool.execute!({ fileId: "file-1" }, {} as never)).rejects.toThrow(
      /cannot decode audio/,
    );
    expect(mocks.transcribePcm16).not.toHaveBeenCalled();
    expect(records.at(-1)).toMatchObject({
      toolName: "transcribeAudio",
      status: "failed",
    });
  });

  it("records a failure when transcription throws", async () => {
    const records: ToolExecutionRecord[] = [];
    unsubscribe = subscribeAudioAnalysis((job) => {
      job.resolve({ summary: SUMMARY, pcm: { base64: "AAAA", sampleRate: 16000 } });
    });
    mocks.transcribePcm16.mockRejectedValue(new Error("No Whisper model"));

    const tool = createTranscribeAudioTool({
      repository: repository(mp3Record),
      onRecord: (record) => records.push(record),
    });

    await expect(tool.execute!({ fileId: "file-1" }, {} as never)).rejects.toThrow(
      /No Whisper model/,
    );
    expect(records.at(-1)).toMatchObject({
      toolName: "transcribeAudio",
      status: "failed",
    });
  });

  it("routes to the system engine when asked", async () => {
    unsubscribe = subscribeAudioAnalysis((job) => {
      job.resolve({ summary: SUMMARY, pcm: { base64: "AAAA", sampleRate: 16000 } });
    });
    mocks.transcribePcm16WithSystem.mockResolvedValue(SYSTEM_TRANSCRIPT);

    const tool = createTranscribeAudioTool({
      repository: repository(mp3Record),
      onRecord: () => {},
    });
    const out = (await tool.execute!(
      { fileId: "file-1", engine: "system", language: "de" },
      {} as never,
    )) as Record<string, unknown>;

    expect(mocks.transcribePcm16).not.toHaveBeenCalled();
    expect(mocks.transcribePcm16WithSystem).toHaveBeenCalledWith(
      "AAAA",
      16000,
      expect.objectContaining({ language: "de" }),
    );
    expect(out).toMatchObject({
      engine: "system",
      text: "hello world",
      segmentCount: 1,
    });
    expect(out).not.toHaveProperty("warning");
  });

  it("warns when the system engine returns no timed segments", async () => {
    unsubscribe = subscribeAudioAnalysis((job) => {
      job.resolve({ summary: SUMMARY, pcm: { base64: "AAAA", sampleRate: 16000 } });
    });
    mocks.transcribePcm16WithSystem.mockResolvedValue({
      ...SYSTEM_TRANSCRIPT,
      segments: [],
      hasWordTimings: false,
      onDevice: false,
    });

    const tool = createTranscribeAudioTool({
      repository: repository(mp3Record),
      onRecord: () => {},
    });
    const out = (await tool.execute!(
      { fileId: "file-1", engine: "system" },
      {} as never,
    )) as Record<string, unknown>;

    expect(out).toMatchObject({ engine: "system", segmentCount: 0 });
    expect(String(out.warning)).toMatch(/no timed `segments`/);
  });

  it("records a failure when the system engine throws", async () => {
    const records: ToolExecutionRecord[] = [];
    unsubscribe = subscribeAudioAnalysis((job) => {
      job.resolve({ summary: SUMMARY, pcm: { base64: "AAAA", sampleRate: 16000 } });
    });
    mocks.transcribePcm16WithSystem.mockRejectedValue(
      new Error("System transcription needs Android 13"),
    );

    const tool = createTranscribeAudioTool({
      repository: repository(mp3Record),
      onRecord: (record) => records.push(record),
    });

    await expect(
      tool.execute!({ fileId: "file-1", engine: "system" }, {} as never),
    ).rejects.toThrow(/Android 13/);
    expect(records.at(-1)).toMatchObject({
      toolName: "transcribeAudio",
      status: "failed",
    });
  });

  it("rejects when no analysis host is mounted", async () => {
    const tool = createTranscribeAudioTool({
      repository: repository(mp3Record),
      onRecord: () => {},
    });
    await expect(tool.execute!({ fileId: "file-1" }, {} as never)).rejects.toThrow(
      /only available on builds/,
    );
  });
});
