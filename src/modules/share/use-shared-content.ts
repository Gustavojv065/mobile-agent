import type { DocumentPickerAsset } from "expo-document-picker";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { Alert } from "react-native";

import type { WorkspaceFile } from "@/core/types/app-state";
import { useChat } from "@/hooks/use-chat";
import {
  consumeSharedContent,
  isShareTargetAvailable,
  subscribeToSharedContent,
} from "share-target";
import {
  joinSharedText,
  mergeSelectedFileIds,
  toImportAssets,
  type SharedContent,
} from "./shared-content";

type UseSharedContentOptions = {
  /** False while the database/config is still hydrating; shares wait in the native queue. */
  enabled: boolean;
  /** Drops shared text/links into the composer. */
  onInsertText: (text: string) => void;
};

/**
 * Imports content sent to Mobile Agent through the Android share sheet.
 *
 * Files are copied into the workspace and selected in the composer; text and
 * URLs are dropped into the composer. Shares that arrive before the app has
 * finished hydrating stay in the native queue and are imported once `enabled`
 * turns true.
 */
export function useSharedContent({
  enabled,
  onInsertText,
}: UseSharedContentOptions) {
  const router = useRouter();
  const {
    createConversation,
    currentConversation,
    currentSelectedFileIds,
    importFiles,
    setCurrentSelectedFileIds,
  } = useChat();

  const latestRef = useRef({
    createConversation,
    currentConversationId: currentConversation?.id ?? null,
    enabled,
    importFiles,
    onInsertText,
    router,
    selectedFileIds: currentSelectedFileIds,
    setSelectedFileIds: setCurrentSelectedFileIds,
  });

  latestRef.current = {
    createConversation,
    currentConversationId: currentConversation?.id ?? null,
    enabled,
    importFiles,
    onInsertText,
    router,
    selectedFileIds: currentSelectedFileIds,
    setSelectedFileIds: setCurrentSelectedFileIds,
  };

  // Shares are applied one at a time so two quick shares cannot race on the
  // conversation's selected-file ids.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const intake = useCallback(() => {
    if (!isShareTargetAvailable) return;

    queueRef.current = queueRef.current
      .then(async () => {
        if (!latestRef.current.enabled) return;

        const payloads = await consumeSharedContent();

        if (payloads.length === 0) return;

        await applySharedContent(payloads, latestRef);
      })
      .catch((error) => {
        console.error("[ShareTarget] Could not import shared content:", error);
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;

    intake();

    return subscribeToSharedContent(intake);
  }, [enabled, intake]);
}

type LatestShareState = {
  createConversation: () => Promise<void>;
  currentConversationId: string | null;
  enabled: boolean;
  importFiles: (assets: DocumentPickerAsset[]) => Promise<WorkspaceFile[]>;
  onInsertText: (text: string) => void;
  router: ReturnType<typeof useRouter>;
  selectedFileIds: string[];
  setSelectedFileIds: (ids: string[]) => Promise<void>;
};

async function applySharedContent(
  payloads: SharedContent[],
  latestRef: { current: LatestShareState },
) {
  const latest = latestRef.current;
  const assets = toImportAssets(payloads);
  let importedIds: string[] = [];

  if (assets.length > 0) {
    try {
      const imported = await latest.importFiles(assets);
      importedIds = imported.map((file) => file.id);
    } catch (error) {
      Alert.alert(
        "Could not attach shared files",
        error instanceof Error ? error.message : "Please try again.",
      );
    }
  }

  if (importedIds.length > 0) {
    // Hydration normally guarantees a conversation, but create one if the user
    // deleted the last chat while a share was in flight.
    if (!latestRef.current.currentConversationId) {
      try {
        await latestRef.current.createConversation();
        await nextFrame();
      } catch {
        // Keep the imported workspace files selectable from the Files drawer.
      }
    }

    const nextIds = mergeSelectedFileIds(
      latestRef.current.selectedFileIds,
      importedIds,
    );

    // Remember the merged selection immediately so a queued share does not
    // start from the pre-import render value.
    latestRef.current.selectedFileIds = nextIds;

    try {
      await latestRef.current.setSelectedFileIds(nextIds);
    } catch (error) {
      console.error("[ShareTarget] Could not select shared files:", error);
    }
  }

  const text = joinSharedText(payloads);

  if (text) {
    latest.onInsertText(text);
  }

  if (importedIds.length > 0 || text) {
    latest.router.dismissTo("/");
  }
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
