import type { ToolExecutionRecord } from "@/core/types/app-state";

const RESOURCE_TOOLS = new Set([
  "read", "write", "edit", "createFile", "viewFile", "updateDocument", "skill", "skillReadFile",
]);

export function hasLegacyToolResource(record: ToolExecutionRecord) {
  return !record.preview && !record.diff && record.status === "completed" && RESOURCE_TOOLS.has(record.toolName);
}

/** Old summaries can end halfway through JSON. Recover only complete string fields. */
export function readToolResourceReference(record: ToolExecutionRecord) {
  const field = (source: string | null, name: string): string | undefined => {
    if (!source) return undefined;
    const match = source.match(new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
    if (!match) return undefined;
    try { return JSON.parse(match[1]) as string; } catch { return undefined; }
  };
  const get = (name: string) => field(record.outputSummary, name) ?? field(record.inputSummary, name);
  return {
    fileId: get("fileId"),
    displayName: get("displayName"),
    skillName: get("name") ?? get("title"),
    path: get("path"),
  };
}
