import { describe, expect, it } from "vitest";

import type { StoredMessage } from "@/core/types/app-state";
import { getAssistantResponseFooters, splitSpeechText } from "../assistant-response";

type ResponseMessage = Pick<StoredMessage, "id" | "role" | "content" | "metadata">;

function assistant(id: string, content: string, runId?: string): ResponseMessage {
  return { id, role: "assistant", content, metadata: runId ? { runId } : null };
}

function user(id: string, steeredIntoRunId?: string): ResponseMessage {
  return {
    id, role: "user", content: "User instructions",
    metadata: steeredIntoRunId ? { steeredIntoRunId } : null,
  };
}

describe("getAssistantResponseFooters", () => {
  it("keeps a standalone assistant footer unchanged", () => {
    expect([...getAssistantResponseFooters([
      user("prompt"), assistant("reply", "Answer", "run-1"),
    ])]).toEqual([["reply", "Answer"]]);
    expect([...getAssistantResponseFooters([])]).toEqual([]);
  });

  it("only shows the final footer and plays every assistant segment in order", () => {
    expect([...getAssistantResponseFooters([
      user("prompt"), assistant("before", "First step.", "run-1"),
      user("steer", "run-1"), assistant("middle", "Next step.", "run-1"),
      user("another-steer", "run-1"), assistant("last", "Finished.", "run-1"),
    ])]).toEqual([["last", "First step.\n\nNext step.\n\nFinished."]]);
  });

  it("hides earlier footers while a fresh continuation has no metadata or text", () => {
    expect([...getAssistantResponseFooters([
      assistant("before", "Before steer", "run-1"), user("steer", "run-1"),
      assistant("continuation", ""),
    ])]).toEqual([["continuation", "Before steer"]]);
  });

  it("does not combine different ordinary turns", () => {
    expect([...getAssistantResponseFooters([
      user("prompt"), assistant("first", "First answer"),
      user("new-prompt"), assistant("second", "Second answer"),
    ])]).toEqual([["first", "First answer"], ["second", "Second answer"]]);
  });

  it("does not combine separate known runs", () => {
    expect([...getAssistantResponseFooters([
      assistant("first", "First run", "run-1"),
      assistant("second", "Second run", "run-2"),
    ])]).toEqual([["first", "First run"], ["second", "Second run"]]);
  });
});

describe("splitSpeechText", () => {
  it("keeps short content in one utterance", () => {
    expect(splitSpeechText(" Full answer. ", 100)).toEqual(["Full answer."]);
    expect(splitSpeechText("  ", 100)).toEqual([]);
  });

  it("queues all long content without exceeding the native limit", () => {
    const chunks = splitSpeechText("First step. Next step. Finished.", 12);
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
    expect(chunks.join(" ")).toBe("First step. Next step. Finished.");
  });

  it("handles long tokens and preserves emoji at chunk boundaries", () => {
    expect(splitSpeechText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(splitSpeechText("abc😀def", 4)).toEqual(["abc", "😀de", "f"]);
  });
});
