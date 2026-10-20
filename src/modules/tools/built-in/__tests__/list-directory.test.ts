import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listEntries: vi.fn(),
  onRecord: vi.fn(),
}));

// The external-folder service is native-backed; stub the single method used.
vi.mock("@/core/services/external-folder/external-folder-service", () => ({
  createExternalFolderService: () => ({ listEntries: mocks.listEntries }),
}));

const { createListDirectoryTool } = await import(
  "@/modules/tools/built-in/external-folder/list-directory"
);

const ENTRIES = [
  { kind: "directory", mimeType: null, name: "docs", path: "docs", size: null },
  {
    kind: "file",
    mimeType: "text/plain",
    name: "a.md",
    path: "docs/a.md",
    size: 12,
  },
];

async function execute(input: object) {
  const definition = createListDirectoryTool({
    session: {} as never,
    onRecord: mocks.onRecord,
  }) as unknown as {
    execute: (
      input: object,
      opts: object,
    ) => Promise<{ entries: { path: string }[] }>;
  };
  return definition.execute(input, {});
}

describe("listDirectory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists entries and previews their paths in the trace", async () => {
    mocks.listEntries.mockReturnValue(ENTRIES);

    const output = await execute({});

    expect(output.entries).toHaveLength(2);
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "listDirectory",
        status: "completed",
        preview: {
          title: "2 entries",
          text: "docs\ndocs/a.md",
          truncated: false,
        },
      }),
    );
  });

  it("previews an empty directory as 0 entries", async () => {
    mocks.listEntries.mockReturnValue([]);

    const output = await execute({ path: "docs" });

    expect(output.entries).toEqual([]);
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({ title: "0 entries", text: "" }),
      }),
    );
  });

  it("records a failed run when the folder is gone", async () => {
    mocks.listEntries.mockImplementation(() => {
      throw new Error("The granted folder is no longer available.");
    });

    await expect(execute({})).rejects.toThrow(
      "The granted folder is no longer available.",
    );
    expect(mocks.onRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "listDirectory",
        status: "failed",
      }),
    );
  });
});
