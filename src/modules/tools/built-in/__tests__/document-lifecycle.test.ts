import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentFormat } from "@/modules/documents";
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

const { createCreateFileTool } = await import(
  "@/modules/tools/built-in/create-file"
);
const { createReadTool } = await import("@/modules/tools/built-in/read");
const { createUpdateDocumentTool } = await import(
  "@/modules/tools/built-in/update-document"
);
const { createSplitDocumentTool } = await import(
  "@/modules/tools/built-in/split-document"
);
const { createMergeDocumentsTool } = await import(
  "@/modules/tools/built-in/merge-documents"
);
const { extractDocument } = await import("@/modules/documents");

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

  return { repository };
}

async function storedBytes(
  repository: WorkspaceRepository,
  fileId: string,
): Promise<Uint8Array> {
  const file = await repository.getById(fileId);
  return mocks.files.get(
    `file:///document/mobile-agent/workspace/${file!.relativePath}`,
  )!.bytes;
}

type AnyRecord = Record<string, unknown>;

const LIFECYCLE_CASES: {
  format: DocumentFormat;
  name: string;
  content: string;
  marker: string;
  updatedMarker: string;
  sectionContent: string;
  sectionMarker: string;
}[] = [
  {
    format: "docx",
    name: "lifecycle-report",
    content:
      "# Report ALPHA\n\nIntro paragraph.\n\n## Part One\n\nBody BETA.\n\n## Part Two\n\nBody GAMMA.\n",
    marker: "ALPHA",
    updatedMarker: "ALPHA-REWRITTEN",
    sectionContent: "# Report ALPHA-REWRITTEN\n\nIntro updated.\n",
    sectionMarker: "ALPHA-REWRITTEN",
  },
  {
    format: "xlsx",
    name: "lifecycle-inventory",
    content:
      "# Inventory ALPHA\n\n| Item | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | 5 |\n",
    marker: "Apples",
    updatedMarker: "Apricots",
    sectionContent:
      "# Inventory ALPHA\n\n| Item | Qty |\n| --- | --- |\n| Apricots | 9 |\n",
    sectionMarker: "Apricots",
  },
  {
    format: "pptx",
    name: "lifecycle-deck",
    content:
      "# Deck ALPHA\n\n## Opening BETA\n\nFirst point.\n\n## Closing GAMMA\n\nLast point.\n",
    marker: "ALPHA",
    updatedMarker: "ALPHA-REWRITTEN",
    sectionContent: "# Deck ALPHA-REWRITTEN\n\n## Opening BETA\n\nFirst point.\n",
    sectionMarker: "ALPHA-REWRITTEN",
  },
  {
    format: "pdf",
    name: "lifecycle-memo",
    content:
      "# Memo ALPHA\n\nIntro paragraph.\n\n## Detail BETA\n\nBody text.\n",
    marker: "ALPHA",
    updatedMarker: "ALPHA-REWRITTEN",
    sectionContent: "# Memo ALPHA-REWRITTEN\n\nIntro updated.\n",
    sectionMarker: "ALPHA-REWRITTEN",
  },
];

describe("document lifecycle across all formats", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.idCounter = 0;
    vi.clearAllMocks();
  });

  for (const testCase of LIFECYCLE_CASES) {
    it(`creates, reads, updates and extracts ${testCase.format}`, async () => {
      const { repository } = makeRepository();
      const createFile = createCreateFileTool({ repository });
      const read = createReadTool({ repository });
      const updateDocument = createUpdateDocumentTool({ repository });

      const created = (await createFile.execute!(
        {
          name: testCase.name,
          content: testCase.content,
          format: testCase.format,
        },
        {} as never,
      )) as AnyRecord;

      expect(typeof created["fileId"]).toBe("string");
      const fileId = created["fileId"] as string;

      const initial = (await read.execute!({ fileId }, {} as never)) as AnyRecord;
      expect(initial["hasSourceMarkdown"]).toBe(true);
      expect(initial["sourceMarkdown"] as string).toContain(testCase.marker);

      const sectionZero = (await read.execute!(
        { fileId, section: 0 },
        {} as never,
      )) as AnyRecord;
      expect(sectionZero["content"] as string).toContain(testCase.marker);

      await updateDocument.execute!(
        { fileId, content: testCase.content.replaceAll(testCase.marker, testCase.updatedMarker) },
        {} as never,
      );

      const afterFull = (await read.execute!({ fileId }, {} as never)) as AnyRecord;
      expect(afterFull["sourceMarkdown"] as string).toContain(
        testCase.updatedMarker,
      );

      await updateDocument.execute!(
        { fileId, section: 0, content: testCase.sectionContent },
        {} as never,
      );

      const afterSection = (await read.execute!(
        { fileId, section: 0 },
        {} as never,
      )) as AnyRecord;
      expect(afterSection["content"] as string).toContain(
        testCase.sectionMarker,
      );

      const extracted = await extractDocument(
        testCase.format,
        await storedBytes(repository, fileId),
      );
      expect(extracted.text).toContain(testCase.sectionMarker);
    });
  }

  it("splits a docx into parts and merges them back", async () => {
    const { repository } = makeRepository();
    const createFile = createCreateFileTool({ repository });
    const splitDocument = createSplitDocumentTool({ repository });
    const mergeDocuments = createMergeDocumentsTool({ repository });

    const created = (await createFile.execute!(
      {
        name: "roundtrip",
        content: "# Red\n\nFirst.\n\n# Green\n\nSecond.\n\n# Blue\n\nThird.\n",
        format: "docx",
      },
      {} as never,
    )) as AnyRecord;
    const fileId = created["fileId"] as string;

    const split = (await splitDocument.execute!(
      { fileId, sections: "each" },
      {} as never,
    )) as { created: { fileId: string }[] };

    expect(split.created).toHaveLength(3);

    const merged = (await mergeDocuments.execute!(
      { fileIds: split.created.map((part) => part.fileId) },
      {} as never,
    )) as AnyRecord;

    const mergedBytes = await storedBytes(repository, merged["fileId"] as string);
    const extracted = await extractDocument("docx", mergedBytes);
    expect(extracted.text).toContain("Red");
    expect(extracted.text).toContain("Green");
    expect(extracted.text).toContain("Blue");
  });

  it("handles a 150-section docx end to end", async () => {
    const { repository } = makeRepository();
    const createFile = createCreateFileTool({ repository });
    const read = createReadTool({ repository });
    const updateDocument = createUpdateDocumentTool({ repository });

    const content = Array.from(
      { length: 150 },
      (_value, index) =>
        `# Chapter ${index + 1}\n\nBody text for chapter ${index + 1}.\n`,
    ).join("\n");

    const created = (await createFile.execute!(
      { name: "long-report", content, format: "docx" },
      {} as never,
    )) as AnyRecord;
    const fileId = created["fileId"] as string;

    const initial = (await read.execute!({ fileId }, {} as never)) as AnyRecord;
    const sections = initial["sections"] as { title: string }[];
    expect(sections).toHaveLength(150);
    expect(sections[149]!.title).toContain("Chapter 150");

    const middle = (await read.execute!(
      { fileId, section: 74 },
      {} as never,
    )) as AnyRecord;
    expect(middle["content"] as string).toContain("Chapter 75");

    await updateDocument.execute!(
      { fileId, section: 74, content: "# Chapter 75\n\nRevised body.\n" },
      {} as never,
    );

    const revised = (await read.execute!(
      { fileId, section: 74 },
      {} as never,
    )) as AnyRecord;
    expect(revised["content"] as string).toContain("Revised body.");

    const extracted = await extractDocument(
      "docx",
      await storedBytes(repository, fileId),
    );
    expect(extracted.text).toContain("Chapter 1");
    expect(extracted.text).toContain("Chapter 150");
    expect(extracted.text).toContain("Revised body.");
  }, 120_000);
});
