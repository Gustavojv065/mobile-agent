"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Linking } from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import Constants from "expo-constants";
import * as Updates from "expo-updates";

import { createConfigRepository } from "@/core/db/repositories/config-repository";
import { createDrizzleDb } from "@/core/db/repositories/shared";
import {
  type AvailableRelease,
  type ReleaseNotes,
  checkForGitHubReleaseUpdate,
  fetchReleaseNotes,
  installAvailableRelease,
} from "@/modules/updates/github-release";
import { type OtaUiPhase, getOtaUiPhase } from "@/modules/updates/ota";

/** `app_settings` row holding the release tag the user chose to skip. */
const SKIPPED_RELEASE_TAG_KEY = "skipped_release_tag";
/** `app_settings` row holding the last OTA update the user pressed Close on. */
const OTA_ACKNOWLEDGED_UPDATE_KEY = "ota_acknowledged_update_id";
const OTA_ACK_RETRY_ATTEMPTS = 3;
const OTA_ACK_RETRY_MS = 300;

export type OtaUpdateState = {
  notes: ReleaseNotes | null;
  phase: OtaUiPhase;
  /** Persists the running update id so the drawer never returns for it. */
  acknowledge: () => void;
};

type UpdateContextType = {
  release: AvailableRelease | null;
  checking: boolean;
  installing: boolean;
  /** 0..1 while the APK transfers, `null` before the first progress event. */
  downloadProgress: number | null;
  ota: OtaUpdateState;
  bannerDismissed: boolean;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissUpdate: () => void;
  /**
   * Hides this release for good: the choice is persisted, so neither the
   * "what's new" drawer nor the banner comes back for the same tag — even
   * after the app restarts.
   */
  skipUpdate: () => Promise<void>;
};

const UpdateContext = createContext<UpdateContextType | null>(null);

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const sqlite = useSQLiteContext();
  const configRepository = useMemo(
    () => createConfigRepository(createDrizzleDb(sqlite)),
    [sqlite],
  );

  const dismissedTagRef = useRef<string | null>(null);
  const skippedTagRef = useRef<string | null>(null);
  // Kick off the persisted-skip read once; checks await it before surfacing a
  // release so a skipped tag can never flash the drawer on launch.
  const skippedTagLoadedRef = useRef<Promise<void> | null>(null);

  if (skippedTagLoadedRef.current === null) {
    skippedTagLoadedRef.current = configRepository
      .getSetting(SKIPPED_RELEASE_TAG_KEY)
      .then((tag) => {
        skippedTagRef.current = tag;
      })
      .catch((error) => {
        console.warn(error);
      });
  }

  const [release, setRelease] = useState<AvailableRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(
    null,
  );

  // Native OTA state machine: no extra network calls, expo-updates already
  // checks and downloads at launch and emits these updates as it goes.
  const updatesState = Updates.useUpdates();
  const runningUpdateId = updatesState.currentlyRunning.isEmbeddedLaunch
    ? null
    : (updatesState.currentlyRunning.updateId ?? null);

  const [otaAcknowledgedId, setOtaAcknowledgedId] = useState<string | null>(
    null,
  );
  const [otaAckReady, setOtaAckReady] = useState(false);
  const [otaNotes, setOtaNotes] = useState<ReleaseNotes | null>(null);
  // Acknowledgement waiting to be written (write failed once) — retried on
  // mount and on foreground so the drawer cannot come back after Close.
  const pendingOtaAckRef = useRef<string | null>(null);
  // The drawer may only render once the persisted acknowledgement is known:
  // a failed read would otherwise re-show it for an update that was already
  // closed. Read with backoff on mount, then again whenever the app
  // foregrounds — while unreadable, `otaAckReady` stays false and nothing is
  // offered at all.
  const otaAckInFlightRef = useRef(false);
  const loadOtaAck = useCallback(async () => {
    if (otaAckInFlightRef.current) return;
    otaAckInFlightRef.current = true;

    try {
      for (let attempt = 1; attempt <= OTA_ACK_RETRY_ATTEMPTS; attempt += 1) {
        try {
          const updateId = await configRepository.getSetting(
            OTA_ACKNOWLEDGED_UPDATE_KEY,
          );
          // A Close whose write is still queued is newer than anything on
          // disk — never let a foreground re-read talk it back open.
          if (!pendingOtaAckRef.current) {
            setOtaAcknowledgedId(updateId);
          }
          setOtaAckReady(true);
          return;
        } catch (error) {
          console.warn(error);
          if (attempt < OTA_ACK_RETRY_ATTEMPTS) {
            await new Promise((resolve) =>
              setTimeout(resolve, OTA_ACK_RETRY_MS * attempt),
            );
          }
        }
      }
    } finally {
      otaAckInFlightRef.current = false;
    }
  }, [configRepository]);

  useEffect(() => {
    void loadOtaAck();
  }, [loadOtaAck]);

  const otaPhase = otaAckReady
    ? getOtaUiPhase({
        acknowledgedUpdateId: otaAcknowledgedId,
        enabled: Updates.isEnabled,
        isEmbeddedLaunch: updatesState.currentlyRunning.isEmbeddedLaunch,
        updateId: runningUpdateId,
      })
    : "hidden";

  const checkForUpdates = useCallback(async () => {
    try {
      setChecking(true);

      const nextRelease = await checkForGitHubReleaseUpdate();
      await skippedTagLoadedRef.current;

      if (
        nextRelease &&
        (nextRelease.tagName === dismissedTagRef.current ||
          nextRelease.tagName === skippedTagRef.current)
      ) {
        return;
      }

      setRelease(nextRelease);
    } catch (error) {
      console.warn(error);
    } finally {
      setChecking(false);
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (!release) return;

    try {
      setInstalling(true);
      setDownloadProgress(null);
      await installAvailableRelease(release, (progress) => {
        setDownloadProgress(progress);
      });
    } catch (error) {
      console.error(error);
      await Linking.openURL(release.url);
    } finally {
      setInstalling(false);
      setDownloadProgress(null);
    }
  }, [release]);

  const dismissUpdate = useCallback(() => {
    if (!release) return;

    dismissedTagRef.current = release.tagName;
    setBannerDismissed(true);
  }, [release]);

  const skipUpdate = useCallback(async () => {
    const tagName = release?.tagName ?? skippedTagRef.current;

    if (!tagName) return;

    skippedTagRef.current = tagName;
    dismissedTagRef.current = tagName;
    setBannerDismissed(true);

    try {
      await configRepository.setSetting(SKIPPED_RELEASE_TAG_KEY, tagName);
    } catch (error) {
      console.warn(error);
    }
  }, [configRepository, release]);

  /**
   * Writes the acknowledgement with retries: a failed write would otherwise
   * let the drawer return on the next launch. If it still fails, the id stays
   * queued here and is retried on mount and whenever the app foregrounds.
   */
  const persistOtaAck = useCallback(
    async (updateId: string) => {
      for (let attempt = 1; attempt <= OTA_ACK_RETRY_ATTEMPTS; attempt += 1) {
        try {
          await configRepository.setSetting(
            OTA_ACKNOWLEDGED_UPDATE_KEY,
            updateId,
          );
          pendingOtaAckRef.current = null;
          return;
        } catch (error) {
          console.warn(error);
          if (attempt < OTA_ACK_RETRY_ATTEMPTS) {
            await new Promise((resolve) =>
              setTimeout(resolve, OTA_ACK_RETRY_MS * attempt),
            );
          }
        }
      }

      pendingOtaAckRef.current = updateId;
    },
    [configRepository],
  );

  const flushPendingOtaAck = useCallback(() => {
    const pending = pendingOtaAckRef.current;
    if (pending) void persistOtaAck(pending);
  }, [persistOtaAck]);

  const acknowledgeOtaUpdate = useCallback(() => {
    if (!runningUpdateId) return;

    // Memory first so the drawer closes instantly; the write trails behind.
    setOtaAcknowledgedId(runningUpdateId);
    pendingOtaAckRef.current = runningUpdateId;
    void persistOtaAck(runningUpdateId);
  }, [persistOtaAck, runningUpdateId]);

  useEffect(() => {
    flushPendingOtaAck();
  }, [flushPendingOtaAck]);

  useEffect(() => {
    // The running bundle has no notes of its own (eas update messages never
    // reach the client manifest), so fall back to the GitHub release published
    // for this app version — the changelog the OTA ships on top of.
    if (otaPhase !== "applied" || otaNotes) return;

    let cancelled = false;
    fetchReleaseNotes(Constants.expoConfig?.version ?? "0.0.0")
      .then((notes) => {
        if (!cancelled) setOtaNotes(notes);
      })
      .catch((error) => {
        console.warn(error);
      });

    return () => {
      cancelled = true;
    };
  }, [otaNotes, otaPhase]);

  useEffect(() => {
    // The launch check is network I/O — keep it off the startup critical
    // path. First check runs when the JS thread is idle plus a grace delay;
    // returning to the app still checks immediately via the listener below.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idleHandle: number | null = null;
    const schedule = () => {
      timer = setTimeout(() => {
        void checkForUpdates();
      }, 3000);
    };
    if (typeof requestIdleCallback === "function") {
      idleHandle = requestIdleCallback(schedule);
    } else {
      schedule();
    }

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void loadOtaAck();
        flushPendingOtaAck();
        checkForUpdates();
      }
    });

    return () => {
      subscription.remove();
      if (timer) clearTimeout(timer);
      if (idleHandle !== null && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(idleHandle);
      }
    };
  }, [checkForUpdates, flushPendingOtaAck, loadOtaAck]);

  return (
    <UpdateContext.Provider
      value={{
        bannerDismissed,
        downloadProgress,
        ota: {
          acknowledge: acknowledgeOtaUpdate,
          notes: otaNotes,
          phase: otaPhase,
        },
        release,
        checking,
        installing,
        checkForUpdates,
        installUpdate,
        dismissUpdate,
        skipUpdate,
      }}
    >
      {children}
    </UpdateContext.Provider>
  );
}

export function useUpdate() {
  const context = useContext(UpdateContext);

  if (!context) {
    throw new Error("useUpdate must be used inside UpdateProvider");
  }

  return context;
}
