import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  module: null as null | {
    synthesize: (
      text: string,
      options?: Record<string, unknown>,
    ) => Promise<{
      uri: string;
      durationMs: number;
      sampleRate: number;
      channels: number;
    }>;
  },
  createDocumentFileFromFile: vi.fn(),
  partIndex: 0,
}));

vi.mock("local-tts", () => ({
  getLocalTtsModule: () => mocks.module,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
  },
}));

const { chunkNarrationText, synthesizeNarrationParts } = await import(
  "./local-tts"
);

function stubService() {
  mocks.createDocumentFileFromFile.mockImplementation(
    async ({ name, source }: { name: string; source: { uri: string } }) => {
      mocks.partIndex += 1;
      return {
        id: `part-${mocks.partIndex}`,
        displayName: name,
        sourceUri: source.uri,
      };
    },
  );
  return { createDocumentFileFromFile: mocks.createDocumentFileFromFile };
}

function androidModule(durationsMs: number[] = [2500]) {
  let call = 0;
  const calls: { text: string; options?: Record<string, unknown> }[] = [];
  mocks.module = {
    synthesize: async (text, options) => {
      calls.push({ text, options });
      const durationMs = durationsMs[Math.min(call, durationsMs.length - 1)];
      call += 1;
      return {
        uri: `file:///cache/tts-${call}.wav`,
        durationMs,
        sampleRate: 22050,
        channels: 1,
      };
    },
  };
  return calls;
}

beforeEach(() => {
  mocks.module = null;
  mocks.partIndex = 0;
  mocks.createDocumentFileFromFile.mockReset();
});

describe("chunkNarrationText", () => {
  it("packs short sentences up to the limit", () => {
    expect(
      chunkNarrationText("Hello there. This is a test. Short.", 30),
    ).toEqual(["Hello there. This is a test.", "Short."]);
  });

  it("keeps punctuation with its sentence", () => {
    expect(chunkNarrationText("Really? Yes! Wow… ok", 100)).toEqual([
      "Really? Yes! Wow… ok",
    ]);
  });

  it("hard-splits an over-long sentence on word boundaries", () => {
    const chunks = chunkNarrationText(
      "one two three four five six seven",
      13,
    );
    expect(chunks).toEqual([
      "one two three",
      "four five six",
      "seven",
    ]);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(13);
  });

  it("returns nothing for blank text", () => {
    expect(chunkNarrationText("   ")).toEqual([]);
  });
});

describe("synthesizeNarrationParts", () => {
  it("synthesizes a short script as one workspace file", async () => {
    const calls = androidModule([2450]);
    const service = stubService();

    const result = await synthesizeNarrationParts("Hello world.", {
      language: "en",
      rate: 1.1,
      workspaceService: service,
    });

    expect(calls).toEqual([
      { text: "Hello world.", options: { language: "en", rate: 1.1 } },
    ]);
    expect(mocks.createDocumentFileFromFile).toHaveBeenCalledWith({
      source: expect.objectContaining({ uri: "file:///cache/tts-1.wav" }),
      mimeType: "audio/wav",
      name: "narration.wav",
    });
    expect(result.parts).toEqual([
      {
        fileId: "part-1",
        displayName: "narration.wav",
        link: "workspace://part-1",
        start: 0,
        duration: 2.45,
      },
    ]);
    expect(result.totalDuration).toBe(2.45);
    expect(result.language).toBe("en");
  });

  it("schedules multiple parts back to back with numbered names", async () => {
    androidModule([2000, 3000]);
    const service = stubService();
    // ~48 chars per sentence × 40 forces two chunks at the 1500 default.
    const script = Array.from(
      { length: 40 },
      (_, i) => `Sentence number ${i} fills out the narration part.`,
    ).join(" ");

    const result = await synthesizeNarrationParts(script, {
      workspaceService: service,
      name: "intro",
      language: "es",
    });

    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]).toMatchObject({
      displayName: "intro-1.wav",
      start: 0,
      duration: 2,
    });
    expect(result.parts[1]).toMatchObject({
      displayName: "intro-2.wav",
      start: 2,
      duration: 3,
    });
    expect(result.totalDuration).toBe(5);
    expect(result.language).toBe("es");
  });

  it("omits unset options and reports the device default language", async () => {
    const calls = androidModule();
    await synthesizeNarrationParts("Hi.", {
      workspaceService: stubService(),
    });
    expect(calls[0].options).toEqual({});
  });

  it("fails clearly without the native module", async () => {
    mocks.module = null;
    await expect(
      synthesizeNarrationParts("Hi.", { workspaceService: stubService() }),
    ).rejects.toThrow(/local TTS module/);
    expect(mocks.createDocumentFileFromFile).not.toHaveBeenCalled();
  });

  it("rejects empty text", async () => {
    androidModule();
    await expect(
      synthesizeNarrationParts("  ", { workspaceService: stubService() }),
    ).rejects.toThrow(/Nothing to speak/);
  });

  it("honors an already-aborted signal", async () => {
    androidModule();
    const controller = new AbortController();
    controller.abort();
    await expect(
      synthesizeNarrationParts("Hi.", {
        workspaceService: stubService(),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(mocks.createDocumentFileFromFile).not.toHaveBeenCalled();
  });

  it("propagates a native voice error verbatim", async () => {
    mocks.module = {
      synthesize: async () => {
        throw new Error('The on-device voice for "xx" is not installed.');
      },
    };
    await expect(
      synthesizeNarrationParts("Hi.", {
        workspaceService: stubService(),
        language: "xx",
      }),
    ).rejects.toThrow(/not installed/);
  });
});
