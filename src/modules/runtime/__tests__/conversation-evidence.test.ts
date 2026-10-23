import { describe, expect, it } from "vitest";
import type { StoredMessage, ToolExecutionRecord, WorkspaceFile, SkillConfig } from "@/core/types/app-state";
import { attachmentInspectionContext, loadedSkillNames, mediaEvidenceForMessage } from "../conversation-evidence";
import { buildSkillsSystemPrompt } from "@/providers/app-state/helpers";

const record = (overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord => ({
  toolName: "transcribeAudio", status: "completed", inputSummary: '{"fileId":"video-1","maxSeconds":90}',
  outputSummary: '{"duration":90,"text":"hello"}', error: null, createdAt: "2026-10-20T00:00:00Z", ...overrides,
});
const message = (records: ToolExecutionRecord[]) => ({ role: "assistant", metadata: { toolExecutions: records } }) as StoredMessage;

describe("same-chat evidence", () => {
  it("does not call historical attachments uninspected or require a transcript for layout edits", () => {
    const file = { id: "video-1", displayName: "clip.mp4", mimeType: "video/mp4" } as WorkspaceFile;
    const text = attachmentInspectionContext([file, file]);
    expect(text.match(/fileId: video-1/g)).toHaveLength(1);
    expect(text).toContain("NOT necessarily new or uninspected");
    expect(text).toContain("does not require transcription");
    expect(text).not.toContain("Say briefly that these files have not been inspected");
  });

  it("restores saved transcript links and legacy preview text, not failures", () => {
    const text = mediaEvidenceForMessage(message([
      record({ mediaResult: { sourceFileId: "video-1", sourceUpdatedAt: "2026-10-19", resultFileId: "transcript-json" }, preview: { title: "clip", text: "hello world" } }),
      record({ status: "failed", error: "failed-recognition-marker" }),
    ]), new Map());
    expect(text).toContain("workspace://transcript-json");
    expect(text).toContain("hello world");
    expect(text).not.toContain("failed-recognition-marker");
  });

  it("marks changed sources stale and keeps long evidence bounded", () => {
    const files = new Map([["video-1", { id: "video-1", updatedAt: "2026-10-22" } as WorkspaceFile]]);
    const text = mediaEvidenceForMessage(message(Array.from({ length: 30 }, () => record({
      preview: { title: "clip", text: "a".repeat(20000) },
    }))), files);
    expect(text).toContain("Source changed");
    expect(text.length).toBeLessThan(17000);
  });

  it("restores only successfully loaded skills, with current instructions", () => {
    const names = loadedSkillNames([
      message([record({ toolName: "skill", inputSummary: '{"name":"html-video"}' })]),
      message([record({ toolName: "skill", status: "failed", inputSummary: '{"name":"other"}' })]),
    ]);
    expect(names).toEqual(["html-video"]);
    const prompt = buildSkillsSystemPrompt({ loadedSkillNames: names, builtInToolSettings: {} as never, mcpServers: [], skills: [{
      title: "html-video", instructions: "CURRENT EDITOR INSTRUCTIONS", recommendedMcpServerIds: [], recommendedBuiltInToolKeys: [],
    } as unknown as SkillConfig] });
    expect(prompt).toContain("CURRENT EDITOR INSTRUCTIONS");
    expect(prompt).toContain("Current video runtime requirements");
    expect(prompt).toContain("do not call skill again");
  });
});
