import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  module: null as null | {
    getVoices: () => Promise<
      {
        locale: string;
        name: string;
        quality: number;
        latency: number;
        networkRequired: boolean;
      }[]
    >;
  },
  onRecord: vi.fn(),
}));

// The native module is not loadable here; the wrapper has its own contract.
vi.mock("local-tts", () => ({
  getLocalTtsModule: () => mocks.module,
}));

const { createListVoicesTool } = await import(
  "@/modules/tools/built-in/list-voices"
);

const VOICES = [
  { locale: "en-US", name: "English US", quality: 500, latency: 100, networkRequired: false },
  { locale: "en-GB", name: "English UK", quality: 400, latency: 100, networkRequired: false },
  { locale: "es-ES", name: "Spanish", quality: 300, latency: 200, networkRequired: true },
];

function makeTool() {
  mocks.module = { getVoices: async () => VOICES };
  return createListVoicesTool({
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

describe("listVoices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.module = null;
  });

  it("returns installed voices with a language list", async () => {
    const out = (await execute(makeTool(), {})) as Record<string, unknown>;

    expect(out).toEqual({
      count: 3,
      languages: ["en-GB", "en-US", "es-ES"],
      voices: VOICES,
    });
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "listVoices", status: "completed" }),
    );
  });

  it("filters by language prefix", async () => {
    const out = (await execute(makeTool(), { language: "en" })) as {
      count: number;
      languages: string[];
    };

    expect(out.count).toBe(2);
    expect(out.languages).toEqual(["en-GB", "en-US"]);
  });

  it("fails clearly without the native module", async () => {
    mocks.module = null;
    const tool = createListVoicesTool({
      repository: {} as never,
      onRecord: mocks.onRecord,
    });

    await expect(execute(tool, {})).rejects.toThrow(/local TTS module/);
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "listVoices", status: "failed" }),
    );
  });
});
