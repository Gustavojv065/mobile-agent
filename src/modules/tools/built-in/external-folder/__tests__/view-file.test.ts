import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onRecord: vi.fn(),
  readBytesFile: vi.fn(),
}));

vi.mock("@/core/services/external-folder/external-folder-service", () => ({
  createExternalFolderService: () => ({
    readBytesFile: mocks.readBytesFile,
  }),
}));

const { createExternalViewFileTool } = await import(
  "@/modules/tools/built-in/external-folder/view-file"
);

const SESSION = {
  uri: "content://folder",
  displayName: "Picked folder",
  platform: "android",
  sourceType: "external-folder",
  grantedAt: new Date().toISOString(),
} as never;

function makeTool(supportsImageInput = true, supportsAudioInput = false, supportsVideoInput = false) {
  return createExternalViewFileTool({
    session: SESSION,
    onRecord: mocks.onRecord,
    supportsImageInput,
    supportsAudioInput,
    supportsVideoInput,
  });
}

async function execute(tool: ReturnType<typeof makeTool>, input: object) {
  const def = tool as unknown as {
    execute: (input: object, opts: object) => Promise<unknown>;
  };
  return def.execute(input, {});
}

describe("viewFile (external folder)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes folder image bytes inline via path", async () => {
    mocks.readBytesFile.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/jpeg",
    });

    const output = (await execute(makeTool(true), {
      path: "photos/a.jpg",
    })) as Record<string, unknown>;

    expect(mocks.readBytesFile).toHaveBeenCalledWith(
      SESSION,
      "photos/a.jpg",
    );
    expect(output).toMatchObject({
      path: "photos/a.jpg",
      mimeType: "image/jpeg",
      inlineFile: true,
    });

    const tool = makeTool(true) as unknown as {
      toModelOutput: (args: {
        output: Record<string, unknown>;
      }) => { type: string; value: unknown[] };
    };
    const modelOutput = tool.toModelOutput({ output }) as {
      type: string;
      value: Record<string, unknown>[];
    };

    expect(modelOutput.type).toBe("content");
    expect(modelOutput.value[1]).toMatchObject({
      type: "file",
      mediaType: "image/jpeg",
    });
  });

  it("passes non-image files even without image input", async () => {
    mocks.readBytesFile.mockResolvedValue({
      bytes: new Uint8Array([7, 8]),
      mimeType: "application/pdf",
    });

    const output = (await execute(makeTool(false), {
      path: "docs/report.pdf",
    })) as Record<string, unknown>;

    expect(output).toMatchObject({ inlineFile: true });
    expect(output.file).toEqual(new Uint8Array([7, 8]));
  });

  it("rejects oversized files instead of OOMing", async () => {
    mocks.readBytesFile.mockResolvedValue({
      bytes: new Uint8Array(21_000_000),
      mimeType: "image/jpeg",
    });

    await expect(
      execute(makeTool(true), { path: "big.jpg" }),
    ).rejects.toThrow(/too large/);
  });

  it.each(["clips/a.mp4", "audio/a.mp3"])("does not read unsupported media at %s", async (path) => {
    const tool = makeTool();
    const output = await execute(tool, { path }) as any;
    expect(output.inlineFile).toBe(false);
    expect(output.file).toBeNull();
    expect(mocks.readBytesFile).not.toHaveBeenCalled();
    expect(output.text).toContain("importFolderFileToWorkspace");
    expect(output.text).toContain("Do not retry viewFile");
    expect((tool as any).toModelOutput({ output }).type).toBe("text");
  });

  it("checks the actual MIME even when the filename hides the video type", async () => {
    mocks.readBytesFile.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "video/mp4" });
    const output = await execute(makeTool(), { path: "clip.bin" }) as any;
    expect(output.file).toBeNull();
    expect(output.text).toContain("getVideoFrame");
  });

  it.each(["video/mp4", "audio/mpeg"])("passes supported %s inline", async (mimeType) => {
    mocks.readBytesFile.mockResolvedValue({ bytes: new Uint8Array([9]), mimeType });
    const output = await execute(makeTool(false, true, true), { path: "clip.bin" }) as any;
    expect(output.inlineFile).toBe(true);
    expect(output.file).toEqual(new Uint8Array([9]));
  });
});
