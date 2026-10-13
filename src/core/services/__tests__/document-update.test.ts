import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WorkspaceFile,
  WorkspaceFileSourceKind,
} from "@/core/types/app-state";
import type { WorkspaceRepository } from "@/core/db/repositories/types";
import { buildDocument } from "@/modules/documents";

const mocks = vi.hoisted(() => ({
  files: new Map<string, { bytes: Uint8Array }>(),
  nextId: 1,
  uuid: "00000000-0000-4000-8000-000000000000",
}));

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => mocks.uuid),
}));

vi.mock("expo-file-system", () => ({
  Paths: {
    document: "file:///document",
    get availableDiskSpace() {
      return 1_000_000_000;
    },
  },
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
    async copy(destination: { uri: string }, _options?: unknown) {
      const source = mocks.files.get(this.uri);
      if (source) mocks.files.set(destination.uri, { bytes: source.bytes });
    }
    async move(destination: { uri: string }, _options?: unknown) {
      const source = mocks.files.get(this.uri);
      if (source) mocks.files.set(destination.uri, { bytes: source.bytes });
      mocks.files.delete(this.uri);
    }
    static async downloadFileAsync() {}
  },
}));

const { createWorkspaceFileService } = await import(
  "@/core/services/workspace-file-service"
);

function makeRepository() {
  const rows = new Map<string, WorkspaceFile>();
  const sectionsByFile = new Map<
    string,
    import("@/core/types/app-state").DocumentSection[]
  >();

  const repository = {
    async create(input: {
      displayName: string;
      mimeType?: string | null;
      originalName?: string | null;
      relativePath: string;
      size?: number | null;
      sourceKind: WorkspaceFileSourceKind;
      sourceMarkdown?: string | null;
      sourceSpec?: string | null;
    }) {
      const now = "2026-01-01T00:00:00.000Z";
      const row: WorkspaceFile = {
        id: String(mocks.nextId++),
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
      };
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
        mimeType:
          input.mimeType !== undefined ? input.mimeType : current.mimeType,
        originalName:
          input.originalName !== undefined
            ? input.originalName
            : current.originalName,
        relativePath: input.relativePath ?? current.relativePath,
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

const SOURCE = `# Progress Report

Quarterly summary of the team.

## Highlights

- Shipped the mobile agent
- Added document support

## Metrics

| Metric | Value |
| --- | --- |
| Releases | 12 |
| Issues closed | 340 |
`;

describe("workspace document create + update", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.nextId = 1;
    vi.clearAllMocks();
  });

  it("stores the source markdown when creating a document", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const file = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "report.docx",
      sourceMarkdown: SOURCE,
    });

    expect(file.sourceMarkdown).toBe(SOURCE);
    expect(file.displayName).toBe("report.docx");
    expect(file.size).toBe(2);
  });

  it("moves a finished file into the workspace without loading its bytes", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);
    const { File } = await import("expo-file-system");

    const sourceUri = "file:///cache/video.mp4";
    mocks.files.set(sourceUri, { bytes: new Uint8Array([1, 2, 3, 4, 5]) });
    const source = new File(sourceUri);

    const created = await service.createDocumentFileFromFile({
      source: source as never,
      mimeType: "video/mp4",
      name: "clip.mp4",
    });

    expect(created.displayName).toBe("clip.mp4");
    expect(created.mimeType).toBe("video/mp4");
    expect(created.size).toBe(5);
    // Moved, not copied: the cache original is gone and the bytes were
    // never pulled into the JS heap (mock move transfers the entry).
    expect(mocks.files.has(sourceUri)).toBe(false);
  });

  it("regenerates a document in place for every format and keeps its name and path", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const created = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType: "application/pdf",
      name: "report.pdf",
      sourceMarkdown: SOURCE,
    });

    const updatedSource = `${SOURCE}\n## Updated\n\nRolled out to production.\n`;
    const updated = await service.updateDocumentFile(created, updatedSource);

    expect(updated.id).toBe(created.id);
    expect(updated.displayName).toBe("report.pdf");
    expect(updated.relativePath).toBe(created.relativePath);
    expect(updated.sourceMarkdown).toBe(updatedSource);
    expect(updated.size?.toString()).not.toBe("2");

    // The overwritten bytes are a valid pdf again.
    const pdf = await PDFDocument.load(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${created.relativePath}`,
      )!.bytes,
    );
    expect(pdf.getPageCount()).toBeGreaterThan(0);

    for (const format of ["docx", "pptx", "xlsx"] as const) {
      const doc = await service.createDocumentFile({
        bytes: new Uint8Array([0x50, 0x4b]),
        mimeType: `application/${format}`,
        name: `doc.${format}`,
        sourceMarkdown: SOURCE,
      });

      const next = await service.updateDocumentFile(doc, updatedSource);
      const nextBytes = mocks.files.get(
        `file:///document/mobile-agent/workspace/${next.relativePath}`,
      )!.bytes;

      expect(new TextDecoder().decode(nextBytes.subarray(0, 2))).toBe("PK");
      expect(next.sourceMarkdown).toBe(updatedSource);
    }
  });

  it("writes regenerated content into the binary for each format", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const created = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "doc.docx",
      sourceMarkdown: SOURCE,
    });

    const changed = `${SOURCE}\n\n## New Section\n\nThis text must round-trip.\n`;
    const updated = await service.updateDocumentFile(created, changed);

    const zip = await JSZip.loadAsync(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${updated.relativePath}`,
      )!.bytes,
    );
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain("New Section");
    expect(documentXml).toContain("This text must round-trip");
  });

  it("rejects updates for non-document files", async () => {
    const { repository, rows } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const textFile: WorkspaceFile = {
      id: "text-1",
      displayName: "notes.txt",
      originalName: null,
      mimeType: "text/plain",
      size: 3,
      relativePath: "text-1-notes.txt",
      sourceKind: "created",
      sourceMarkdown: null,
      sourceSpec: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    rows.set(textFile.id, textFile);

    await expect(
      service.updateDocumentFile(textFile, "# Not a document"),
    ).rejects.toThrow("not a supported document");
  });

  it("keeps the editable source in sync after repeated updates", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const created = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType: "application/pdf",
      name: "notes.pdf",
      sourceMarkdown: "# v1",
    });

    const second = await service.updateDocumentFile(created, "# v2\n\nMore.");
    const third = await service.updateDocumentFile(second, "# v3");

    expect(third.sourceMarkdown).toBe("# v3");
    expect(third.id).toBe(created.id);
  });

  it("reads xlsx back after regeneration through SheetJS", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const created = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name: "data.xlsx",
      sourceMarkdown: "name,score\nAda,10",
    });

    const updated = await service.updateDocumentFile(
      created,
      "name,score\nAda,10\nLin,9",
    );

    const workbook = XLSX.read(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${updated.relativePath}`,
      )!.bytes,
      { type: "array" },
    );
    const sheet = workbook.Sheets[workbook.SheetNames[0]!];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
    expect(rows).toEqual([
      ["name", "score"],
      ["Ada", 10],
      ["Lin", 9],
    ]);
  });

  it("snapshots an imported docx and keeps its styling on update", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const original = await buildDocument({
      format: "docx",
      content: "# Imported\n\nOriginal body.",
      fileName: "original",
      spec: {
        fonts: { body: { family: "Georgia", sizePt: 13 } },
        page: { size: "LETTER" },
        footer: { text: "Page {PAGE}" },
      },
    });

    const imported = await service.importBytesFile({
      bytes: original.bytes,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "imported.docx",
    });

    expect(imported.sourceSpec).toBeTruthy();
    const snapshot = JSON.parse(imported.sourceSpec!) as {
      fonts: { body: { family: string } };
      page: { size: string };
    };
    expect(snapshot.fonts.body.family).toBe("Georgia");
    expect(snapshot.page.size).toBe("LETTER");
    // Imported files have no editable source until they are updated.
    expect(imported.sourceMarkdown).toBeNull();

    const updated = await service.updateDocumentFile(
      imported,
      "# Updated\n\nBrand new body.",
    );

    expect(updated.sourceSpec).toBe(imported.sourceSpec);

    const bytes = mocks.files.get(
      `file:///document/mobile-agent/workspace/${updated.relativePath}`,
    )!.bytes;
    const zip = await JSZip.loadAsync(bytes);
    const stylesXml = await zip.file("word/styles.xml")!.async("string");
    const documentXml = await zip.file("word/document.xml")!.async("string");

    // Original font and page size survive the update.
    expect(stylesXml).toContain("Georgia");
    expect(documentXml).toContain('w:pgSz w:w="12240"');
    expect(documentXml).toContain("Brand new body.");
  });

  it("does not snapshot non-docx imports", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const imported = await service.importBytesFile({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      mimeType: "application/pdf",
      name: "document.pdf",
    });

    expect(imported.sourceSpec).toBeNull();
  });

  it("snapshots an imported xlsx and keeps its styling on update", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const original = await buildDocument({
      format: "xlsx",
      content: "| Item | Price |\n| --- | --- |\n| Widget | 1234.5 |",
      fileName: "original",
      spec: {
        body: { font: { family: "Georgia", sizePt: 12 } },
        header: { fill: { color: "1F4E78" } },
        columns: [{ width: 24 }, { numberFormat: "#,##0.00" }],
        sheet: { tabColor: "00B050", orientation: "landscape" },
      },
    });

    const imported = await service.importBytesFile({
      bytes: original.bytes,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      name: "imported.xlsx",
    });

    expect(imported.sourceSpec).toBeTruthy();
    const snapshot = JSON.parse(imported.sourceSpec!) as {
      body: { font: { family: string } };
      header: { fill: { color: string } };
      sheet: { orientation: string; tabColor: string };
    };
    expect(snapshot.body.font.family).toBe("Georgia");
    expect(snapshot.header.fill.color).toBe("1F4E78");
    expect(snapshot.sheet.tabColor).toBe("00B050");

    const updated = await service.updateDocumentFile(
      imported,
      "| Item | Price |\n| --- | --- |\n| Gadget | 9.99 |",
    );

    expect(updated.sourceSpec).toBe(imported.sourceSpec);

    const bytes = mocks.files.get(
      `file:///document/mobile-agent/workspace/${updated.relativePath}`,
    )!.bytes;
    const zip = await JSZip.loadAsync(bytes);
    const stylesXml = await zip.file("xl/styles.xml")!.async("string");
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");

    // Original font, header fill and tab colour survive the update.
    expect(stylesXml).toContain("Georgia");
    expect(stylesXml).toContain("FF1F4E78");
    expect(sheetXml).toContain("FF00B050");
  });
});

describe("workspace document sections", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.nextId = 1;
    vi.clearAllMocks();
  });

  async function seedDocx(source = SOURCE) {
    const { repository, sectionsByFile } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);
    const created = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "report.docx",
      sourceMarkdown: source,
    });

    return { repository, sectionsByFile, service, created };
  }

  it("indexes heading sections on create and re-indexes on update", async () => {
    const { sectionsByFile, service, created } = await seedDocx();

    expect(sectionsByFile.get(created.id)?.map((entry) => entry.title)).toEqual([
      "Progress Report",
      "Highlights",
      "Metrics",
    ]);
    expect(
      sectionsByFile.get(created.id)?.map((entry) => entry.position),
    ).toEqual([0, 1, 2]);

    await service.updateDocumentFile(
      created,
      `${SOURCE}\n## Appendix\n\nExtra.\n`,
    );

    expect(sectionsByFile.get(created.id)?.map((entry) => entry.title)).toEqual([
      "Progress Report",
      "Highlights",
      "Metrics",
      "Appendix",
    ]);
  });

  it("replaces one section and regenerates the binary", async () => {
    const { service, created } = await seedDocx();

    const result = await service.updateDocumentSection(created, {
      mode: "replace",
      section: 1,
      content: "## Highlights\n\n- Rewritten list\n",
    });

    expect(result.sections.map((entry) => entry.title)).toEqual([
      "Progress Report",
      "Highlights",
      "Metrics",
    ]);
    expect(result.file.id).toBe(created.id);
    expect(result.file.sourceMarkdown).toContain("Rewritten list");
    expect(result.file.sourceMarkdown).not.toContain("Shipped the mobile agent");
    // Untouched sections survive.
    expect(result.file.sourceMarkdown).toContain("Quarterly summary");
    expect(result.file.sourceMarkdown).toContain("Releases");

    const zip = await JSZip.loadAsync(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${result.file.relativePath}`,
      )!.bytes,
    );
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain("Rewritten list");
    expect(documentXml).not.toContain("Shipped the mobile agent");
  });

  it("appends, inserts before/after, and deletes sections", async () => {
    const { service, created } = await seedDocx();

    const appended = await service.updateDocumentSection(created, {
      mode: "append",
      content: "## Appendix\n\nExtra.",
    });
    expect(appended.sections.map((entry) => entry.title)).toEqual([
      "Progress Report",
      "Highlights",
      "Metrics",
      "Appendix",
    ]);
    expect(appended.file.sourceMarkdown).toMatch(/Extra\.$/);

    const before = await service.updateDocumentSection(appended.file, {
      mode: "insertBefore",
      section: 0,
      content: "# Cover\n\nCover page.",
    });
    expect(before.sections.map((entry) => entry.title)).toEqual([
      "Cover",
      "Progress Report",
      "Highlights",
      "Metrics",
      "Appendix",
    ]);

    const after = await service.updateDocumentSection(before.file, {
      mode: "insertAfter",
      section: 0,
      content: "## Subtitle\n\nSub.",
    });
    expect(after.sections.map((entry) => entry.title)).toEqual([
      "Cover",
      "Subtitle",
      "Progress Report",
      "Highlights",
      "Metrics",
      "Appendix",
    ]);

    const deleted = await service.updateDocumentSection(after.file, {
      mode: "delete",
      section: 0,
    });
    expect(deleted.sections.map((entry) => entry.title)).toEqual([
      "Subtitle",
      "Progress Report",
      "Highlights",
      "Metrics",
      "Appendix",
    ]);
    expect(deleted.file.sourceMarkdown).toContain("Sub.");
    expect(deleted.file.sourceMarkdown).not.toContain("Cover page.");
  });

  it("validates section targets and content", async () => {
    const { service, created } = await seedDocx();

    await expect(
      service.updateDocumentSection(created, {
        mode: "replace",
        section: 0,
        content: "no heading",
      }),
    ).rejects.toThrow(/must start with a Markdown heading/);

    await expect(
      service.updateDocumentSection(created, {
        mode: "replace",
        section: 99,
        content: "# X",
      }),
    ).rejects.toThrow(/out of range/);

    await expect(
      service.updateDocumentSection(created, {
        mode: "replace",
        content: "# X",
      }),
    ).rejects.toThrow(/section index is required/);
  });

  it("reads one section by index", async () => {
    const { service, created } = await seedDocx();

    const section = await service.readDocumentSection(created, 2);

    expect(section.title).toBe("Metrics");
    expect(section.level).toBe(2);
    expect(section.body).toBe(
      "## Metrics\n\n| Metric | Value |\n| --- | --- |\n| Releases | 12 |\n| Issues closed | 340 |\n",
    );
    expect(section.charCount).toBe(section.body.length);
  });

  it("lazily indexes sections for documents created before sectioning", async () => {
    const { repository, rows, sectionsByFile } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const legacy: WorkspaceFile = {
      id: "legacy-doc",
      displayName: "legacy.docx",
      originalName: "legacy.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 2,
      relativePath: "legacy-doc-legacy.docx",
      sourceKind: "created",
      sourceMarkdown: SOURCE,
      sourceSpec: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    rows.set(legacy.id, legacy);
    expect(sectionsByFile.get(legacy.id)).toBeUndefined();

    const listed = await service.listDocumentSections(legacy);

    expect(listed.map((entry) => entry.title)).toEqual([
      "Progress Report",
      "Highlights",
      "Metrics",
    ]);
    expect(sectionsByFile.get(legacy.id)).toHaveLength(3);
  });

  it("returns no sections and rejects piecewise edits without stored source", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository as WorkspaceRepository);

    const imported = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "imported.docx",
    });

    expect(await service.listDocumentSections(imported)).toEqual([]);

    await expect(
      service.updateDocumentSection(imported, {
        mode: "append",
        content: "## New\n\nBody.",
      }),
    ).rejects.toThrow(/no stored source/);
  });
});