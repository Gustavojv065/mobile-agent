import type { AppStateSnapshot } from "@/core/types/app-state";

/** A foreground DB read must not undo attachments changed while it was loading. */
export function reconcileHydratedAttachments(
  hydrated: AppStateSnapshot,
  current: AppStateSnapshot,
  selectionChanged: boolean,
): AppStateSnapshot {
  if (
    !selectionChanged ||
    !current.currentConversation ||
    current.currentConversation.id !== hydrated.currentConversation?.id
  ) {
    return hydrated;
  }

  const selectedFileIds = current.currentSelectedFileIds;
  const selectedFiles = current.workspaceFiles.filter((file) =>
    selectedFileIds.includes(file.id),
  );
  const files = new Map(hydrated.workspaceFiles.map((file) => [file.id, file]));
  for (const file of selectedFiles) files.set(file.id, file);

  return {
    ...hydrated,
    currentSelectedFileIds: selectedFileIds,
    currentConversation: { ...hydrated.currentConversation, selectedFileIds },
    conversations: hydrated.conversations.map((conversation) =>
      conversation.id === current.currentConversation?.id
        ? { ...conversation, selectedFileIds }
        : conversation,
    ),
    workspaceFiles: [...files.values()],
  };
}
