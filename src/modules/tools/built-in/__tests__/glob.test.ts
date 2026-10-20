import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  onRecord: vi.fn(),
}));

// search-core is pure, so this tool loads without any native stubbing.
const { createGlobTool } = await import("@/modules/tools/built-in/glob");

const FILES = [
  { id: "f1", displayName: "a.ts", relativePath: "src/a.ts" },
  { id: "f2", displayName: "b.md", relativePath: "docs/b.md" },
  { id: "f3", displayName: "c.ts", relativePath: "c.ts" },
];

async function execute(input: object) {
  const definition = createGlobTool({
    repository: { list: mocks.list } as never,
    onRecord: mocks.onRecord,
  }) as unknown as {
    execute: (input: object, opts: object) => Promise<{ files: string[] }>;
  };
  return definition.execute(input, {});
}

describe("glob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns matching paths and previews them in the trace", async () => {
    mocks.list.mockResolvedValue(FILES);

    const output = await execute({ pattern: "**/*.ts" });

    expect(output.files).toEqual(["src/a.ts", "c.ts"]);
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "glob",
        status: "completed",
        preview: {
          title: "2 files",
          text: "src/a.ts\nc.ts",
          truncated: false,
        },
      }),
    );
  });

  it("previews an empty result as 0 files", async () => {
    mocks.list.mockResolvedValue(FILES);

    const output = await execute({ pattern: "*.pdf" });

    expect(output.files).toEqual([]);
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({ title: "0 files", text: "" }),
      }),
    );
  });

  it("records a failed run when the repository throws", async () => {
    mocks.list.mockRejectedValue(new Error("database closed"));

    await expect(execute({ pattern: "*" })).rejects.toThrow("database closed");
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "glob", status: "failed" }),
    );
  });
});
