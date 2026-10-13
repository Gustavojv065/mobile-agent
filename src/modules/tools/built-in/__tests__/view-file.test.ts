import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  onRecord: vi.fn(),
  bytes: vi.fn(),
  exists: true,
}));

vi.mock("@/core/services/workspace-file-service", () => ({
  resolveWorkspaceFile: () => ({
    get exists() {
      return mocks.exists;
    },
    bytes: mocks.bytes,
  }),
}));

const { createViewFileTool } = await import(
  "@/modules/tools/built-in/view-file"
);

function makeTool(supportsImageInput = true) {
  return createViewFileTool({
    repository: { getById: mocks.getById } as never,
    onRecord: mocks.onRecord,
    supportsImageInput,
  });
}

async function execute(tool: ReturnType<typeof makeTool>, input: object) {
  const def = tool as unknown as {
    execute: (input: object, opts: object) => Promise<unknown>;
  };
  return def.execute(input, {});
}

describe("viewFile (workspace)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exists = true;
  });

  it("passes image bytes inline on vision-capable models", async () => {
    mocks.getById.mockResolvedValue({
      id: "img-1",
      displayName: "photo.jpg",
      mimeType: "image/jpeg",
      relativePath: "img-1/photo.jpg",
    });
    mocks.bytes.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const output = (await execute(makeTool(true), {
      fileId: "img-1",
    })) as Record<string, unknown>;

    expect(output).toMatchObject({
      fileId: "img-1",
      displayName: "photo.jpg",
      mimeType: "image/jpeg",
      inlineFile: true,
    });
    expect(output.file).toEqual(new Uint8Array([1, 2, 3]));

    const tool = makeTool(true) as unknown as {
      toModelOutput: (args: {
        output: Record<string, unknown>;
      }) => { type: string; value: unknown[] };
    };
    const modelOutput = tool.toModelOutput({
      output,
    }) as { type: string; value: Array<Record<string, unknown>> };

    expect(modelOutput.type).toBe("content");
    expect(modelOutput.value[1]).toMatchObject({
      type: "file",
      mediaType: "image/jpeg",
    });
  });

  it("passes non-image files even without image input (model handles)", async () => {
    mocks.getById.mockResolvedValue({
      id: "doc-1",
      displayName: "report.pdf",
      mimeType: "application/pdf",
      relativePath: "doc-1/report.pdf",
    });
    mocks.bytes.mockResolvedValue(new Uint8Array([4, 5]));

    const output = (await execute(makeTool(false), {
      fileId: "doc-1",
    })) as Record<string, unknown>;

    expect(output).toMatchObject({ inlineFile: true });
    expect(output.file).toEqual(new Uint8Array([4, 5]));
  });

  it("falls back to text with ocr guidance for images on non-vision models", async () => {
    mocks.getById.mockResolvedValue({
      id: "img-2",
      displayName: "scan.png",
      mimeType: "image/png",
      relativePath: "img-2/scan.png",
    });
    mocks.bytes.mockResolvedValue(new Uint8Array([6]));

    const tool = makeTool(false) as unknown as {
      execute: (input: object, opts: object) => Promise<Record<string, unknown>>;
      toModelOutput: (args: {
        output: Record<string, unknown>;
      }) => { type: string; value: string };
    };
    const output = await tool.execute({ fileId: "img-2" }, {});

    expect(output.file).toBeNull();
    expect(output.text).toMatch(/ocr/);
    expect(tool.toModelOutput({ output })).toMatchObject({ type: "text" });
  });

  it("fails clearly for unknown or missing files", async () => {
    mocks.getById.mockResolvedValue(null);
    await expect(execute(makeTool(true), { fileId: "nope" })).rejects.toThrow(
      /No workspace file found/,
    );

    mocks.getById.mockResolvedValue({
      id: "img-3",
      displayName: "gone.jpg",
      mimeType: "image/jpeg",
      relativePath: "img-3/gone.jpg",
    });
    mocks.exists = false;
    await expect(execute(makeTool(true), { fileId: "img-3" })).rejects.toThrow(
      /no longer available/,
    );
  });
});
