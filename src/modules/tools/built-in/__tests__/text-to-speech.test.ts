import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolExecutionRecord } from "@/core/types/app-state";

const mocks = vi.hoisted(() => ({
  synthesizeNarrationParts: vi.fn(),
  createWorkspaceFileService: vi.fn(),
  onRecord: vi.fn(),
}));

// The real orchestration reaches for the native TTS module; it has its own
// tests and is not loadable here.
vi.mock("@/modules/voice/local-tts", () => ({
  synthesizeNarrationParts: mocks.synthesizeNarrationParts,
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  createWorkspaceFileService: mocks.createWorkspaceFileService,
}));

const { createTextToSpeechTool } = await import(
  "@/modules/tools/built-in/text-to-speech"
);

const NARRATION = {
  parts: [
    {
      fileId: "narr-1",
      displayName: "intro.wav",
      link: "workspace://narr-1",
      start: 0,
      duration: 3.2,
    },
  ],
  totalDuration: 3.2,
  language: "en",
};

function makeTool() {
  mocks.synthesizeNarrationParts.mockResolvedValue(NARRATION);
  mocks.createWorkspaceFileService.mockReturnValue({ tag: "service" });
  return createTextToSpeechTool({
    repository: { tag: "repository" } as never,
    onRecord: mocks.onRecord,
  });
}

async function execute(tool: ReturnType<typeof makeTool>, input: object) {
  const def = tool as unknown as {
    execute: (input: object, opts: object) => Promise<unknown>;
  };
  return def.execute(input, {});
}

describe("textToSpeech", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("synthesizes the script and returns scheduled parts", async () => {
    const out = (await execute(makeTool(), {
      text: "Hello world.",
      language: "en",
      name: "intro",
    })) as Record<string, unknown>;

    expect(mocks.createWorkspaceFileService).toHaveBeenCalledWith({
      tag: "repository",
    });
    expect(mocks.synthesizeNarrationParts).toHaveBeenCalledWith(
      "Hello world.",
      expect.objectContaining({
        language: "en",
        name: "intro",
        workspaceService: { tag: "service" },
      }),
    );
    expect(out).toEqual({
      partCount: 1,
      parts: NARRATION.parts,
      totalDuration: 3.2,
      language: "en",
    });
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "textToSpeech",
        status: "completed",
      }),
    );
  });

  it("passes rate and pitch through", async () => {
    await execute(makeTool(), {
      text: "Slow and low.",
      rate: 0.8,
      pitch: 1.2,
    });
    expect(mocks.synthesizeNarrationParts).toHaveBeenCalledWith(
      "Slow and low.",
      expect.objectContaining({ rate: 0.8, pitch: 1.2 }),
    );
  });

  it("records a failure when synthesis throws", async () => {
    const records: ToolExecutionRecord[] = [];
    mocks.onRecord.mockImplementation((record: ToolExecutionRecord) =>
      records.push(record),
    );
    mocks.synthesizeNarrationParts.mockRejectedValue(
      new Error('The on-device voice for "xx" is not installed.'),
    );

    const tool = createTextToSpeechTool({
      repository: {} as never,
      onRecord: mocks.onRecord,
    });
    await expect(
      (tool as unknown as { execute: (i: object, o: object) => Promise<unknown> }).execute(
        { text: "Hi.", language: "xx" },
        {},
      ),
    ).rejects.toThrow(/not installed/);
    expect(records.at(-1)).toMatchObject({
      toolName: "textToSpeech",
      status: "failed",
    });
  });
});
