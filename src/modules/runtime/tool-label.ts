/**
 * "viewFile" → "View File", "fetch_page" → "Fetch Page". Shared by the tool
 * approval drawer and the chat trace rows so tools read the same everywhere.
 */
export function formatToolName(toolName: string) {
  if (!toolName) {
    return "Tool";
  }

  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

/**
 * The sentence verb for a tool's trace row. Write it as what already
 * happened: "Viewed", "Searched", "Failed to run" handles status.
 */
const TOOL_TRACE_VERBS: Record<string, string> = {
  analyzeAudio: "Analyzed",
  createFile: "Created",
  downloadFile: "Downloaded",
  edit: "Edited",
  fetchPage: "Fetched",
  getVideoFrame: "Grabbed a frame from",
  glob: "Searched",
  grep: "Searched",
  listFiles: "Listed",
  listVoices: "Listed voices with",
  list_schedules: "Listed schedules with",
  manageAgent: "Managed agents with",
  managePlugin: "Managed plugins with",
  manageSkill: "Managed skills with",
  mergeDocuments: "Merged",
  mergePdfs: "Merged",
  ocr: "Read text from",
  transcribeAudio: "Transcribed",
  viewFile: "Viewed",
};

export function toolTraceVerb(toolName: string) {
  return TOOL_TRACE_VERBS[toolName] ?? "Used";
}
