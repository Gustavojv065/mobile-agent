import { FileText, Presentation, FileSpreadsheet } from "lucide-react-native";

import type { WorkspaceFile } from "@/core/types/app-state";

/**
 * The kind-specific glyph for a non-image file row: presentations get a
 * slideshow icon, spreadsheets a grid, everything else a document. Shared by
 * the Library file list and the chat files drawer so the two never drift.
 */
export function FileRowIcon({
  color,
  file,
  size,
}: {
  color: string;
  file: WorkspaceFile;
  size: number;
}) {
  const lowerName = file.displayName.toLowerCase();

  if (lowerName.endsWith(".pptx")) {
    return <Presentation color={color} size={size} />;
  }

  if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
    return <FileSpreadsheet color={color} size={size} />;
  }

  return <FileText color={color} size={size} />;
}
