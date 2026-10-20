import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  onRecord: vi.fn(),
}));

// grep reads file text through the workspace service, which pulls in native
// modules; stub the single method it uses.
vi.mock("@/core/services/workspace-file-service", () => ({
  createWorkspaceFileService: () => ({
    readWorkspaceFileText: async (file: { relativePath: string }) =>
      file.relativePath === "src/a.ts"
        ? "const answer = 42;\nconst other = 1;"
        : "nothing to see",
  }),
}));

const { createGrepTool } = await import("@/modules/tools/built-in/grep");

const FILES = [
  { id: "f1", displayName: "a.ts", relativePath: "src/a.ts" },
  { id: "f2", displayName: "b.md", relativePath: "docs/b.md" },
];

async function execute(input: object) {
  const definition = createGrepTool({
    repository: { list: mocks.list } as never,
    onRecord: mocks.onRecord,
  }) as unknown as {
    execute: (
      input: object,
      opts: object,
    ) => Promise<{ matches: unknown[]; truncated: boolean }>;
  };
  return definition.execute(input, {});
}

describe("grep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns matches and previews the match lines in the trace", async () => {
    mocks.list.mockResolvedValue(FILES);

    const output = await execute({ query: "answer", includeContent: true });

    expect(output.matches).toHaveLength(1);
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "grep",
        status: "completed",
        preview: expect.objectContaining({ title: "1 match" }),
      }),
    );

    const record = mocks.onRecord.mock.calls[0][0] as {
      preview: { text: string };
    };
    expect(record.preview.text).toContain("const answer = 42");
  });

  it("previews an empty result as 0 matches", async () => {
    mocks.list.mockResolvedValue(FILES);

    await execute({ query: "zzz-no-such-text" });

    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({ title: "0 matches" }),
      }),
    );
  });

  it("records a failed run when the repository throws", async () => {
    mocks.list.mockRejectedValue(new Error("database closed"));

    await expect(execute({ query: "answer" })).rejects.toThrow(
      "database closed",
    );
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "grep", status: "failed" }),
    );
  });
});
