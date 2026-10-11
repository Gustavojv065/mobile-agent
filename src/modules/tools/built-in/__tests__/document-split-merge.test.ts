import JSZip from "jszip";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceRepository } from "@/core/db/repositories/types";

const mocks = vi.hoisted(() => ({
  files: new Map<string, { bytes: Uint8Array }>(),
  idCounter: 0,
}));

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => `file-${(mocks.idCounter += 1)}`),
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
const { createSplitDocumentTool } = await import(
  "@/modules/tools/built-in/split-document"
);
const { createMergeDocumentsTool } = await import(
  "@/modules/tools/built-in/merge-documents"
);
const { buildDocument } = await import("@/modules/documents");
const { splitPptxSlides, splitXlsxSheets } = await import(
  "@/modules/documents"
);

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const SOURCE = `# Title

Intro paragraph.

## One

First body.

## Two

Second body.
`;

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
    async getByIds(ids: string[]) {
      return ids
        .map((id) => rows.get(id))
        .filter(Boolean) as import("@/core/types/app-state").WorkspaceFile[];
    },
    async updateMetadata(
      id: string,
      input: { size?: number | null; sourceMarkdown?: string | null },
    ) {
      const current = rows.get(id);
      if (!current) {
        return;
      }
      rows.set(id, {
        ...current,
        size: input.size !== undefined ? input.size : current.size,
        sourceMarkdown:
          input.sourceMarkdown !== undefined
            ? input.sourceMarkdown
            : current.sourceMarkdown,
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
    list: vi.fn(async () => []),
    deleteAll: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  } as unknown as WorkspaceRepository;

  return { repository, rows };
}

async function seedDocx(
  repository: WorkspaceRepository,
  name: string,
  source: string,
  sourceSpec?: string | null,
) {
  const service = createWorkspaceFileService(repository);
  const built = await buildDocument({
    format: "docx",
    content: source,
    fileName: name.replace(/\.docx$/, ""),
  });
  return service.createDocumentFile({
    bytes: built.bytes,
    mimeType: DOCX_MIME,
    name,
    sourceMarkdown: source,
    sourceSpec: sourceSpec ?? null,
  });
}

describe("splitDocument tool", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.idCounter = 0;
    vi.clearAllMocks();
  });

  it("splits a docx into parts that keep an editable stored source", async () => {
    const { repository } = makeRepository();
    const created = await seedDocx(repository, "report.docx", SOURCE);
    const splitDocument = createSplitDocumentTool({ repository });

    const result = (await splitDocument.execute!(
      { fileId: created.id, sections: "0-1,2" },
      {} as never,
    )) as {
      unit: string;
      unitCount: number;
      sourceFileId: string;
      created: { fileId: string; displayName: string; part: number }[];
    };

    expect(result.unit).toBe("section");
    expect(result.unitCount).toBe(3);
    expect(result.sourceFileId).toBe(created.id);
    expect(result.created.map((entry) => entry.displayName)).toEqual([
      "report-part-1.docx",
      "report-part-2.docx",
    ]);

    const part1 = await repository.getById(result.created[0]!.fileId);
    const part2 = await repository.getById(result.created[1]!.fileId);
    expect(part1?.sourceMarkdown).toBe(
      "# Title\n\nIntro paragraph.\n\n## One\n\nFirst body.\n",
    );
    expect(part2?.sourceMarkdown).toBe("## Two\n\nSecond body.\n");

    const zip = await JSZip.loadAsync(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${part1!.relativePath}`,
      )!.bytes,
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Intro paragraph.");
    expect(xml).not.toContain("Second body.");
  });

  it("rejects pdf files with a pointer to splitPdf", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const pdf = await service.createDocumentFile({
      bytes: new Uint8Array([0x25, 0x50]),
      mimeType: "application/pdf",
      name: "report.pdf",
    });
    const splitDocument = createSplitDocumentTool({ repository });

    await expect(
      splitDocument.execute!({ fileId: pdf.id, sections: "0" }, {} as never),
    ).rejects.toThrow(/use splitPdf/);
  });

  it("rejects text files", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const text = await service.createTextFile({
      name: "notes.txt",
      content: "hello",
    });
    const splitDocument = createSplitDocumentTool({ repository });

    await expect(
      splitDocument.execute!({ fileId: text.id, sections: "0" }, {} as never),
    ).rejects.toThrow(/not a docx, xlsx or pptx/);
  });

  it("splits an imported docx by extracting its text and keeping the source spec", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const built = await buildDocument({
      format: "docx",
      content: "# Imported\n\nOriginal body.",
      fileName: "imported",
    });
    const imported = await service.importBytesFile({
      bytes: built.bytes,
      mimeType: DOCX_MIME,
      name: "imported.docx",
    });
    const splitDocument = createSplitDocumentTool({ repository });

    const result = (await splitDocument.execute!(
      { fileId: imported.id, sections: "each" },
      {} as never,
    )) as { created: { fileId: string }[] };

    expect(result.created).toHaveLength(1);
    const part = await repository.getById(result.created[0]!.fileId);
    expect(part?.sourceMarkdown).toContain("Imported");
    expect(part?.sourceSpec).toBe(imported.sourceSpec);
  });

  it("records the tool execution", async () => {
    const { repository } = makeRepository();
    const created = await seedDocx(repository, "report.docx", SOURCE);
    const onRecord = vi.fn();
    const splitDocument = createSplitDocumentTool({ repository, onRecord });

    await splitDocument.execute!(
      { fileId: created.id, sections: "each" },
      {} as never,
    );

    expect(
      (onRecord.mock.calls[0][0] as { toolName: string }).toolName,
    ).toBe("splitDocument");
  });
});

describe("mergeDocuments tool", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.idCounter = 0;
    vi.clearAllMocks();
  });

  it("merges docx files in order into one editable document", async () => {
    const { repository } = makeRepository();
    const first = await seedDocx(repository, "first.docx", "# First\n\nA.\n");
    const second = await seedDocx(repository, "second.docx", "# Second\n\nB.\n");
    const mergeDocuments = createMergeDocumentsTool({ repository });

    const result = (await mergeDocuments.execute!(
      { fileIds: [first.id, second.id], name: "combined" },
      {} as never,
    )) as { fileId: string; displayName: string; format: string };

    expect(result.displayName).toBe("combined.docx");
    expect(result.format).toBe("docx");

    const merged = await repository.getById(result.fileId);
    expect(merged?.sourceMarkdown).toBe(
      "# First\n\nA.\n\n# Second\n\nB.\n",
    );

    const zip = await JSZip.loadAsync(
      mocks.files.get(
        `file:///document/mobile-agent/workspace/${merged!.relativePath}`,
      )!.bytes,
    );
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("First");
    expect(xml).toContain("Second");
  });

  it("rejects files of different formats", async () => {
    const { repository } = makeRepository();
    const first = await seedDocx(repository, "first.docx", "# First\n");
    const service = createWorkspaceFileService(repository);
    const sheet = await service.createDocumentFile({
      bytes: new Uint8Array([0x50, 0x4b]),
      mimeType: XLSX_MIME,
      name: "sheet.xlsx",
      sourceMarkdown: "# Sheet\n",
    });
    const mergeDocuments = createMergeDocumentsTool({ repository });

    await expect(
      mergeDocuments.execute!(
        { fileIds: [first.id, sheet.id] },
        {} as never,
      ),
    ).rejects.toThrow(/same format/);
  });

  it("rejects pdf files with a pointer to mergePdfs", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const a = await service.createDocumentFile({
      bytes: new Uint8Array([0x25, 0x50]),
      mimeType: "application/pdf",
      name: "a.pdf",
    });
    const b = await service.createDocumentFile({
      bytes: new Uint8Array([0x25, 0x50]),
      mimeType: "application/pdf",
      name: "b.pdf",
    });
    const mergeDocuments = createMergeDocumentsTool({ repository });

    await expect(
      mergeDocuments.execute!({ fileIds: [a.id, b.id] }, {} as never),
    ).rejects.toThrow(/use mergePdfs/);
  });

  it("fails for unknown file ids", async () => {
    const { repository } = makeRepository();
    const first = await seedDocx(repository, "first.docx", "# First\n");
    const mergeDocuments = createMergeDocumentsTool({ repository });

    await expect(
      mergeDocuments.execute!(
        { fileIds: [first.id, "missing"] },
        {} as never,
      ),
    ).rejects.toThrow(/No workspace files found/);
  });

  it("records the tool execution", async () => {
    const { repository } = makeRepository();
    const first = await seedDocx(repository, "first.docx", "# First\n");
    const second = await seedDocx(repository, "second.docx", "# Second\n");
    const onRecord = vi.fn();
    const mergeDocuments = createMergeDocumentsTool({ repository, onRecord });

    await mergeDocuments.execute!(
      { fileIds: [first.id, second.id] },
      {} as never,
    );

    expect(
      (onRecord.mock.calls[0][0] as { toolName: string }).toolName,
    ).toBe("mergeDocuments");
  });
});

function zipEntryText(bytes: Uint8Array, path: string): string | null {
  const entry = unzipSync(bytes)[path];
  return entry ? strFromU8(entry) : null;
}

async function readCreatedBytes(
  repository: WorkspaceRepository,
  fileId: string,
): Promise<Uint8Array> {
  const file = await repository.getById(fileId);
  return mocks.files.get(
    `file:///document/mobile-agent/workspace/${file!.relativePath}`,
  )!.bytes;
}

const TABLE_A = `| A | B |\n| --- | --- |\n| 1 | 2 |\n`;
const TABLE_B = `| C | D |\n| --- | --- |\n| 3 | 4 |\n`;
const TABLE_C = `| E | F |\n| --- | --- |\n| 5 | 6 |\n`;

describe("splitDocument lossless OOXML path for imported files", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.idCounter = 0;
    vi.clearAllMocks();
  });

  it("splits an imported xlsx by sheets without losing shared parts", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const built = await buildDocument({
      format: "xlsx",
      content: `${TABLE_A}\n${TABLE_B}\n${TABLE_C}`,
      fileName: "book",
    });
    const imported = await service.importBytesFile({
      bytes: built.bytes,
      mimeType: XLSX_MIME,
      name: "book.xlsx",
    });
    const splitDocument = createSplitDocumentTool({ repository });

    const result = (await splitDocument.execute!(
      { fileId: imported.id, sections: "0,2" },
      {} as never,
    )) as {
      unit: string;
      unitCount: number;
      unitNames: string[];
      created: { fileId: string }[];
    };

    expect(result.unit).toBe("sheet");
    expect(result.unitCount).toBe(3);
    expect(result.unitNames).toHaveLength(3);
    expect(result.created).toHaveLength(2);

    const firstWorkbook = zipEntryText(
      await readCreatedBytes(repository, result.created[0]!.fileId),
      "xl/workbook.xml",
    )!;
    const secondWorkbook = zipEntryText(
      await readCreatedBytes(repository, result.created[1]!.fileId),
      "xl/workbook.xml",
    )!;

    expect(firstWorkbook.match(/<sheet\b/g) ?? []).toHaveLength(1);
    expect(secondWorkbook.match(/<sheet\b/g) ?? []).toHaveLength(1);
    expect(firstWorkbook).toContain(`name="${result.unitNames[0]}"`);
    expect(secondWorkbook).toContain(`name="${result.unitNames[2]}"`);

    // Lossless: the split package keeps every entry of the original (only the
    // workbook part's sheet list is pruned).
    const bytes = await readCreatedBytes(repository, result.created[0]!.fileId);
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual(
      Object.keys(unzipSync(built.bytes)).sort(),
    );
    expect(zipEntryText(bytes, "xl/styles.xml")).not.toBeNull();
    expect(zipEntryText(bytes, "xl/worksheets/sheet3.xml")).not.toBeNull();
  });

  it("splits an imported pptx by slides, keeping media and layouts", async () => {
    const { repository } = makeRepository();
    const service = createWorkspaceFileService(repository);
    const built = await buildDocument({
      format: "pptx",
      content: "# One\n\nA.\n\n# Two\n\nB.\n\n# Three\n\nC.\n",
      fileName: "deck",
    });
    const imported = await service.importBytesFile({
      bytes: built.bytes,
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      name: "deck.pptx",
    });
    const splitDocument = createSplitDocumentTool({ repository });

    const result = (await splitDocument.execute!(
      { fileId: imported.id, sections: "0-1,2" },
      {} as never,
    )) as {
      unit: string;
      unitCount: number;
      unitNames: string[];
      created: { fileId: string }[];
    };

    expect(result.unit).toBe("slide");
    expect(result.unitCount).toBeGreaterThanOrEqual(3);
    expect(result.created).toHaveLength(2);

    const partOneBytes = await readCreatedBytes(
      repository,
      result.created[0]!.fileId,
    );
    const partTwoBytes = await readCreatedBytes(
      repository,
      result.created[1]!.fileId,
    );
    const partOneXml = zipEntryText(partOneBytes, "ppt/presentation.xml")!;
    const partTwoXml = zipEntryText(partTwoBytes, "ppt/presentation.xml")!;

    expect(partOneXml.match(/<p:sldId\b/g) ?? []).toHaveLength(2);
    expect(partTwoXml.match(/<p:sldId\b/g) ?? []).toHaveLength(1);

    // Lossless: the slide masters and the full slide set stay in the package.
    expect(zipEntryText(partOneBytes, "ppt/slides/slide1.xml")).not.toBeNull();
    expect(partOneXml).toContain("<p:sldMasterIdLst");
  });

  it("rejects unreadable packages", () => {
    expect(() =>
      splitXlsxSheets({ bytes: new Uint8Array([1, 2, 3]), spec: "0" }),
    ).toThrow(/not a readable xlsx package/);
    expect(() =>
      splitPptxSlides({ bytes: new Uint8Array([1, 2, 3]), spec: "0" }),
    ).toThrow(/not a readable pptx package/);
  });

  it("supports 'each' for one part per sheet", async () => {
    const built = await buildDocument({
      format: "xlsx",
      content: `${TABLE_A}\n${TABLE_B}`,
      fileName: "book",
    });
    const result = splitXlsxSheets({ bytes: built.bytes, spec: "each" });

    expect(result.unitCount).toBe(2);
    expect(result.parts).toHaveLength(2);
    expect(result.unitNames).toHaveLength(2);
  });

  it("splits decks that use non-standard namespace prefixes", async () => {
    const built = await buildDocument({
      format: "pptx",
      content: "# One\n\nA.\n\n# Two\n\nB.\n",
      fileName: "deck",
    });
    const zip = unzipSync(built.bytes);
    const presentation = strFromU8(zip["ppt/presentation.xml"]!);
    // A conforming producer may bind any prefix; the split must not care.
    const patched = presentation
      .replaceAll("<p:", "<qq:")
      .replaceAll("</p:", "</qq:")
      .replaceAll("xmlns:p=", "xmlns:qq=")
      .replaceAll(" r:id=", " rr:id=")
      .replaceAll("xmlns:r=", "xmlns:rr=");
    const repackaged = zipSync(
      { ...zip, "ppt/presentation.xml": strToU8(patched) },
      { level: 6 },
    );

    const result = splitPptxSlides({ bytes: repackaged, spec: "1" });

    expect(result.unitCount).toBe(2);
    expect(result.parts).toHaveLength(1);
    expect(result.unitNames).toHaveLength(2);
    const partXml = strFromU8(
      unzipSync(result.parts[0]!)["ppt/presentation.xml"]!,
    );
    expect(partXml.match(/<qq:sldId\b/g) ?? []).toHaveLength(1);
    expect(partXml).toContain("rr:id=");
  });

  it("keeps sheet names containing '>' intact", async () => {
    const built = await buildDocument({
      format: "xlsx",
      content: `${TABLE_A}\n${TABLE_B}`,
      fileName: "book",
    });
    const zip = unzipSync(built.bytes);
    const workbook = strFromU8(zip["xl/workbook.xml"]!);
    // '>' is legal unescaped inside an attribute value.
    const patched = workbook.replace('name="book 1"', 'name="Q1 > Q2"');
    const repackaged = zipSync(
      { ...zip, "xl/workbook.xml": strToU8(patched) },
      { level: 6 },
    );

    const result = splitXlsxSheets({ bytes: repackaged, spec: "each" });

    expect(result.unitNames[0]).toBe("Q1 > Q2");
    const partWorkbook = strFromU8(
      unzipSync(result.parts[0]!)["xl/workbook.xml"]!,
    );
    // Semantically identical; the serializer canonically escapes '>'.
    expect(partWorkbook).toContain('name="Q1 &gt; Q2"');
    expect(partWorkbook.match(/<sheet\b/g) ?? []).toHaveLength(1);
  });

  it("drops section references to slides that were split away", async () => {
    const built = await buildDocument({
      format: "pptx",
      content: "# One\n\nA.\n\n# Two\n\nB.\n\n# Three\n\nC.\n",
      fileName: "deck",
    });
    const zip = unzipSync(built.bytes);
    const presentation = strFromU8(zip["ppt/presentation.xml"]!);
    const ids = [
      ...presentation.matchAll(/<p:sldId id="(\d+)" r:id="[^"]+"\/>/g),
    ].map((match) => match[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const sectionLst =
      `<p:sectionLst><p:section name="Group A" id="{11111111-1111-1111-1111-111111111111}">` +
      `<p:sldIdLst><p:sldId id="${ids[0]}"/><p:sldId id="${ids[1]}"/></p:sldIdLst></p:section>` +
      `<p:section name="Group B" id="{22222222-2222-2222-2222-222222222222}">` +
      `<p:sldIdLst><p:sldId id="${ids[2]}"/></p:sldIdLst></p:section></p:sectionLst>`;
    const patched = presentation.replace(
      "</p:presentation>",
      `${sectionLst}</p:presentation>`,
    );
    const repackaged = zipSync(
      { ...zip, "ppt/presentation.xml": strToU8(patched) },
      { level: 6 },
    );

    const keepFirst = splitPptxSlides({ bytes: repackaged, spec: "0-1" });
    const firstXml = strFromU8(
      unzipSync(keepFirst.parts[0]!)["ppt/presentation.xml"]!,
    );
    expect(firstXml).toContain('name="Group A"');
    // Group B lost its only slide, so the emptied section is removed.
    expect(firstXml).not.toContain('name="Group B"');
    // No dangling reference to the dropped slide remains in the sections.
    expect(firstXml).not.toContain(`<p:sldId id="${ids[2]}"/>`);

    const keepLast = splitPptxSlides({ bytes: repackaged, spec: "2" });
    const lastXml = strFromU8(
      unzipSync(keepLast.parts[0]!)["ppt/presentation.xml"]!,
    );
    expect(lastXml).not.toContain('name="Group A"');
    expect(lastXml).toContain('name="Group B"');
  });
});
