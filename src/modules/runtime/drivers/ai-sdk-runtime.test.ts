import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateViaAISDK, generateViaAISDKNonStreaming } from "./ai-sdk-runtime";
import type { GenerateModelTextStreamParams } from "./types";

const mocks = vi.hoisted(() => ({ stream: vi.fn(), generate: vi.fn() }));
vi.mock("ai", () => ({ streamText: mocks.stream, generateText: mocks.generate }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

const mediaResult = { type: "tool-result", toolCallId: "render-1", toolName: "renderVideo", output: { fileId: "mp4" } };
function usage(tokens = 1) {
  return {
    inputTokens: tokens, outputTokens: tokens, totalTokens: tokens * 2,
    inputTokenDetails: { noCacheTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: tokens, reasoningTokens: 0 },
  };
}
function step(text: string, toolResults: unknown[] = [], finishReason = "stop", files: unknown[] = []) {
  return { text, toolResults, finishReason, files };
}
function response(text: string, steps: ReturnType<typeof step>[]) {
  return {
    text, steps, files: steps.at(-1)?.files ?? [], toolResults: steps.at(-1)?.toolResults ?? [],
    responseMessages: [{ role: "tool", content: [mediaResult] }], totalUsage: usage(),
    textStream: (async function* () { if (text) yield text; })(),
  };
}
function params(extra: Partial<GenerateModelTextStreamParams> = {}): GenerateModelTextStreamParams {
  return { model: { transport: "openaiCompatible" }, messages: [], maxToolSteps: 20, ...extra } as GenerateModelTextStreamParams;
}

describe.each(["streaming", "non-streaming"])("tool follow-up recovery (%s)", (mode) => {
  const run = (p = params()) => mode === "streaming"
    ? generateViaAISDK("model" as never, p)
    : generateViaAISDKNonStreaming("model" as never, p);
  const mock = mode === "streaming" ? mocks.stream : mocks.generate;
  beforeEach(() => vi.resetAllMocks());

  it("continues after progress text plus tool execution and preserves prior outputs", async () => {
    const file = { mediaType: "image/png", uint8Array: new Uint8Array([1]) };
    mock.mockReturnValueOnce(response("Preparing.\n", [step("Preparing.\n", [mediaResult], "tool-calls", [file])]))
      .mockReturnValueOnce(response("Done: workspace://mp4", [step("Done: workspace://mp4")]));
    const onDelta = vi.fn();
    const result = await run(params({ onDelta }));
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0].stopWhen({ steps: Array(18) })).toBe(false);
    expect(mock.mock.calls[1][0].stopWhen({ steps: Array(19) })).toBe(true);
    expect(mock.mock.calls[1][0].messages.at(-1).content).toContain("do not repeat completed actions");
    expect(result.text).toBe("Preparing.\nDone: workspace://mp4");
    expect(result.toolResults).toEqual([mediaResult]);
    expect(result.generatedFiles).toEqual([file]);
    expect(result.usage?.totalTokens).toBe(4);
    expect(onDelta.mock.calls.map(([text]) => text).join("")).toBe(result.text);
  });

  it("recovers a blank final step despite earlier progress commentary", async () => {
    mock.mockReturnValueOnce(response("Preparing.", [step("Preparing.", [mediaResult]), step("")]))
      .mockReturnValueOnce(response("Done.", [step("Done.")]));
    expect((await run()).text).toBe("Preparing.Done.");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a completed run with a real post-tool final reply", async () => {
    mock.mockReturnValueOnce(response("Done.", [step("", [mediaResult], "tool-calls"), step("Done.")]));
    const result = await run();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.toolResults).toEqual([mediaResult]);
  });

  it("does not recover a text-only answer or a tool-step safety limit", async () => {
    mock.mockReturnValueOnce(response("Hello", [step("Hello")]));
    await run();
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockReturnValueOnce(response("Working", [step("Working", [mediaResult], "tool-calls")]));
    expect((await run(params({ maxToolSteps: 1 }))).stepLimitReached).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("bounds recovery and reports failure instead of a false success", async () => {
    mock.mockImplementation(() => response("Working.", [step("Working.", [mediaResult], "tool-calls")]));
    await expect(run()).rejects.toThrow("two recovery attempts");
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("does not recover after cancellation even if the SDK returns partial text", async () => {
    const controller = new AbortController();
    controller.abort();
    mock.mockReturnValueOnce(response("Working", [step("Working", [mediaResult])]));
    await expect(run(params({ abortSignal: controller.signal }))).rejects.toThrow("aborted");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
