import type { WorkspaceRepository } from "@/core/db/database";
import type { WorkspaceFile, ToolExecutionRecord } from "@/core/types/app-state";
import { createWorkspaceFileService } from "@/core/services/workspace-file-service";

/** Keep exact transcript timings/analysis curves reusable on later chat turns.
 * Trace summaries are only 240 chars and cannot replace the original result. */
export async function saveMediaResult(
  repository: WorkspaceRepository,
  source: WorkspaceFile,
  kind: "transcript" | "audio-analysis",
  output: object,
): Promise<ToolExecutionRecord["mediaResult"]> {
  try {
    const saved = await createWorkspaceFileService(repository).createTextFile({
      name: `${source.displayName}.${kind}.json`,
      mimeType: "application/json",
      content: JSON.stringify({ sourceFileId: source.id, sourceUpdatedAt: source.updatedAt, ...output }),
    });
    return { sourceFileId: source.id, sourceUpdatedAt: source.updatedAt, resultFileId: saved.id };
  } catch (error) {
    // A failed artifact write must not discard an expensive successful decode.
    console.warn("Could not persist reusable media result.", error);
    return undefined;
  }
}
