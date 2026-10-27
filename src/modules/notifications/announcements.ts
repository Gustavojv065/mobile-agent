import * as Speech from "expo-speech";
import { AppState, Platform } from "react-native";

import type { NotificationSettings } from "@/core/types/app-state";
import { splitSpeechText } from "@/modules/chat/assistant-response";

import {
  claimAnnouncement,
  type AnnouncementAppState,
  type AnnouncementKind,
  type AnnouncementPlatform,
} from "./announcement-policy";
import { isVoiceInputActive } from "./voice-input-state";

const NOTIFICATION_CHIME_LEAD_MS = 1_200;

function currentPlatform(): AnnouncementPlatform {
  return Platform.OS === "android"
    ? "android"
    : Platform.OS === "ios"
      ? "ios"
      : "web";
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function speakAsync(text: string) {
  const chunks = splitSpeechText(text, Speech.maxSpeechInputLength);

  if (chunks.length === 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    let index = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve();
    };

    // Never leave a finished run waiting on a missing TTS callback.
    timeout = setTimeout(() => {
      Speech.stop().catch(() => {});
      finish();
    }, 30_000);

    const speakNext = () => {
      if (index >= chunks.length) {
        finish();
        return;
      }

      const chunk = chunks[index];
      index += 1;

      try {
        Speech.speak(chunk, {
          onDone: speakNext,
          onError: () => finish(),
          onStopped: () => finish(),
        });
      } catch {
        finish();
      }
    };

    speakNext();
  });
}

/**
 * Speak a short announcement. The run-completion path awaits this so Android
 * keeps its foreground service alive until the utterance finishes.
 *
 * Resolves `true` when speech was started, `false` when policy skipped it.
 */
export async function announceAsync(input: {
  appState: AnnouncementAppState;
  conversationId: string;
  force?: boolean;
  kind: AnnouncementKind;
  settings: NotificationSettings;
  text: string;
}): Promise<boolean> {
  const text = input.text.replace(/\s+/g, " ").trim();

  if (!text) {
    return false;
  }

  const speechActive = await Speech.isSpeakingAsync().catch(() => false);
  const policyInput = {
    appState: input.appState,
    conversationId: input.conversationId,
    force: input.force ?? false,
    kind: input.kind,
    platform: currentPlatform(),
    settings: input.settings,
    speechActive,
    voiceInputActive: isVoiceInputActive(),
  };

  if (!claimAnnouncement(policyInput)) {
    return false;
  }

  // Let the notification chime land first instead of talking over it.
  await wait(NOTIFICATION_CHIME_LEAD_MS);

  // Conditions can change during the lead-in (dictation starts, the user
  // begins reading a message aloud, or iOS moves to the background).
  if (isVoiceInputActive()) {
    return false;
  }

  if (await Speech.isSpeakingAsync().catch(() => false)) {
    return false;
  }

  if (currentPlatform() === "ios" && AppState.currentState !== "active") {
    return false;
  }

  await speakAsync(text).catch(() => {});
  return true;
}
