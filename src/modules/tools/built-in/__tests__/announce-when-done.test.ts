import { describe, expect, it } from "vitest";

import type { ToolExecutionRecord } from "@/core/types/app-state";

import {
  createAnnounceWhenDoneTool,
  readAnnouncementRequest,
  sanitizeAnnouncementMessage,
} from "../announce-when-done";

function record(
  overrides: Partial<ToolExecutionRecord>,
): ToolExecutionRecord {
  return {
    toolName: "announceWhenDone",
    status: "completed",
    inputSummary: "Default announcement",
    outputSummary: "Announcement armed for when this run finishes.",
    error: null,
    createdAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("announce-when-done tool", () => {
  it("arms the request and records it", async () => {
    const armed: { message: string | null }[] = [];
    const records: ToolExecutionRecord[] = [];
    const runtime = createAnnounceWhenDoneTool({
      onArm: (request) => armed.push(request),
      onRecord: (value) => records.push(value),
    });

    const result = await runtime.tools.announceWhenDone.execute!(
      { message: "Parser refactor complete" },
      { abortSignal: undefined, messages: [], toolCallId: "t1" } as never,
    );

    expect(result).toEqual({
      armed: true,
      message: "Parser refactor complete",
    });
    expect(armed).toEqual([{ message: "Parser refactor complete" }]);
    expect(records).toHaveLength(1);
    expect(records[0]?.announcement).toEqual({
      message: "Parser refactor complete",
    });
  });

  it("arms without a custom message", async () => {
    const armed: { message: string | null }[] = [];
    const runtime = createAnnounceWhenDoneTool({
      onArm: (request) => armed.push(request),
    });

    await runtime.tools.announceWhenDone.execute!(
      {},
      { abortSignal: undefined, messages: [], toolCallId: "t2" } as never,
    );

    expect(armed).toEqual([{ message: null }]);
  });

  it("sanitizes and truncates custom messages", () => {
    expect(sanitizeAnnouncementMessage("  Build\u0000  done  ")).toBe(
      "Build done",
    );
    expect(sanitizeAnnouncementMessage("   ")).toBeNull();

    const long = "x".repeat(400);
    const result = sanitizeAnnouncementMessage(long);
    expect(result?.length).toBeLessThanOrEqual(160);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("reads the last completed armed request from persisted records", () => {
    expect(
      readAnnouncementRequest([
        record({ announcement: { message: "first" } }),
        record({ status: "failed", announcement: { message: "failed" } }),
        record({ announcement: { message: "last" } }),
      ]),
    ).toEqual({ message: "last" });

    expect(readAnnouncementRequest([])).toBeNull();
    expect(
      readAnnouncementRequest([record({ announcement: null })]),
    ).toBeNull();
  });
});
