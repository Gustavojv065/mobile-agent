import bundledPrompts from "../../../catalog/chat-prompts.json";

import { fetchWithTimeout } from "@/core/fetch-with-timeout";

export const STARTER_PROMPTS_URL =
  "https://raw.githubusercontent.com/tecnicalbot/mobile-agent/refs/heads/main/catalog/chat-prompts.json";
export const STARTER_PROMPTS_REFRESH_MS = 5 * 60 * 1000;
export const MAX_STARTER_PROMPTS = 6;
export const MAX_STARTER_PROMPT_LABEL_LENGTH = 60;
export const MAX_STARTER_PROMPT_LENGTH = 2000;

export type StarterPrompt = { label: string; prompt: string };
export type StarterPrompts = { enabled: boolean; prompts: StarterPrompt[] };

export function parseStarterPrompts(value: unknown): StarterPrompts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Starter prompts must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.enabled !== "boolean") {
    throw new Error("Starter prompts require version 1 and an enabled boolean.");
  }
  if (!Array.isArray(record.prompts) || record.prompts.length > MAX_STARTER_PROMPTS) {
    throw new Error(`Starter prompts must contain at most ${MAX_STARTER_PROMPTS} entries.`);
  }

  const prompts = record.prompts.map((value): StarterPrompt => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Starter prompt must be an object.");
    }
    const prompt = value as Record<string, unknown>;
    if (typeof prompt.label !== "string" || !prompt.label.trim()) {
      throw new Error("Starter prompt requires a label.");
    }
    if (typeof prompt.prompt !== "string" || !prompt.prompt.trim()) {
      throw new Error("Starter prompt requires prompt text.");
    }
    const label = prompt.label.replace(/\s+/g, " ").trim();
    const text = prompt.prompt.trim();
    if (label.length > MAX_STARTER_PROMPT_LABEL_LENGTH) {
      throw new Error(
        `Starter prompt labels must be at most ${MAX_STARTER_PROMPT_LABEL_LENGTH} characters.`,
      );
    }
    if (text.length > MAX_STARTER_PROMPT_LENGTH) {
      throw new Error(
        `Starter prompts must be at most ${MAX_STARTER_PROMPT_LENGTH} characters.`,
      );
    }
    return { label, prompt: text };
  });

  if (record.enabled && !prompts.length) {
    throw new Error("Enabled starter prompts must contain at least one entry.");
  }
  return { enabled: record.enabled, prompts };
}

export const DEFAULT_STARTER_PROMPTS = parseStarterPrompts(bundledPrompts);

export async function fetchStarterPrompts(
  signal?: AbortSignal,
): Promise<StarterPrompts> {
  const response = await fetchWithTimeout(STARTER_PROMPTS_URL, {
    cache: "no-store",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Starter prompts request failed (${response.status}).`);
  }
  const body = await response.text();
  if (body.length > 16_384) throw new Error("Starter prompts response is too large.");
  return parseStarterPrompts(JSON.parse(body));
}
