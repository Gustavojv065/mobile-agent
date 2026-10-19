import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReadTool } from "../read";
import { createEditTool } from "../edit";
import { createWriteTool } from "../write";
import { createExternalReadTool } from "../external-folder/read";
import { createExternalEditTool } from "../external-folder/edit";

const mocks = vi.hoisted(() => ({
  onRecord: vi.fn(), getById: vi.fn(), readTextFile: vi.fn(),
  readWorkspaceFileText: vi.fn(), writeTextFile: vi.fn(),
  listDocumentSections: vi.fn(), readDocumentSection: vi.fn(),
}));
vi.mock("@/core/services/workspace-file-service", () => ({
  createWorkspaceFileService: () => mocks,
  isTextWorkspaceFile: () => true,
  isDocumentWorkspaceFile: () => false,
  parseStoredSourceSpec: () => null,
}));
vi.mock("@/core/services/external-folder/external-folder-service", () => ({
  createExternalFolderService: () => mocks,
}));


const params = { repository: { getById: mocks.getById } as never, onRecord: mocks.onRecord };
async function run(definition: unknown, input: unknown) {
  return (definition as { execute: (input: unknown, options: object) => Promise<unknown> }).execute(input, {});
}

describe("captured trace content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getById.mockResolvedValue({ id: "file", displayName: "notes.txt" });
    mocks.listDocumentSections.mockResolvedValue([]);
    mocks.readTextFile.mockResolvedValue("Original text");
    mocks.writeTextFile.mockResolvedValue({ id: "file", displayName: "notes.txt" });
  });

  it("captures the actual paged read rather than its 200-character JSON summary", async () => {
    mocks.readWorkspaceFileText.mockResolvedValue("a".repeat(1000));
    await run(createReadTool(params), { fileId: "file", offset: 100, maxChars: 500 });
    expect(mocks.onRecord.mock.calls[0][0].preview).toEqual({ title: "notes.txt", text: "a".repeat(500), truncated: true });
  });

  it("captures a section with a bounded preview", async () => {
    mocks.listDocumentSections.mockResolvedValue([{ position: 0, title: "Heading", body: "section", charCount: 7 }]);
    mocks.readDocumentSection.mockResolvedValue({ body: "x".repeat(22000) });
    await run(createReadTool(params), { fileId: "file", section: 0 });
    expect(mocks.onRecord.mock.calls[0][0].preview.text).toHaveLength(20000);
    expect(mocks.onRecord.mock.calls[0][0].preview.truncated).toBe(true);
  });

  it("captures the edit diff and resulting content at execution time", async () => {
    await run(createEditTool(params), { fileId: "file", edits: [{ oldText: "Original", newText: "Updated" }] });
    const record = mocks.onRecord.mock.calls[0][0];
    expect(record.preview.text).toBe("Updated text");
    expect(record.diff).toContain("-Original text");
    expect(record.diff).toContain("+Updated text");
    expect(record.diffStat).toBe("+1 −1");
  });

  it("caps written content stored in message metadata", async () => {
    await run(createWriteTool(params), { fileId: "file", content: "x".repeat(25000), mode: "overwrite" });
    expect(mocks.onRecord.mock.calls[0][0].preview).toMatchObject({ truncated: true });
    expect(mocks.onRecord.mock.calls[0][0].preview.text).toHaveLength(20000);
  });

  it("captures folder reads and diffs too", async () => {
    const folderParams = { session: {} as never, onRecord: mocks.onRecord };
    await run(createExternalReadTool(folderParams), { path: "notes.txt" });
    expect(mocks.onRecord.mock.calls[0][0].preview.text).toBe("Original text");
    await run(createExternalEditTool(folderParams), { path: "notes.txt", edits: [{ oldText: "Original", newText: "Updated" }] });
    expect(mocks.onRecord.mock.calls[1][0].diff).toContain("+Updated text");
  });
});
