import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceRepository } from "@/core/db/repositories/types";

const mocks = vi.hoisted(() => ({
  files: new Map<string, { bytes: Uint8Array }>(),
  uuid: "00000000-0000-4000-8000-000000000000",
}));

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => mocks.uuid),
}));

vi.mock("expo-file-system", () => ({
  Paths: { document: "file:///document" },
  Directory: class {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri))
        .join("/");
    }
    get exists() {
      return true;
    }
    create() {}
  },
  File: class {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri))
        .join("/");
    }
    get exists() {
      return mocks.files.has(this.uri);
    }
    get size() {
      return mocks.files.get(this.uri)?.bytes.byteLength ?? null;
    }
    create() {}
    write(data: string | Uint8Array) {
      const bytes =
        typeof data === "string" ? new TextEncoder().encode(data) : data;
      mocks.files.set(this.uri, { bytes });
    }
    async bytes() {
      return mocks.files.get(this.uri)?.bytes ?? new Uint8Array(0);
    }
    async text() {
      const bytes = mocks.files.get(this.uri)?.bytes ?? new Uint8Array(0);
      return new TextDecoder().decode(bytes);
    }
    delete() {
      mocks.files.delete(this.uri);
    }
  },
}));

const { createWorkspaceFileService } = await import(
  "@/core/services/workspace-file-service"
);
const { createUpdateDocumentTool } = await import(
  "@/modules/tools/built-in/update-document"
);
const { createEditTool } = await import("@/modules/tools/built-in/edit");

function makeRepository() {
  const rows = new Map<string, import("@/core/types/app-state").WorkspaceFile>();

  const repository = {
    async create(input: Parameters<WorkspaceRepository["create"]>[0]) {
      const now = "2026-01-01T00:00:00.000Z";
      const row = {
        id: input.id ?? `file-${rows.size + 1}`,
        displayName: input.displayName,
        originalName: input.originalName ?? null,
        mimeType: input.mimeType ?? null,
        size: input.size ?? null,
        relativePath: input.relativePath,
        sourceKind: input.sourceKind,
        sourceMarkdown: input.sourceMarkdown ?? null,
        createdAt: now,
        updatedAt: now,
      } as import("@/core/types/app-state").WorkspaceFile;
      rows.set(row.id, row);
      return row;
    },
    async getById(id: string) {
      return rows.get(id) ?? null;
    },
    async updateMetadata(
      id: string,
      input: {
        displayName?: string;
        mimeType?: string | null;
        originalName?: string | null;
        relativePath?: string;
        size?: number | null;
        sourceMarkdown?: string | null;
        updatedAt?: string;
      },
    ) {
      const current = rows.get(id);
      if (!current) {
        return;
      }
      rows.set(id, {
        ...current,
        displayName: input.displayName ?? current.displayName,
        size: input.size !== undefined ? input.size : current.size,
        sourceMarkdown:
          input.sourceMarkdown !== undefined
            ? input.sourceMarkdown
            : current.sourceMarkdown,
        updatedAt: input.updatedAt ?? current.updatedAt,
      });
    },
    getByIds: vi.fn(async () => []),
    list: vi.fn(async () => []),
    deleteAll: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  } as unknown as WorkspaceRepository;

  return { repository, rows };
}

const SOURCE = `# Report

## Section A

Original paragraph text.

## Section B

Keep this part.
`;

async function seedDocument(repository: WorkspaceRepository) {
  const service = createWorkspaceFileService(repository);
  return service.createDocumentFile({
    bytes: new Uint8Array([0x50, 0x4b]),
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    name: "report.docx",
    sourceMarkdown: SOURCE,
  });
}

describe("updateDocument tool", () => {
  beforeEach(() => {
    mocks.files.clear();
    vi.clearAllMocks();
  });

  it("regenerates a document in place and reports the updated file", async () => {
    const { repository } = makeRepository();
    const created = await seedDocument(repository);
    const updateDocument = createUpdateDocumentTool({ repository });

    const result = await updateDocument.execute!(
      { fileId: created.id, content: `${SOURCE}\n\n## Added\n\nNew content.` },
      {} as never,
    );

    expect(result).toMatchObject({
      fileId: created.id,
      displayName: "report.docx",
      format: "docx",
      link: `workspace://${created.id}`,
    });
    expect((result as { size: number | null }).size).toBeGreaterThan(2);

    const updated = await repository.getById(created.id);
    expect(updated?.sourceMarkdown).toContain("## Added");

    const zip = await JSZip.loadAsync(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${created.relativePath}`,
      )!.bytes,
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("New content");
  });

  it("fails for an unknown fileId", async () => {
    const { repository } = makeRepository();
    const updateDocument = createUpdateDocumentTool({ repository });

    await expect(
      updateDocument.execute!(
        { fileId: "missing", content: "# x" },
        {} as never,
      ),
    ).rejects.toThrow("No workspace file found");
  });

  it("fails for non-document files", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const textFile = await service.createTextFile({
      name: "notes.txt",
      content: "hello",
    });
    const updateDocument = createUpdateDocumentTool({ repository });

    await expect(
      updateDocument.execute!(
        { fileId: textFile.id, content: "# x" },
        {} as never,
      ),
    ).rejects.toThrow("not a supported document");
  });

  it("records the tool execution", async () => {
    const { repository } = makeRepository();
    const created = await seedDocument(repository);
    const onRecord = vi.fn();
    const updateDocument = createUpdateDocumentTool({ repository, onRecord });

    await updateDocument.execute!(
      { fileId: created.id, content: "# fresh" },
      {} as never,
    );

    const record = onRecord.mock.calls[0][0] as { toolName: string };
    expect(record.toolName).toBe("updateDocument");
  });
});

describe("edit tool on documents", () => {
  beforeEach(() => {
    mocks.files.clear();
    vi.clearAllMocks();
  });

  it("applies edits to the stored source and regenerates the document", async () => {
    const { repository } = makeRepository();
    const created = await seedDocument(repository);
    const edit = createEditTool({ repository });

    const result = await edit.execute!(
      {
        fileId: created.id,
        edits: [
          {
            oldText: "Original paragraph text.",
            newText: "Updated paragraph text.",
          },
        ],
      },
      {} as never,
    );

    expect(result).toMatchObject({
      fileId: created.id,
      editsApplied: 1,
      regenerated: true,
    });

    const updated = await repository.getById(created.id);
    expect(updated?.sourceMarkdown).toContain("Updated paragraph text");
    expect(updated?.sourceMarkdown).not.toContain("Original paragraph text");

    const zip = await JSZip.loadAsync(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${created.relativePath}`,
      )!.bytes,
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Updated paragraph text");
  });

  it("rejects documents without stored source with a helpful error", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const created = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "imported.docx",
    });
    const edit = createEditTool({ repository });

    await expect(
      edit.execute!(
        {
          fileId: created.id,
          edits: [{ oldText: "x", newText: "y" }],
        },
        {} as never,
      ),
    ).rejects.toThrow("no stored source");
  });

  it("still edits text files through the existing path", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const textFile = await service.createTextFile({
      name: "notes.txt",
      content: "alpha\nbeta",
    });
    const edit = createEditTool({ repository });

    const result = await edit.execute!(
      {
        fileId: textFile.id,
        edits: [{ oldText: "beta", newText: "gamma" }],
      },
      {} as never,
    );

    expect(result).toMatchObject({ fileId: textFile.id, editsApplied: 1 });
    const after = await repository.getById(textFile.id);
    expect(after?.size).toBe("alpha\ngamma".length);
  });
});