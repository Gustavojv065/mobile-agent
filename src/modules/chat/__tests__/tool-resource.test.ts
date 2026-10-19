import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "@/core/types/app-state";
import { hasLegacyToolResource, readToolResourceReference } from "../tool-resource";

const record = (inputSummary: string, outputSummary: string | null = null): ToolExecutionRecord => ({
  toolName: "read", inputSummary, outputSummary, createdAt: "2026-10-19", status: "completed", error: null,
});

describe("legacy trace resources", () => {
  it("recovers complete references even when a long summary is truncated", () => {
    const result = readToolResourceReference(record('{"fileId":"abc","edits":[{"newText":"very long...', '{"displayName":"scene.html","contentPreview":"cut...'));
    expect(result).toMatchObject({ fileId: "abc", displayName: "scene.html" });
  });

  it("handles escaped string values, and prefers output IDs for created files", () => {
    const result = readToolResourceReference(record('{"fileId":"input","name":"A \\"quoted\\" skill"}', '{"fileId":"output"}'));
    expect(result.fileId).toBe("output");
  });

  it("recovers skill names and supporting file paths", () => {
    expect(readToolResourceReference(record('{"name":"html-video","path":"references/guide.md"}'))).toMatchObject({ skillName: "html-video", path: "references/guide.md" });
  });

  it("does not replace captured historical content with today's file", () => {
    expect(hasLegacyToolResource(record('{}'))).toBe(true);
    expect(hasLegacyToolResource({ ...record('{}'), preview: { title: "Snapshot", text: "original" } })).toBe(false);
    expect(hasLegacyToolResource({ ...record('{}'), diff: "-old\n+new" })).toBe(false);
    expect(hasLegacyToolResource({ ...record('{}'), status: "failed" })).toBe(false);
  });
});
