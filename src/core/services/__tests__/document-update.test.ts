import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  WorkspaceFile,
  WorkspaceFileSourceKind,
} from "@/core/types/app-state";
import type { WorkspaceRepository } from "@/core/db/repositories/types";

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
    static async downloadFileAsync() {}
  },
}));

const { createWorkspaceFileService } = await import(
  "@/core/services/workspace-file-service"
);

function makeRepository() {
  const rows = new Map<string, WorkspaceFile>();

  const repository = {
    async create(input: {
      displayName: string;
      mimeType?: string | null;
      originalName?: string | null;
      relativePath: string;
      size?: number | null;
      sourceKind: WorkspaceFileSourceKind;
      sourceMarkdown?: string | null;
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
});