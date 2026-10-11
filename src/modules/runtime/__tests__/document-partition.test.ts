import { describe, expect, it, vi } from "vitest";

import { isDocumentFile } from "@/modules/documents";
import type { WorkspaceFile } from "@/core/types/app-state";

vi.mock("@/core/services/workspace-file-service", () => ({
  isDocumentWorkspaceFile: (file: { displayName: string }) =>
    /\.(docx|pdf|pptx|xlsx)$/i.test(file.displayName),
  isTextWorkspaceFile: (file: { displayName: string }) =>
    !/\.(docx|pdf|pptx|xlsx)$/i.test(file.displayName) &&
    /\.(md|txt|json)$/i.test(file.displayName),
  resolveWorkspaceFile: vi.fn(),
}));

// Imported after the mock so the react-native-free stub is used.
const { partitionSelectedFiles } = await import(
  "@/modules/runtime/message-conversion"
);

function file(overrides: Partial<WorkspaceFile>): WorkspaceFile {
  return {
    id: "file-1",
    displayName: "file.txt",
    mimeType: "text/plain",
    originalName: "file.txt",
    relativePath: "file-1-file.txt",
    size: 10,
    sourceKind: "created",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as WorkspaceFile;
}

describe("document file detection", () => {
  it("detects documents by extension", () => {
    expect(isDocumentFile({ displayName: "a.docx" })).toBe(true);
    expect(isDocumentFile({ displayName: "b.PDF" })).toBe(true);
    expect(isDocumentFile({ displayName: "c.pptx" })).toBe(true);
    expect(isDocumentFile({ displayName: "d.xlsx" })).toBe(true);
    expect(isDocumentFile({ displayName: "plain.txt" })).toBe(false);
  });

  it("detects documents by mime type even without extension", () => {
    expect(
      isDocumentFile({ displayName: "report", mimeType: "application/pdf" }),
    ).toBe(true);
    expect(
      isDocumentFile({
        displayName: "data",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe(true);
    expect(
      isDocumentFile({ displayName: "notes", mimeType: "text/plain" }),
    ).toBe(false);
    expect(isDocumentFile({ displayName: "notes" })).toBe(false);
  });
});

describe("partitionSelectedFiles", () => {
  it("routes documents into the text bucket so they can be inlined", () => {
    const files = [
      file({ displayName: "notes.md", mimeType: "text/markdown" }),
      file({ displayName: "essay.docx", mimeType: null }),
      file({ displayName: "data.pdf", mimeType: null }),
      file({ displayName: "photo.png", mimeType: "image/png" }),
      file({ displayName: "archive.bin", mimeType: "application/octet-stream" }),
    ];

    const { binaryFiles, imageFiles, textFiles } =
      partitionSelectedFiles(files);

    expect(textFiles.map((f) => f.displayName)).toEqual([
      "notes.md",
      "essay.docx",
      "data.pdf",
    ]);
    expect(imageFiles.map((f) => f.displayName)).toEqual(["photo.png"]);
    expect(binaryFiles.map((f) => f.displayName)).toEqual(["archive.bin"]);
  });

  it("leaves untracked kinds as binary instead of dropping them", () => {
    const { binaryFiles, textFiles } = partitionSelectedFiles([
      file({ displayName: "blob.dat" }),
    ]);

    expect(textFiles).toHaveLength(0);
    expect(binaryFiles.map((f) => f.displayName)).toEqual(["blob.dat"]);
  });
});