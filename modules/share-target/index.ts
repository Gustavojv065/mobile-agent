import { requireOptionalNativeModule, type NativeModule } from "expo";
import { Platform } from "react-native";

import type { SharedContent } from "@/modules/share/shared-content";

type ShareTargetEvents = {
  onSharedContent(): void;
};

declare class ShareTargetNativeModule extends NativeModule<ShareTargetEvents> {
  consumeSharedContent(): Promise<SharedContent[] | null>;
}

const ShareTarget =
  Platform.OS === "android"
    ? (requireOptionalNativeModule<ShareTargetNativeModule>("ShareTarget") ??
      null)
    : null;

export const isShareTargetAvailable = ShareTarget !== null;

/**
 * Drains the native share queue.
 *
 * Safe to call on every app start and on every `onSharedContent` event: the
 * native side returns each payload once. Returns an empty array when the module
 * is unavailable (web, iOS, or an older binary without the native module).
 */
export async function consumeSharedContent(): Promise<SharedContent[]> {
  if (!ShareTarget) return [];

  try {
    const payloads = await ShareTarget.consumeSharedContent();

    return Array.isArray(payloads) ? payloads.filter(isSharedContent) : [];
  } catch (error) {
    console.error("[ShareTarget] Could not read shared content:", error);
    return [];
  }
}

/** Notifies when a new share arrives while the app is already running. */
export function subscribeToSharedContent(callback: () => void): () => void {
  if (!ShareTarget) return () => {};

  const subscription = ShareTarget.addListener("onSharedContent", callback);

  return () => subscription.remove();
}

function isSharedContent(value: SharedContent | null): value is SharedContent {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray(value.files) &&
    (typeof value.text === "string" || value.text === null)
  );
}
