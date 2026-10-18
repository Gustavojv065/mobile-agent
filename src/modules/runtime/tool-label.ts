/**
 * "viewFile" → "View File", "fetch_page" → "Fetch Page". Shared by the tool
 * approval drawer and the chat trace rows so tools read the same everywhere.
 */
import {
  Download,
  FileText,
  Globe,
  Image as ImageIcon,
  ListTodo,
  Pencil,
  type LucideIcon,
  Wrench,
} from "lucide-react-native";

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

// —─── Trace row helpers shared by chat rows and the approval drawer ────────

const TOOL_TRACE_ICONS: Record<string, LucideIcon> = {
  analyzeAudio: ImageIcon,
  browser: Globe,
  cancel_schedule: ListTodo,
  createDirectory: FileText,
  createFile: Pencil,
  deleteEntry: FileText,
  downloadFile: Download,
  edit: Pencil,
  exportWorkspaceFileToFolder: FileText,
  fetchPage: Globe,
  getVideoFrame: ImageIcon,
  glob: FileText,
  grep: FileText,
  importFolderFileToWorkspace: FileText,
  importSkillFromUrl: FileText,
  listDirectory: FileText,
  listFiles: FileText,
  list_schedules: ListTodo,
  manageAgent: Pencil,
  managePlugin: Pencil,
  manageSkill: Pencil,
  mergeDocuments: FileText,
  mergePdfs: FileText,
  moveEntry: FileText,
  ocr: ImageIcon,
  previewMix: ImageIcon,
  previewScene: ImageIcon,
  read: FileText,
  renameEntry: Pencil,
  renderVideo: ImageIcon,
  schedule_task: ListTodo,
  skill: FileText,
  skillReadFile: FileText,
  splitDocument: FileText,
  splitPdf: FileText,
};

const DEFAULT_TOOL_TRACE_ICON = Wrench;

/** The icon that names the tool kind in trace and approval rows. */
export function toolTraceIcon(toolName: string): LucideIcon {
  return TOOL_TRACE_ICONS[toolName] ?? DEFAULT_TOOL_TRACE_ICON;
}

/**
 * A short human object for trace titles/approvals, picked from the recorded
 * input summary (`name`, `url`, `query`…). Returns null when the summary
 * holds nothing readable — algorithmic ids never make it into titles.
 */
export function toolObjectLabel(inputSummary: string | null | undefined) {
  if (!inputSummary) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputSummary);
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed instanceof Error
  ) {
    return null;
  }

  const candidateKeys = [
    "name",
    "path",
    "file",
    "displayName",
    "title",
    "label",
    "url",
    "query",
    "pattern",
  ] as const;

  for (const key of candidateKeys) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || /^[a-z0-9_-]{16,}$/i.test(trimmed)) {
      continue;
    }
    return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
  }

  return null;
}
