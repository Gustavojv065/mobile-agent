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

import { createConfigRepository } from "@/core/db/repositories/config-repository";
import { createDrizzleDb } from "@/core/db/repositories/shared";
import {
  type AvailableRelease,
  checkForGitHubReleaseUpdate,
  installAvailableRelease,
} from "@/modules/updates/github-release";

/** `app_settings` row holding the release tag the user chose to skip. */
const SKIPPED_RELEASE_TAG_KEY = "skipped_release_tag";

type UpdateContextType = {
  release: AvailableRelease | null;
  checking: boolean;
  installing: boolean;
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
      await installAvailableRelease(release);
    } catch (error) {
      console.error(error);
      await Linking.openURL(release.url);
    } finally {
      setInstalling(false);
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
  }, [checkForUpdates]);

  return (
    <UpdateContext.Provider
      value={{
        bannerDismissed,
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
