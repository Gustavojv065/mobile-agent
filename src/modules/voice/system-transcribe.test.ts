import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: unknown) => void;

const mocks = vi.hoisted(() => {
  const listeners: Record<string, Listener[]> = {};
  return {
    platformOS: "android" as string,
    platformVersion: 34 as number | string,
    listeners,
    isAvailable: vi.fn(() => true),
    start: vi.fn(),
    abort: vi.fn(),
    directoryCreate: vi.fn(),
    fileWrite: vi.fn(),
    fileDelete: vi.fn(),
    fileExists: true,
    fileUri: "file:///cache/mobile-agent-speech/speech-1.wav",
  };
});

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.platformOS;
    },
    get Version() {
      return mocks.platformVersion;
    },
  },
}));

vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache://root" },
  Directory: class {
    create = mocks.directoryCreate;
  },
  File: class {
    uri = mocks.fileUri;
    get exists() {
      return mocks.fileExists;
    }
    write = mocks.fileWrite;
    delete = mocks.fileDelete;
  },
}));

// The real transcribe module reaches into the model catalog (and, on import,
// the native file system) only to resolve a Whisper model; the system engine
// never uses one, so the model lookup is stubbed out.
vi.mock("./models", () => ({
  isModelDownloaded: () => false,
  modelFile: () => ({ uri: "" }),
  resolveTranscriptionModel: async () => null,
}));

vi.mock("expo-speech-recognition", () => ({
  AudioEncodingAndroid: { ENCODING_PCM_16BIT: 2 },
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: mocks.isAvailable,
    start: mocks.start,
    abort: mocks.abort,
    addListener: (name: string, listener: Listener) => {
      const list = mocks.listeners[name] ?? (mocks.listeners[name] = []);
      list.push(listener);
      return {
        remove: () => {
          mocks.listeners[name] = (mocks.listeners[name] ?? []).filter(
            (item) => item !== listener,
          );
        },
      };
    },
  },
}));

const {
  mergeWordSegments,
  normalizeSpeechWords,
  systemTranscriptionSupport,
  transcribePcm16WithSystem,
} = await import("./system-transcribe");

function encodePcm16(samples: number[]) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const ONE_SECOND = encodePcm16(new Array(16000).fill(0));

function emit(name: string, event: unknown) {
  for (const listener of [...(mocks.listeners[name] ?? [])]) listener(event);
}

function word(start: number, end: number, text: string) {
  return { startTimeMillis: start, endTimeMillis: end, segment: text, confidence: 1 };
}

function finalResult(transcript: string, segments: unknown[]) {
  return {
    isFinal: true,
    results: [{ transcript, confidence: 1, segments }],
  };
}

function startOptions(call = 0) {
  return mocks.start.mock.calls[call][0] as Record<string, unknown>;
}

beforeEach(() => {
  mocks.platformOS = "android";
  mocks.platformVersion = 34;
  mocks.listeners = {};
  mocks.isAvailable.mockReset();
  mocks.isAvailable.mockReturnValue(true);
  mocks.start.mockReset();
  mocks.abort.mockReset();
  mocks.directoryCreate.mockReset();
  mocks.fileWrite.mockReset();
  mocks.fileDelete.mockReset();
  mocks.fileExists = true;
});

describe("mergeWordSegments", () => {
  it("groups words into a phrase and closes it on sentence punctuation", () => {
    const phrase = mergeWordSegments([
      { start: 0, end: 0.3, text: "Hi" },
      { start: 0.3, end: 0.7, text: "there." },
      { start: 0.7, end: 1.1, text: "Next" },
    ]);
    expect(phrase).toEqual([
      { start: 0, end: 0.7, text: "Hi there." },
      { start: 0.7, end: 1.1, text: "Next" },
    ]);
  });

  it("closes a phrase on a long pause", () => {
    const phrase = mergeWordSegments([
      { start: 0, end: 0.3, text: "one" },
      { start: 2, end: 2.4, text: "two" },
    ]);
    expect(phrase).toEqual([
      { start: 0, end: 0.3, text: "one" },
      { start: 2, end: 2.4, text: "two" },
    ]);
  });

  it("closes a phrase when it grows past the character or word limit", () => {
    const words = ["alpha", "bravo", "charlie"].map((text, index) => ({
      start: index,
      end: index + 0.5,
      text,
    }));
    expect(mergeWordSegments(words, { maxWords: 2 })).toEqual([
      { start: 0, end: 1.5, text: "alpha bravo" },
      { start: 2, end: 2.5, text: "charlie" },
    ]);
    // "alpha bravo" is 11 characters, so it still fits in 12; adding "charlie"
    // would push it to 19 and closes the span first.
    expect(mergeWordSegments(words, { maxChars: 12 })).toEqual([
      { start: 0, end: 1.5, text: "alpha bravo" },
      { start: 2, end: 2.5, text: "charlie" },
    ]);
  });

  it("drops blank words and clamps negative starts", () => {
    const phrase = mergeWordSegments([
      { start: -1, end: 0.2, text: "  hey  " },
      { start: 0.2, end: 0.3, text: "   " },
    ]);
    expect(phrase).toEqual([{ start: 0, end: 0.2, text: "hey" }]);
  });

  it("returns nothing for no words", () => {
    expect(mergeWordSegments([])).toEqual([]);
  });
});

describe("normalizeSpeechWords", () => {
  it("maps native word segments to seconds", () => {
    expect(normalizeSpeechWords([word(0, 400, "hello"), word(400, 900, "world")])).toEqual([
      { start: 0, end: 0.4, text: "hello" },
      { start: 0.4, end: 0.9, text: "world" },
    ]);
  });

  it("sorts, drops blanks and tolerates junk", () => {
    expect(
      normalizeSpeechWords([
        word(900, 1200, "later"),
        { startTimeMillis: NaN, endTimeMillis: NaN, segment: "nan", confidence: 1 },
        word(0, 300, "  "),
        word(300, 600, "first"),
      ]),
    ).toEqual([
      // Non-numeric timings collapse to zero rather than becoming NaN.
      { start: 0, end: 0, text: "nan" },
      { start: 0.3, end: 0.6, text: "first" },
      { start: 0.9, end: 1.2, text: "later" },
    ]);
  });

  it("handles a missing segment list", () => {
    expect(normalizeSpeechWords(undefined)).toEqual([]);
  });
});

describe("systemTranscriptionSupport", () => {
  it("rejects non-Android platforms", () => {
    mocks.platformOS = "ios";
    const support = systemTranscriptionSupport();
    expect(support.supported).toBe(false);
    expect(support.wordTimings).toBe(false);
    expect(support.reason).toMatch(/Android only/);
  });

  it("requires Android 13 for file input", () => {
    mocks.platformVersion = 32;
    const support = systemTranscriptionSupport();
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/Android 13/);
  });

  it("supports file input on Android 13 without word timings", () => {
    mocks.platformVersion = 33;
    expect(systemTranscriptionSupport()).toEqual({
      supported: true,
      wordTimings: false,
    });
  });

  it("expects word timings on Android 14+", () => {
    mocks.platformVersion = 34;
    expect(systemTranscriptionSupport()).toEqual({
      supported: true,
      wordTimings: true,
    });
  });
});

describe("transcribePcm16WithSystem", () => {
  it("streams a WAV of the decoded audio and returns merged phrases", async () => {
    const pending = transcribePcm16WithSystem(ONE_SECOND, 16000, {
      language: "en",
    });

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(startOptions()).toMatchObject({
      lang: "en",
      requiresOnDeviceRecognition: true,
      audioSource: {
        uri: mocks.fileUri,
        audioChannels: 1,
        audioEncoding: 2,
        sampleRate: 16000,
      },
    });

    const written = mocks.fileWrite.mock.calls[0][0] as Uint8Array;
    expect(String.fromCharCode(...written.slice(0, 4))).toBe("RIFF");
    expect(written.byteLength).toBe(44 + 16000 * 2);

    emit(
      "result",
      finalResult("hello world", [
        word(0, 400, "hello"),
        word(400, 900, "world"),
      ]),
    );

    const transcript = await pending;
    expect(transcript.text).toBe("hello world");
    expect(transcript.language).toBe("en");
    expect(transcript.segments).toEqual([
      { start: 0, end: 0.9, text: "hello world" },
    ]);
    expect(transcript.duration).toBe(0.9);
    expect(transcript.hasWordTimings).toBe(true);
    expect(transcript.onDevice).toBe(true);
    // The scratch WAV never outlives the call.
    expect(mocks.fileDelete).toHaveBeenCalled();
  });

  it("omits the language when none was requested", async () => {
    const pending = transcribePcm16WithSystem(ONE_SECOND, 16000);
    expect(startOptions()).not.toHaveProperty("lang");
    emit("result", finalResult("hi", []));
    await pending;
  });

  it("uses network recognition and reports no timings on Android 13", async () => {
    mocks.platformVersion = 33;
    const pending = transcribePcm16WithSystem(ONE_SECOND, 16000);

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(startOptions()).toMatchObject({ requiresOnDeviceRecognition: false });

    emit("result", finalResult("hello", []));
    const transcript = await pending;

    expect(transcript.text).toBe("hello");
    expect(transcript.segments).toEqual([]);
    expect(transcript.hasWordTimings).toBe(false);
    expect(transcript.onDevice).toBe(false);
    // Falls back to the decoded length when the recognizer reports no timings.
    expect(transcript.duration).toBe(1);
  });

  it("falls back to the network recognizer when the on-device one fails", async () => {
    const pending = transcribePcm16WithSystem(ONE_SECOND, 16000);
    expect(mocks.start).toHaveBeenCalledTimes(1);

    emit("error", { error: "service-not-allowed", message: "no service" });

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    expect(startOptions(1)).toMatchObject({ requiresOnDeviceRecognition: false });

    emit("result", finalResult("fallback", []));
    const transcript = await pending;

    expect(transcript.text).toBe("fallback");
    expect(transcript.onDevice).toBe(false);
    expect(mocks.abort).toHaveBeenCalled();
  });

  it("surfaces an actionable message for an unsupported device", async () => {
    mocks.platformVersion = 33;
    const pending = transcribePcm16WithSystem(ONE_SECOND, 16000);
    await vi.waitFor(() => expect(mocks.listeners.error?.length).toBeGreaterThan(0));

    emit("error", { error: "audio-capture", message: "native detail" });
    await expect(pending).rejects.toThrow(/Android 13\+/);
    // The scratch file is cleaned up even on the failure path.
    expect(mocks.fileDelete).toHaveBeenCalled();
  });

  it("falls back to the native message for an unmapped error", async () => {
    mocks.platformVersion = 33;
    const pending = transcribePcm16WithSystem(ONE_SECOND, 16000);
    await vi.waitFor(() => expect(mocks.listeners.error?.length).toBeGreaterThan(0));

    emit("error", { error: "unknown", message: "something odd" });
    await expect(pending).rejects.toThrow(/something odd/);
  });

  it("refuses to run off Android", async () => {
    mocks.platformOS = "ios";
    await expect(transcribePcm16WithSystem(ONE_SECOND, 16000)).rejects.toThrow(
      /Android only/,
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.fileWrite).not.toHaveBeenCalled();
  });

  it("fails clearly when the device has no recognizer", async () => {
    mocks.isAvailable.mockReturnValue(false);
    await expect(transcribePcm16WithSystem(ONE_SECOND, 16000)).rejects.toThrow(
      /No system speech recognition service/,
    );
    expect(mocks.fileWrite).not.toHaveBeenCalled();
  });

  it("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      transcribePcm16WithSystem(ONE_SECOND, 16000, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });

  it("times out instead of hanging on a silent recognizer", async () => {
    mocks.platformVersion = 33;
    await expect(
      transcribePcm16WithSystem(ONE_SECOND, 16000, { timeoutMs: 5 }),
    ).rejects.toThrow(/timed out/);
  });

  it("rejects empty audio", async () => {
    await expect(transcribePcm16WithSystem("", 16000)).rejects.toThrow(
      /No decoded audio/,
    );
  });
});
