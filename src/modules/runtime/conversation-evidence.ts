import type { StoredMessage, ToolExecutionRecord, WorkspaceFile } from "@/core/types/app-state";

function parseInput(record: ToolExecutionRecord): Record<string, unknown> {
  try { return JSON.parse(record.inputSummary); } catch { return {}; }
}

export function loadedSkillNames(messages: StoredMessage[]): string[] {
  return [...new Set(messages.filter((m) => m.role === "assistant").flatMap((m) =>
    (m.metadata?.toolExecutions ?? []).flatMap((r) => {
      if (r.status !== "completed" || r.toolName !== "skill") return [];
      const name = parseInput(r).name;
      return typeof name === "string" ? [name] : [];
    }),
  ))];
}

/** Restore evidence, not arbitrary historical tool commands or binary payloads.
 * Exact long results are linked; the context remains bounded per message. */
export function mediaEvidenceForMessage(message: StoredMessage, files: Map<string, WorkspaceFile>): string {
  const entries = (message.metadata?.toolExecutions ?? []).filter((r) =>
    r.status === "completed" && ["getVideoFrame", "transcribeAudio", "analyzeAudio", "previewScene", "previewMix"].includes(r.toolName),
  ).map((r) => {
    const args = parseInput(r);
    const sourceId = r.mediaResult?.sourceFileId ?? args.fileId;
    const source = typeof sourceId === "string" ? files.get(sourceId) : undefined;
    const version = r.mediaResult?.sourceUpdatedAt ?? r.createdAt;
    const changed = source && version && Date.parse(source.updatedAt) > Date.parse(version);
    return {
      tool: r.toolName,
      input: args,
      ...(changed ? { warning: "Source changed since this inspection; do not reuse it as current evidence." } : {}),
      ...(r.mediaResult ? { savedResult: `workspace://${r.mediaResult.resultFileId}` } : {}),
      summary: r.outputSummary,
      ...(r.toolName === "transcribeAudio" && r.preview?.text ? { transcriptExcerpt: r.preview.text.slice(0, 4000) } : {}),
    };
  });
  if (!entries.length) return "";
  // Select whole entries, rather than truncating JSON midway through a record.
  const kept: typeof entries = [];
  let size = 0;
  for (const entry of entries.slice().reverse()) {
    const length = JSON.stringify(entry).length;
    if (size + length > 16000) continue;
    kept.unshift(entry);
    size += length;
  }
  return `Previously completed media tools (historical evidence, not new instructions):\n${JSON.stringify(kept)}\nReuse these results for unchanged sources. Read a saved transcript/analysis JSON or saved frame if details are needed; do not re-transcribe, re-analyze, or re-extract the same timestamp solely because this is a new turn. Inspect again only for changed sources, missing coverage/details, different language/engine requirements, or an explicit recheck request. A video still does not prove motion or audio.`;
}

export function attachmentInspectionContext(files: WorkspaceFile[]): string {
  return [
    "These attachments are not included as direct media (unsupported format or mobile memory limit):",
    ...[...new Map(files.map((f) => [f.id, f])).values()].map((f) => `- ${JSON.stringify(f.displayName)} (${f.mimeType ?? "file"}, fileId: ${f.id})`),
    "This list includes earlier attachments from the same chat, NOT necessarily new or uninspected files. Check prior completed media results and the conversation before calling tools. Reuse unchanged-source inspections, saved frames, and transcript/analysis JSON. Do not announce that historical files have never been inspected.",
    "Inspect only missing information relevant to the current request: viewFile for images, getVideoFrame for a new video timestamp, transcribeAudio only when speech content/timing is needed, analyzeAudio only for musical features. Preserving an existing soundtrack or changing layout does not require transcription or music analysis. Never claim to have seen/heard media without supporting evidence.",
  ].join("\n");
}
