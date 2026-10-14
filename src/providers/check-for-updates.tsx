"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState, InteractionManager, Linking } from "react-native";

import {
  type AvailableRelease,
  checkForGitHubReleaseUpdate,
  installAvailableRelease,
} from "@/modules/updates/github-release";

type UpdateContextType = {
  release: AvailableRelease | null;
  checking: boolean;
  installing: boolean;
  bannerDismissed: boolean;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissUpdate: () => void;
};

const UpdateContext = createContext<UpdateContextType | null>(null);

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const dismissedTagRef = useRef<string | null>(null);

  const [release, setRelease] = useState<AvailableRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const checkForUpdates = useCallback(async () => {
    try {
      setChecking(true);

      const nextRelease = await checkForGitHubReleaseUpdate();

      if (nextRelease?.tagName !== dismissedTagRef.current) {
        setRelease(nextRelease);
      }
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

  useEffect(() => {
    // The launch check is network I/O — keep it off the startup critical
    // path. First check runs after interactions settle plus a grace delay;
    // returning to the app still checks immediately via the listener below.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const interaction = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => {
        void checkForUpdates();
      }, 3000);
    });

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        checkForUpdates();
      }
    });

    return () => {
      subscription.remove();
      if (timer) clearTimeout(timer);
      interaction.cancel();
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
