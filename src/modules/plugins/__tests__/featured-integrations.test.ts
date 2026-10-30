import { describe, expect, it } from "vitest";

import {
  FEATURED_INTEGRATIONS,
  findMobileMcpConnection,
} from "../featured-integrations";

describe("Mobile Agent integration directory", () => {
  it("lists all named integrations without claiming ChatGPT synchronization", () => {
    expect(FEATURED_INTEGRATIONS).toHaveLength(19);
    expect(new Set(FEATURED_INTEGRATIONS.map((entry) => entry.id)).size).toBe(19);
    expect(FEATURED_INTEGRATIONS.find((entry) => entry.id === "github")?.action).toBe("mcp");
    expect(FEATURED_INTEGRATIONS.find((entry) => entry.id === "plugin-creator")?.action).toBe("chatgpt");
  });

  it("routes only verified built-in MCP services to authorization", () => {
    const ids = FEATURED_INTEGRATIONS.filter((entry) => entry.action === "mcp")
      .map((entry) => entry.mcpPresetId).sort();
    expect(ids).toEqual(["github", "notion", "supabase"]);
    for (const item of FEATURED_INTEGRATIONS.filter((entry) => entry.action === "docs")) {
      expect(item.docsUrl?.startsWith("https://")).toBe(true);
    }
  });

  it("never marks a ChatGPT-only plugin as locally installed", () => {
    expect(
      findMobileMcpConnection(
        FEATURED_INTEGRATIONS.find((entry) => entry.id === "plugin-management")!,
        [{ url: "https://mcp.notion.com/mcp", enabled: true, lastStatus: "connected" }],
      ),
    ).toBe("unavailable");
  });

  it("shows MCP services as unconnected until verified by Mobile Agent", () => {
    const github = FEATURED_INTEGRATIONS.find((entry) => entry.id === "github")!;
    expect(findMobileMcpConnection(github, [])).toBe("disconnected");
    expect(
      findMobileMcpConnection(github, [
        { url: "https://api.githubcopilot.com/mcp/", enabled: true, lastStatus: "untested" },
      ]),
    ).toBe("configured");
    expect(
      findMobileMcpConnection(github, [
        { url: "https://api.githubcopilot.com/mcp/", enabled: false, lastStatus: "connected" },
      ]),
    ).toBe("configured");
    expect(
      findMobileMcpConnection(github, [
        { url: "https://api.githubcopilot.com/mcp", enabled: true, lastStatus: "connected" },
      ]),
    ).toBe("connected");
  });

  it("does not confuse a different remote URL with the official connector", () => {
    const supabase = FEATURED_INTEGRATIONS.find((entry) => entry.id === "supabase")!;
    expect(
      findMobileMcpConnection(supabase, [
        { url: "https://malicious.example/mcp", enabled: true, lastStatus: "connected" },
      ]),
    ).toBe("disconnected");
  });
});
