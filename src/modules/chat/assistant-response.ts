import type { StoredMessage } from "@/core/types/app-state";

/** One footer per response, including all assistant segments separated by steers. */
export function getAssistantResponseFooters(
  messages: readonly Pick<StoredMessage, "id" | "role" | "content" | "metadata">[],
): Map<string, string> {
  const footers = new Map<string, string>();
  let lastAssistantId: string | undefined;
  let runId: string | undefined;
  let segments: string[] = [];

  const finishResponse = () => {
    if (lastAssistantId) {
      footers.set(lastAssistantId, segments.join("\n\n"));
    }
    lastAssistantId = undefined;
    runId = undefined;
    segments = [];
  };

  for (const message of messages) {
    if (message.role === "user") {
      if (!message.metadata?.steeredIntoRunId) finishResponse();
      continue;
    }
    if (message.role !== "assistant") continue;

    const messageRunId = message.metadata?.runId;
    if (runId && messageRunId && runId !== messageRunId) finishResponse();
    runId = messageRunId ?? runId;
    lastAssistantId = message.id;
    if (message.content.trim()) segments.push(message.content.trim());
  }
  finishResponse();

  return footers;
}

/** Native TTS has a per-utterance limit; queue chunks as one playback. */
export function splitSpeechText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  const limit = Math.max(1, Math.floor(maxLength));
  let remaining = text.trim();

  while (remaining.length > limit) {
    const boundary = remaining.lastIndexOf(" ", limit);
    let end = boundary > 0 ? boundary : limit;
    // Avoid splitting a surrogate pair when a long token has no whitespace.
    const lastChar = remaining.charCodeAt(end - 1);
    if (end > 1 && lastChar >= 0xd800 && lastChar <= 0xdbff) end -= 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}
