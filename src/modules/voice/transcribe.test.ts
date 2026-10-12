import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platformOS: "android" as string,
  release: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  initWhisper: vi.fn(),
  transcribeData: vi.fn(),
  downloaded: vi.fn(() => true),
  resolveModel: vi.fn(async () => "base" as string | null),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.platformOS;
    },
  },
}));
vi.mock("./models", () => ({
  isModelDownloaded: mocks.downloaded,
  modelFile: () => ({ uri: "file:///models/ggml-base.bin" }),
  resolveTranscriptionModel: mocks.resolveModel,
}));
vi.mock("whisper.rn/index", () => ({ initWhisper: mocks.initWhisper }));

const { transcribePcm16, decodePcm16Base64 } = await import("./transcribe");

function encodePcm16(samples: number[]) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function whisperResult(overrides: Record<string, unknown> = {}) {
  return {
    result: " hello world ",
    language: "en",
    isAborted: false,
    segments: [
      { text: " hello ", t0: 0, t1: 123 },
      { text: "   ", t0: 123, t1: 200 },
      { text: "world", t0: 200, t1: 450 },
    ],
    ...overrides,
  };
}

const ONE_SECOND = encodePcm16(new Array(16000).fill(0));

describe("decodePcm16Base64", () => {
  it("round-trips signed 16-bit samples", () => {
    const decoded = decodePcm16Base64(
      encodePcm16([0, 1, -1, 32767, -32768]),
    );
    expect(Array.from(decoded)).toEqual([0, 1, -1, 32767, -32768]);
  });

  it("ignores whitespace in the payload", () => {
    const encoded = encodePcm16([100, -100]);
    const spaced = `${encoded.slice(0, 2)}\n ${encoded.slice(2)}`;
    expect(Array.from(decodePcm16Base64(spaced))).toEqual([100, -100]);
  });
});

describe("transcribePcm16", () => {
  beforeEach(() => {
    mocks.platformOS = "android";
    mocks.release.mockClear();
    mocks.stop.mockClear();
    mocks.initWhisper.mockReset();
    mocks.transcribeData.mockReset();
    mocks.downloaded.mockReset();
    mocks.downloaded.mockReturnValue(true);
    mocks.resolveModel.mockReset();
    mocks.resolveModel.mockResolvedValue("base");
    mocks.initWhisper.mockResolvedValue({
      transcribeData: mocks.transcribeData,
      release: mocks.release,
    });
    mocks.transcribeData.mockReturnValue({
      stop: mocks.stop,
      promise: Promise.resolve(whisperResult()),
    });
  });

  it("maps segments from centiseconds and drops blank spans", async () => {
    const transcript = await transcribePcm16(ONE_SECOND, 16000);

    expect(transcript.text).toBe("hello world");
    expect(transcript.language).toBe("en");
    expect(transcript.duration).toBe(1);
    expect(transcript.segments).toEqual([
      { start: 0, end: 1.23, text: "hello" },
      { start: 2, end: 4.5, text: "world" },
    ]);
  });

  it("feeds mono 16-bit PCM to whisper with auto language by default", async () => {
    await transcribePcm16(ONE_SECOND, 16000);

    const [buffer, options] = mocks.transcribeData.mock.calls[0];
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect((buffer as ArrayBuffer).byteLength).toBe(16000 * 2);
    expect(options).toMatchObject({ language: "auto", beamSize: 5 });
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("passes an explicit language through", async () => {
    await transcribePcm16(ONE_SECOND, 16000, { language: "es" });
    expect(mocks.transcribeData.mock.calls[0][1]).toMatchObject({
      language: "es",
    });
  });

  it("resamples non-16k input before handing it to whisper", async () => {
    const halfSecondAt32k = encodePcm16(new Array(16000).fill(0));
    const transcript = await transcribePcm16(halfSecondAt32k, 32000);
    // 16000 frames at 32 kHz -> 8000 frames at 16 kHz -> 0.5 s.
    expect(transcript.duration).toBe(0.5);
    expect(
      (mocks.transcribeData.mock.calls[0][0] as ArrayBuffer).byteLength,
    ).toBe(8000 * 2);
  });

  it("throws when no model is available", async () => {
    mocks.resolveModel.mockResolvedValue(null);
    await expect(transcribePcm16(ONE_SECOND, 16000)).rejects.toThrow(
      /No Whisper model/,
    );
    expect(mocks.initWhisper).not.toHaveBeenCalled();
  });

  it("throws when the resolved model is not downloaded", async () => {
    mocks.downloaded.mockReturnValue(false);
    await expect(transcribePcm16(ONE_SECOND, 16000)).rejects.toThrow(
      /model is missing/,
    );
  });

  it("prefers an explicit model over the resolved one", async () => {
    await transcribePcm16(ONE_SECOND, 16000, { model: "small" });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.initWhisper).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "file:///models/ggml-base.bin" }),
    );
  });

  it("throws and releases the context when whisper aborts", async () => {
    mocks.transcribeData.mockReturnValue({
      stop: mocks.stop,
      promise: Promise.resolve(whisperResult({ isAborted: true, result: "" })),
    });
    await expect(transcribePcm16(ONE_SECOND, 16000)).rejects.toThrow(
      /cancelled/,
    );
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("stops and releases when the abort signal fires", async () => {
    const controller = new AbortController();
    const stop = vi.fn(async () => {});
    let resolveTask: (value: unknown) => void = () => {};
    mocks.transcribeData.mockReturnValue({
      stop,
      promise: new Promise((resolve) => {
        resolveTask = resolve;
      }),
    });

    const started = transcribePcm16(ONE_SECOND, 16000, {
      signal: controller.signal,
    });
    const assertion = expect(started).rejects.toThrow(/cancelled/);
    // Let the async setup (model resolve + initWhisper) attach the listener.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    resolveTask(whisperResult({ isAborted: true, result: "" }));
    await assertion;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("releases the context when whisper rejects", async () => {
    mocks.transcribeData.mockReturnValue({
      stop: mocks.stop,
      promise: Promise.reject(new Error("native failure")),
    });
    await expect(transcribePcm16(ONE_SECOND, 16000)).rejects.toThrow(
      /native failure/,
    );
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("refuses to run on web", async () => {
    mocks.platformOS = "web";
    await expect(transcribePcm16(ONE_SECOND, 16000)).rejects.toThrow(
      /Android and iOS only/,
    );
  });

  it("rejects empty audio", async () => {
    await expect(transcribePcm16("", 16000)).rejects.toThrow(
      /No decoded audio/,
    );
  });
});
