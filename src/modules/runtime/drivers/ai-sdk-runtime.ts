import { generateText, streamText, type LanguageModelUsage, type StepResult, type ToolSet } from "ai";
import { Platform } from "react-native";

import type {
  GenerateModelTextStreamParams,
  GenerateModelTextStreamResult,
  ProviderLanguageModel,
} from "@/modules/runtime/drivers/types";

export function shouldUseStreamingAISDK() {
  return (
    Platform.OS === "web" || Platform.OS === "android" || Platform.OS === "ios"
  );
}

function shouldFallbackToNonStreaming(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return /readablestream|streaming is not supported|async iterator/i.test(
    message,
  );
}

function getRawReasoningDetailsText(rawValue: unknown) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const choices = (rawValue as { choices?: unknown }).choices;

  if (!Array.isArray(choices)) {
    return null;
  }

  const delta = choices[0]?.delta;

  if (!delta || typeof delta !== "object") {
    return null;
  }

  const details = (delta as { reasoning_details?: unknown }).reasoning_details;

  if (typeof details === "string") {
    return details;
  }

  if (!Array.isArray(details)) {
    return null;
  }

  const text = details
    .map((detail) => {
      if (typeof detail === "string") {
        return detail;
      }

      if (!detail || typeof detail !== "object") {
        return "";
      }

      const record = detail as { summary?: unknown; text?: unknown };
      return typeof record.text === "string"
        ? record.text
        : typeof record.summary === "string"
          ? record.summary
          : "";
    })
    .join("");

  return text || null;
}

export async function generateViaAISDK(
  providerModel: ProviderLanguageModel,
  params: GenerateModelTextStreamParams,
) {
  return generateViaAISDKWithContinuation(providerModel, params, 0);
}

const CONTINUE_AFTER_TOOLS =
  "Continue the original task using the tool results above. Those tool calls already executed: do not repeat completed actions or re-render an existing output. If the requested output is still missing, finish it with the remaining tools. Otherwise provide the final response with the existing output links. Progress commentary before a tool call is not a final response.";

function needsToolFollowup(steps: StepResult<ToolSet>[], hasTools: boolean, text: string) {
  if (!hasTools) return false;
  const last = steps.at(-1);
  if (!last) return !text.trim();
  // Text in a tool-calling step is pre-tool commentary. It must not hide a
  // missing model response after that tool (including a subsequent blank step).
  return last.toolResults.length > 0 || (!last.text.trim() && last.finishReason === "stop");
}

function combineUsage(a: LanguageModelUsage | undefined, b: LanguageModelUsage | undefined): LanguageModelUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x: number | undefined, y: number | undefined) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    inputTokenDetails: {
      noCacheTokens: sum(a.inputTokenDetails.noCacheTokens, b.inputTokenDetails.noCacheTokens),
      cacheReadTokens: sum(a.inputTokenDetails.cacheReadTokens, b.inputTokenDetails.cacheReadTokens),
      cacheWriteTokens: sum(a.inputTokenDetails.cacheWriteTokens, b.inputTokenDetails.cacheWriteTokens),
    },
    outputTokenDetails: {
      textTokens: sum(a.outputTokenDetails.textTokens, b.outputTokenDetails.textTokens),
      reasoningTokens: sum(a.outputTokenDetails.reasoningTokens, b.outputTokenDetails.reasoningTokens),
    },
  };
}

function mergeContinuation(previous: GenerateModelTextStreamResult, next: GenerateModelTextStreamResult): GenerateModelTextStreamResult {
  return {
    ...next,
    text: previous.text + next.text,
    generatedFiles: [...(previous.generatedFiles ?? []), ...(next.generatedFiles ?? [])],
    toolResults: [...(previous.toolResults ?? []), ...(next.toolResults ?? [])],
    usage: combineUsage(previous.usage, next.usage),
  };
}

async function generateViaAISDKWithContinuation(
  providerModel: ProviderLanguageModel,
  params: GenerateModelTextStreamParams,
  emptyToolContinuationCount: number,
): Promise<GenerateModelTextStreamResult> {
  let finalText = "";
  let providerError: unknown;
  let rawReasoningActive = false;
  let lastRawReasoningDelta: string | null = null;
  const rawReasoningId = "reasoning-0";
  const endRawReasoning = () => {
    if (!rawReasoningActive) {
      return;
    }

    params.onEvent?.("reasoning-end", {
      id: rawReasoningId,
      type: "reasoning-end",
    });
    rawReasoningActive = false;
  };

  try {
    const result = streamText({
      abortSignal: params.abortSignal,
      headers: params.requestHeaders,
      includeRawChunks: params.model.transport === "openaiCompatible",
      model: providerModel,
      messages: params.messages,
      onChunk: ({ chunk }) => {
        if (chunk.type === "raw") {
          const text = getRawReasoningDetailsText(chunk.rawValue);

          if (text) {
            if (!rawReasoningActive) {
              params.onEvent?.("reasoning-start", {
                id: rawReasoningId,
                type: "reasoning-start",
              });
              rawReasoningActive = true;
            }

            params.onEvent?.("reasoning-delta", {
              id: rawReasoningId,
              text,
              type: "reasoning-delta",
            });
            lastRawReasoningDelta = text;
          }

          return;
        }

        if (
          chunk.type === "reasoning-delta" &&
          rawReasoningActive &&
          chunk.id === rawReasoningId &&
          chunk.text === lastRawReasoningDelta
        ) {
          lastRawReasoningDelta = null;
          return;
        }

        if (
          rawReasoningActive &&
          (chunk.type === "text-start" ||
            chunk.type === "tool-input-start" ||
            chunk.type === "finish")
        ) {
          endRawReasoning();
        }

        params.onEvent?.(chunk.type, chunk);
      },
      onError: ({ error }) => {
        providerError ??= error;
        params.onEvent?.("error", error);
      },
      onStepEnd: (step) => {
        params.onEvent?.("step-end", step);
      },
      onStepStart: (step) => {
        params.onEvent?.("step-start", step);
      },
      onToolExecutionEnd: (event) => {
        params.onEvent?.("tool-execution-end", event);
      },
      onToolExecutionStart: (event) => {
        params.onEvent?.("tool-execution-start", event);
      },
      providerOptions: params.providerOptions as any,
      ...(params.reasoning !== undefined
        ? { reasoning: params.reasoning }
        : {}),
      stopWhen: ({ steps }) => steps.length >= params.maxToolSteps,
      system: params.system,
      tools: params.tools,
    });

    // AI SDK result getters create derived promises that can reject before the
    // text stream reports the provider error. Attach handlers immediately so
    // React Native does not report those secondary rejections as unhandled.
    const textPromise = Promise.resolve(result.text);
    const filesPromise = Promise.resolve(result.files);
    const responseMessagesPromise = Promise.resolve(result.responseMessages);
    const toolResultsPromise = Promise.resolve(result.toolResults);
    const usagePromise = Promise.resolve(result.totalUsage);
    const stepsPromise = Promise.resolve(result.steps);
    const resultPromises = [
      textPromise,
      filesPromise,
      responseMessagesPromise,
      toolResultsPromise,
      usagePromise,
      stepsPromise,
    ];

    for (const promise of resultPromises) {
      void promise.catch(() => {});
    }

    drainAllResultPromises(result);

    try {
      for await (const delta of result.textStream) {
        finalText += delta;
        params.onDelta?.(delta);
      }

      endRawReasoning();
      const [, files, responseMessages, toolResults, usage, steps] =
        await Promise.all([
          textPromise,
          filesPromise,
          responseMessagesPromise,
          toolResultsPromise,
          usagePromise,
          stepsPromise,
        ]);

      if (params.abortSignal?.aborted) throw new Error("Request aborted.");
      if (providerError) throw providerError;
      // SDK getters only contain the final step's files/results. Keep earlier
      // renderVideo outputs when later tools or a final reply follow them.
      const allToolResults = steps.flatMap((step) => step.toolResults);
      const allFiles = steps.flatMap((step) => step.files);
      const current: GenerateModelTextStreamResult = {
        text: finalText,
        generatedFiles: allFiles.length > 0 ? allFiles : files,
        toolResults: allToolResults.length > 0 ? allToolResults : toolResults,
        usage,
        stepLimitReached: steps.length >= params.maxToolSteps && steps.at(-1)?.finishReason === "tool-calls",
      };
      if (needsToolFollowup(steps, (current.toolResults?.length ?? 0) > 0, finalText) && steps.length < params.maxToolSteps) {
        if (emptyToolContinuationCount >= 2) {
          throw new Error("The model stopped after tools without a final response after two recovery attempts. Completed tool outputs are preserved in the chat activity; ask to continue rather than repeat the task.");
        }
        const next = await generateViaAISDKWithContinuation(
          providerModel,
          {
            ...params,
            maxToolSteps: params.maxToolSteps - steps.length,
            messages: [
              ...params.messages,
              ...responseMessages,
              {
                role: "user",
                content:
                  CONTINUE_AFTER_TOOLS,
              },
            ],
          },
          emptyToolContinuationCount + 1,
        );
        return mergeContinuation(current, next);
      }

      return current;
    } catch (error) {
      // AI SDK exposes several derived promises. Drain all of them after a
      // failed stream so React Native does not report secondary unhandled
      // NoOutputGeneratedError rejections.
      await Promise.allSettled(resultPromises);
      const effectiveError = providerError ?? error;
      throw effectiveError;
    }
  } catch (error) {
    if (
      params.abortSignal?.aborted ||
      finalText.length > 0 ||
      !shouldFallbackToNonStreaming(error)
    ) {
      throw error;
    }

    return generateViaAISDKNonStreaming(providerModel, params);
  }
}

function chunkText(text: string) {
  const segments = text.match(/\S+\s*/g) ?? [text];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const segment of segments) {
    if ((currentChunk + segment).length > 28 && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = segment;
      continue;
    }

    currentChunk += segment;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length > 0 ? chunks : [text];
}

export async function generateViaAISDKNonStreaming(
  providerModel: ProviderLanguageModel,
  params: GenerateModelTextStreamParams,
  continuationCount = 0,
): Promise<GenerateModelTextStreamResult> {
  const result = await generateText({
    abortSignal: params.abortSignal,
    headers: params.requestHeaders,
    model: providerModel,
    messages: params.messages,
    onStepEnd: (step) => {
      params.onEvent?.("step-end", step);
    },
    onStepStart: (step) => {
      params.onEvent?.("step-start", step);
    },
    onToolExecutionEnd: (event) => {
      params.onEvent?.("tool-execution-end", event);
    },
    onToolExecutionStart: (event) => {
      params.onEvent?.("tool-execution-start", event);
    },
    providerOptions: params.providerOptions as any,
    ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
    stopWhen: ({ steps }) => steps.length >= params.maxToolSteps,
    system: params.system,
    tools: params.tools,
  });

  if (params.abortSignal?.aborted) throw new Error("Request aborted.");

  if (result.reasoningText?.trim()) {
    const reasoningId = `non-streaming-${Date.now()}`;
    params.onEvent?.("reasoning-start", {
      id: reasoningId,
      type: "reasoning-start",
    });
    params.onEvent?.("reasoning-delta", {
      id: reasoningId,
      text: result.reasoningText,
      type: "reasoning-delta",
    });
    params.onEvent?.("reasoning-end", {
      id: reasoningId,
      type: "reasoning-end",
    });
  }

  if (result.text) {
    for (const chunk of chunkText(result.text)) {
      if (params.abortSignal?.aborted) {
        throw new Error("Request aborted.");
      }

      params.onDelta?.(chunk);
    }
  }

  const allToolResults = result.steps.flatMap((step) => step.toolResults);
  const allFiles = result.steps.flatMap((step) => step.files);
  const current: GenerateModelTextStreamResult = {
    generatedFiles: allFiles.length > 0 ? allFiles : result.files,
    text: result.text,
    toolResults: allToolResults.length > 0 ? allToolResults : result.toolResults,
    usage: result.totalUsage,
    stepLimitReached:
      result.steps.length >= params.maxToolSteps &&
      result.steps.at(-1)?.finishReason === "tool-calls",
  };
  if (needsToolFollowup(result.steps, (current.toolResults?.length ?? 0) > 0, result.text) && result.steps.length < params.maxToolSteps) {
    if (continuationCount >= 2) throw new Error("The model stopped after tools without a final response after two recovery attempts. Ask to continue rather than repeat the task.");
    const next = await generateViaAISDKNonStreaming(providerModel, {
      ...params,
      maxToolSteps: params.maxToolSteps - result.steps.length,
      messages: [...params.messages, ...result.responseMessages, { role: "user", content: CONTINUE_AFTER_TOOLS }],
    }, continuationCount + 1);
    return mergeContinuation(current, next);
  }
  return current;
}

// When the AI SDK stream fails it rejects every promise returned by the
// `streamText` result getters. Attaching a no-op handler to each getter's
// derived promise marks it handled so React Native doesn't surface these
// secondary rejections as unhandled promise errors.
function drainAllResultPromises(
  result: unknown,
) {
  const promiseGetters = [
    "rawFinishReason",
    "reasoning",
    "reasoningText",
    "finalStep",
    "content",
    "providerMetadata",
    "warnings",
    "request",
    "sources",
    "toolCalls",
    "staticToolCalls",
    "dynamicToolCalls",
    "staticToolResults",
    "dynamicToolResults",
    "response",
    "finishReason",
    "totalUsage",
  ] as const;

  const record = result as Record<string, unknown>;

  for (const getterName of promiseGetters) {
    try {
      const value = record[getterName];
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as Promise<unknown>).catch === "function"
      ) {
        void (value as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Ignore getters that throw when the stream is already torn down.
    }
  }
}
