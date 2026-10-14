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
const { createCreateFileTool } = await import(
  "@/modules/tools/built-in/create-file"
);
const { createReadTool } = await import("@/modules/tools/built-in/read");
const { buildDocument } = await import("@/modules/documents");

function makeRepository() {
  const rows = new Map<string, import("@/core/types/app-state").WorkspaceFile>();
  const sectionsByFile = new Map<
    string,
    import("@/core/types/app-state").DocumentSection[]
  >();

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
        sourceSpec: input.sourceSpec ?? null,
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
        sourceSpec?: string | null;
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
        sourceSpec:
          input.sourceSpec !== undefined
            ? input.sourceSpec
            : current.sourceSpec,
        updatedAt: input.updatedAt ?? current.updatedAt,
      });
    },
    async replaceDocumentSections(
      fileId: string,
      sections: { title: string; level: number; body: string }[],
    ) {
      const now = "2026-01-01T00:00:00.000Z";
      sectionsByFile.set(
        fileId,
        sections.map((section, position) => ({
          id: `${fileId}-${position}`,
          fileId,
          position,
          title: section.title,
          level: section.level,
          body: section.body,
          charCount: section.body.length,
          createdAt: now,
          updatedAt: now,
        })),
      );
    },
    async listDocumentSections(fileId: string) {
      return sectionsByFile.get(fileId) ?? [];
    },
    getByIds: vi.fn(async () => []),
    list: vi.fn(async () => []),
    deleteAll: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  } as unknown as WorkspaceRepository;

  return { repository, rows, sectionsByFile };
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

  it("persists a spec parameter into the stored source front-matter", async () => {
    const { repository } = makeRepository();
    const created = await seedDocument(repository);
    const updateDocument = createUpdateDocumentTool({ repository });

    await updateDocument.execute!(
      {
        fileId: created.id,
        content: "# styled",
        spec: { page: { size: "LETTER" } },
      },
      {} as never,
    );

    const updated = await repository.getById(created.id);
    expect(updated?.sourceMarkdown).toContain("---");
    expect(updated?.sourceMarkdown).toContain("format:");
    expect(updated?.sourceMarkdown).toContain("LETTER");

    const zip = await JSZip.loadAsync(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${created.relativePath}`,
      )!.bytes,
    );
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain('w:pgSz w:w="12240"');
  });
});

describe("createFile tool with document specs", () => {
  beforeEach(() => {
    mocks.files.clear();
    vi.clearAllMocks();
  });

  it("persists a spec and builds a styled docx", async () => {
    const { repository } = makeRepository();
    const createFile = createCreateFileTool({ repository });

    const result = (await createFile.execute!(
      {
        name: "styled",
        content: "# Hello",
        format: "docx",
        spec: { fonts: { body: { family: "Georgia" } } },
      },
      {} as never,
    )) as { fileId: string };

    const file = await repository.getById(result.fileId);
    expect(file?.sourceMarkdown).toContain("---");
    expect(file?.sourceMarkdown).toContain("format:");
    expect(file?.sourceMarkdown).toContain("Georgia");

    const zip = await JSZip.loadAsync(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${file!.relativePath}`,
      )!.bytes,
    );
    const stylesXml = await zip.file("word/styles.xml")!.async("string");
    expect(stylesXml).toContain("Georgia");
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

describe("read tool style snapshots", () => {
  beforeEach(() => {
    mocks.files.clear();
    vi.clearAllMocks();
  });

  it("returns the captured styling for an imported docx", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);

    const original = await buildDocument({
      format: "docx",
      content: "# Imported\n\nOriginal body.",
      fileName: "original",
      spec: { fonts: { body: { family: "Georgia" } } },
    });

    const imported = await service.importBytesFile({
      bytes: original.bytes,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "imported.docx",
    });

    const read = createReadTool({ repository });
    const result = (await read.execute!(
      { fileId: imported.id },
      {} as never,
    )) as {
      content: string;
      sourceSpec?: { fonts?: { body?: { family?: string } } };
    };

    expect(result.content).toContain("Original body");
    expect(result.sourceSpec?.fonts?.body?.family).toBe("Georgia");
  });

  it("omits sourceSpec for documents without a snapshot", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);

    const built = await buildDocument({
      format: "docx",
      content: "# Report\n\nBody text.",
      fileName: "report",
    });
    const created = await service.createDocumentFile({
      bytes: built.bytes,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "report.docx",
    });

    const read = createReadTool({ repository });
    const result = (await read.execute!(
      { fileId: created.id },
      {} as never,
    )) as { content: string; sourceSpec?: unknown };

    expect(result.content).toContain("Body text");
    expect(result.sourceSpec).toBeUndefined();
  });
});

describe("read tool sections", () => {
  beforeEach(() => {
    mocks.files.clear();
    vi.clearAllMocks();
  });

  it("lists sections and returns the whole source", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const built = await buildDocument({
      format: "docx",
      content: SOURCE,
      fileName: "report",
    });
    const created = await service.createDocumentFile({
      bytes: built.bytes,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "report.docx",
      sourceMarkdown: SOURCE,
    });
    const read = createReadTool({ repository });

    const result = (await read.execute!({ fileId: created.id }, {} as never)) as {
      sourceMarkdown?: string;
      sections?: { index: number; title: string; level: number }[];
    };

    expect(result.sourceMarkdown).toBe(SOURCE);
    expect(result.sections?.map((entry) => entry.title)).toEqual([
      "Report",
      "Section A",
      "Section B",
    ]);
  });

  it("reads a single section by index", async () => {
    const { repository } = makeRepository();
    const created = await seedDocument(repository);
    const read = createReadTool({ repository });

    const result = (await read.execute!(
      { fileId: created.id, section: 1 },
      {} as never,
    )) as unknown as {
      content: string;
      section: { index: number; title: string; level: number };
      sections: { title: string }[];
      sourceMarkdown?: string;
    };

    expect(result.content).toBe("## Section A\n\nOriginal paragraph text.\n");
    expect(result.section).toMatchObject({
      index: 1,
      title: "Section A",
      level: 2,
    });
    expect(result.sections.map((entry) => entry.title)).toEqual([
      "Report",
      "Section A",
      "Section B",
    ]);
    expect(result.sourceMarkdown).toBeUndefined();
  });

  it("fails for an out-of-range section", async () => {
    const { repository } = makeRepository();
    const created = await seedDocument(repository);
    const read = createReadTool({ repository });

    await expect(
      read.execute!({ fileId: created.id, section: 9 }, {} as never),
    ).rejects.toThrow(/no section at index 9/);
  });

  it("returns full text with a note when section is asked of a plain file", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const created = await service.createTextFile({
      content: "<html><body><canvas></canvas></body></html>",
      mimeType: "text/html",
      name: "scene.html",
    });
    const read = createReadTool({ repository });

    const result = (await read.execute!(
      { fileId: created.id, section: 0 },
      {} as never,
    )) as { content: string; note?: string };

    expect(result.content).toContain("<canvas>");
    expect(result.note).toMatch(/no heading sections/);
  });
});

describe("updateDocument tool sections", () => {
  beforeEach(() => {
    mocks.files.clear();
    vi.clearAllMocks();
  });

  type SectionResult = {
    sectionMode: string;
    section: number | null;
    sections: { title: string }[];
  };

  it("rewrites one section and regenerates the document", async () => {
    const { repository } = makeRepository();
    const created = await seedDocument(repository);
    const updateDocument = createUpdateDocumentTool({ repository });

    const result = (await updateDocument.execute!(
      {
        fileId: created.id,
        section: 1,
        content: "## Section A\n\nRewritten.",
      },
      {} as never,
    )) as unknown as SectionResult;

    expect(result.sectionMode).toBe("replace");
    expect(result.section).toBe(1);
    expect(result.sections.map((entry) => entry.title)).toEqual([
      "Report",
      "Section A",
      "Section B",
    ]);

    const updated = await repository.getById(created.id);
    expect(updated?.sourceMarkdown).toContain("Rewritten.");
    expect(updated?.sourceMarkdown).not.toContain("Original paragraph text");
    expect(updated?.sourceMarkdown).toContain("Keep this part.");

    const zip = await JSZip.loadAsync(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${created.relativePath}`,
      )!.bytes,
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Rewritten.");
  });

  it("appends and deletes sections", async () => {
    const { repository } = makeRepository();
    const created = await seedDocument(repository);
    const updateDocument = createUpdateDocumentTool({ repository });

    const appended = (await updateDocument.execute!(
      {
        fileId: created.id,
        sectionMode: "append",
        content: "## Appendix\n\nExtra.",
      },
      {} as never,
    )) as unknown as SectionResult;
    expect(appended.sections.map((entry) => entry.title)).toEqual([
      "Report",
      "Section A",
      "Section B",
      "Appendix",
    ]);

    const deleted = (await updateDocument.execute!(
      { fileId: created.id, sectionMode: "delete", section: 0 },
      {} as never,
    )) as unknown as SectionResult;
    expect(deleted.sections.map((entry) => entry.title)).toEqual([
      "Section A",
      "Section B",
      "Appendix",
    ]);

    const updated = await repository.getById(created.id);
    expect(updated?.sourceMarkdown).not.toContain("# Report");
    expect(updated?.sourceMarkdown).toContain("Keep this part.");
  });

  it("requires content or a section operation", async () => {
    const { repository } = makeRepository();
    const created = await seedDocument(repository);
    const updateDocument = createUpdateDocumentTool({ repository });

    await expect(
      updateDocument.execute!({ fileId: created.id }, {} as never),
    ).rejects.toThrow(/content is required to replace the whole document/);

    await expect(
      updateDocument.execute!({ fileId: created.id, section: 0 }, {} as never),
    ).rejects.toThrow(/content is required for section mode replace/);
  });

  it("rejects section edits for documents without stored source", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const imported = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "imported.docx",
    });
    const updateDocument = createUpdateDocumentTool({ repository });

    await expect(
      updateDocument.execute!(
        { fileId: imported.id, section: 0, content: "# New" },
        {} as never,
      ),
    ).rejects.toThrow(/no stored source/);
  });
});