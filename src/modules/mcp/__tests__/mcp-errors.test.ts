import { describe, expect, it } from "vitest";

import { getActionableMcpErrorMessage } from "@/modules/mcp/mcp-errors";

describe("getActionableMcpErrorMessage", () => {
  it("returns the default when there are no failures", () => {
    expect(getActionableMcpErrorMessage([])).toBe(
      "Failed to connect MCP server.",
    );
  });

  it("returns a single failure as-is", () => {
    expect(getActionableMcpErrorMessage([new Error("boom")])).toBe("boom");
  });

  it("treats SSE 405 as an actionable transport mismatch", () => {
    const message = getActionableMcpErrorMessage([
      new Error(
        "MCP SSE Transport Error: 405. This server does not support SSE transport.",
      ),
    ]);
    expect(message).toContain("405");
  });

  it("prefers the fallback transport's error over an earlier SSE 405", () => {
    const message = getActionableMcpErrorMessage([
      new Error("MCP SSE Transport Error: 405"),
      new Error("unauthorized: missing token"),
    ]);
    expect(message).toContain("unauthorized");
    expect(message).toContain('Tried both "sse" and "http" transports.');
  });

  it("notes both transports were tried when both fail", () => {
    const message = getActionableMcpErrorMessage([
      new Error("MCP SSE Transport Error: 405"),
      new Error("http transport failed: socket hang up"),
    ]);
    expect(message).toContain("405");
    expect(message).toContain('Tried both "sse" and "http" transports.');
  });

  it("extracts OAuth error descriptions", () => {
    const message = getActionableMcpErrorMessage([
      new Error('{"error_description": "invalid client secret"}'),
    ]);
    expect(message).toBe("invalid client secret");
  });
});
