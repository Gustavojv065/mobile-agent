import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  onRecord: vi.fn(),
}));

// The real service pulls in native modules that cannot load under vitest; the
// tool only needs the text-file check, so mirror its mime/extension rule.
vi.mock("@/core/services/workspace-file-service", () => ({
  isTextWorkspaceFile: (file: { displayName: string; mimeType: string | null }) =>
    file.mimeType?.startsWith("text/") === true ||
    file.displayName.toLowerCase().endsWith(".md"),
}));

const { createListFilesTool } = await import(
  "@/modules/tools/built-in/list-files"
);

const FILES = [
  {
    id: "f1",
    displayName: "notes.md",
    mimeType: "text/markdown",
    size: 12,
    relativePath: "f1-notes.md",
    sourceKind: "created",
  },
  {
    id: "f2",
    displayName: "clip.mp4",
    mimeType: "video/mp4",
    size: 4096,
    relativePath: "f2-clip.mp4",
    sourceKind: "created",
  },
];

type ListFilesOutput = {
  files: { id: string; displayName: string; isText: boolean }[];
  returned: number;
  total: number;
  truncated: boolean;
};

function makeTool() {
  return createListFilesTool({
    repository: { list: mocks.list } as never,
    onRecord: mocks.onRecord,
  });
}

async function execute(input: object = {}): Promise<ListFilesOutput> {
  const definition = makeTool() as unknown as {
    execute: (input: object, opts: object) => Promise<ListFilesOutput>;
  };
  return definition.execute(input, {});
}

describe("listFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists workspace files with totals and per-file text flags", async () => {
    mocks.list.mockResolvedValue(FILES);

    const output = await execute();

    expect(output.total).toBe(2);
    expect(output.returned).toBe(2);
    expect(output.truncated).toBe(false);
    expect(output.files).toEqual([
      expect.objectContaining({ id: "f1", displayName: "notes.md", isText: true }),
      expect.objectContaining({ id: "f2", displayName: "clip.mp4", isText: false }),
    ]);
  });

  // Regression: an undocumented `query` used to filter with a substring match,
  // so a glob-style `query: "*"` returned no files and the model reported the
  // workspace as empty.
  it("ignores any argument, so a glob-style call cannot empty the list", async () => {
    mocks.list.mockResolvedValue(FILES);

    const output = await execute({ query: "*" });

    expect(output.total).toBe(2);
    expect(output.returned).toBe(2);
    expect(output.files).toHaveLength(2);
  });

  it("caps the list at 100 entries but still reports the real total", async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      id: `f${index}`,
      displayName: `file-${index}.md`,
      mimeType: "text/plain",
      size: index,
      relativePath: `f${index}-file-${index}.md`,
      sourceKind: "created",
    }));
    mocks.list.mockResolvedValue(many);

    const output = await execute();

    expect(output).toMatchObject({ total: 120, returned: 100, truncated: true });
    expect(output.files).toHaveLength(100);
  });

  it("records a titled preview with the file list and a compact summary", async () => {
    mocks.list.mockResolvedValue(FILES);

    await execute();

    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "listFiles",
        status: "completed",
        preview: {
          title: "2 files",
          text: "notes.md\nclip.mp4",
          truncated: false,
        },
      }),
    );

    const record = mocks.onRecord.mock.calls[0][0] as { outputSummary: string };
    expect(record.outputSummary).toContain('"total": 2');
    expect(record.outputSummary).toContain('"files": [');
  });

  it("marks a truncated preview so the trace says the list is partial", async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      id: `f${index}`,
      displayName: `file-${index}.md`,
      mimeType: "text/plain",
      size: index,
      relativePath: `f${index}-file-${index}.md`,
      sourceKind: "created",
    }));
    mocks.list.mockResolvedValue(many);

    await execute();

    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({ title: "120 files", truncated: true }),
      }),
    );
  });

  it("reports an empty workspace as total 0 rather than a bare empty array", async () => {
    mocks.list.mockResolvedValue([]);

    const output = await execute();

    expect(output).toMatchObject({ total: 0, returned: 0, files: [] });
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({ title: "0 files" }),
      }),
    );
  });

  it("records a failed run when the repository throws", async () => {
    mocks.list.mockRejectedValue(new Error("database closed"));

    await expect(execute()).rejects.toThrow("database closed");
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "listFiles", status: "failed" }),
    );
  });
});
