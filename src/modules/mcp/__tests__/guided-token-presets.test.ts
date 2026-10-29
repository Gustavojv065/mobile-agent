import { describe, expect, it } from "vitest";
import {
  createGuidedTokenHeaders,
  getGuidedTokenServer,
  GUIDED_TOKEN_SERVERS,
} from "../guided-token-presets";

describe("guided MCP API-key setup", () => {
  const render = {
    id: "render",
    url: "https://mcp.render.com/mcp",
    authMode: "headers" as const,
    transport: "http" as const,
  };

  it("recognizes a pinned Render endpoint", () => {
    expect(getGuidedTokenServer(render)).toEqual(GUIDED_TOKEN_SERVERS.render);
    expect(getGuidedTokenServer({ ...render, url: render.url + "/" })).toEqual(
      GUIDED_TOKEN_SERVERS.render,
    );
  });

  it("never sends a key to an altered catalog address", () => {
    expect(
      getGuidedTokenServer({
        ...render,
        url: "https://not-render.example/mcp",
      }),
    ).toBeNull();
    expect(
      getGuidedTokenServer({
        ...render,
        url: "https://mcp.render.com/mcp?redirect=elsewhere",
      }),
    ).toBeNull();
    expect(getGuidedTokenServer({ ...render, authMode: "oauth" })).toBeNull();
    expect(getGuidedTokenServer({ ...render, transport: "sse" })).toBeNull();
  });

  it("builds a bearer header without exposing it in text labels", () => {
    expect(createGuidedTokenHeaders(GUIDED_TOKEN_SERVERS.render, " my-token ")).toEqual({
      Authorization: "Bearer my-token",
    });
  });

  it("builds API-key headers without a bearer prefix", () => {
    expect(
      createGuidedTokenHeaders(GUIDED_TOKEN_SERVERS["google-maps"], "my-key"),
    ).toEqual({ "X-Goog-Api-Key": "my-key" });
  });

  it("rejects blank and multiline secrets", () => {
    expect(() => createGuidedTokenHeaders(GUIDED_TOKEN_SERVERS.render, "")).toThrow();
    expect(() =>
      createGuidedTokenHeaders(GUIDED_TOKEN_SERVERS.render, "a b"),
    ).toThrow();
    expect(() =>
      createGuidedTokenHeaders(GUIDED_TOKEN_SERVERS.render, "abc\nX-Injected: value"),
    ).toThrow();
  });
});
