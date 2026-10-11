import { describe, expect, it, vi } from "vitest";

import { buildWorkspaceSystemPrompt } from "@/modules/tools/built-in/prompts";

// buildWorkspaceSystemPrompt is pure text, but prompts.ts shares a module with
// service-backed helpers that transitively import native modules. Stub the
// service so this test stays hermetic like the other built-in tool tests.
vi.mock("@/core/services/workspace-file-service", () => ({
  createWorkspaceFileService: vi.fn(),
  isDocumentWorkspaceFile: vi.fn(),
  isTextWorkspaceFile: vi.fn(),
}));

function sentences(prompt: string): string[] {
  return prompt
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 60);
}

describe("buildWorkspaceSystemPrompt", () => {
  it("documents the full document capability matrix", () => {
    const prompt = buildWorkspaceSystemPrompt();

    for (const name of [
      "createFile",
      "updateDocument",
      "splitDocument",
      "mergeDocuments",
      "splitPdf",
      "mergePdfs",
      "grep",
      "ocr",
      "downloadFile",
    ]) {
      expect(prompt).toContain(name);
    }

    for (const format of ["docx", "xlsx", "pptx", "pdf"]) {
      expect(prompt).toContain(format);
    }

    expect(prompt).toContain("front-matter");
    expect(prompt).toContain("section");
    expect(prompt).toContain("slide");
    expect(prompt).toContain("sheet");
  });

  it("contains no duplicated sentences", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const sentence of sentences(buildWorkspaceSystemPrompt())) {
      if (seen.has(sentence)) {
        duplicates.push(sentence.slice(0, 80));
      }
      seen.add(sentence);
    }

    expect(duplicates).toEqual([]);
  });
});
