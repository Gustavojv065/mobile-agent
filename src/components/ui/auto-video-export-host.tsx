import {
  activateKeepAwakeAsync,
  deactivateKeepAwake,
} from "expo-keep-awake";
import { File, Paths } from "expo-file-system";
import { Square } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import WebView, { type WebViewMessageEvent } from "react-native-webview";

import { downloadFile } from "@/core/services/download-service";
import { useTheme } from "@/hooks/use-theme";
import {
  subscribeAutoExport,
  type AutoExportRequest,
} from "@/modules/preview/video-auto-export";
import { buildVideoExportDocument } from "@/modules/preview/video-recorder";
import { VideoExportController } from "@/modules/preview/video-export-messages";
import { getHtmlVideoExportModule } from "html-video-export";

const KEEP_AWAKE_TAG = "mobile-agent-video-export";
const EXPORT_VIEWPORT_WIDTH = 1280;
const EXPORT_VIEWPORT_HEIGHT = 720;

type ExportJob =
  | { status: "recording"; progress: number }
  | { status: "finishing" };

/**
 * Renders one hidden WebView while a video export runs and saves the finished
 * MP4 to Downloads itself. Mounted in the root layout so it survives chat
 * navigation: switching chats (or any in-app screen) keeps the recording
 * going — the WebView keeps rendering because the activity stays visible.
 */
export function AutoVideoExportHost() {
  const theme = useTheme();
  const canAutoExport =
    Platform.OS === "android" && getHtmlVideoExportModule() !== null;

  const [pending, setPending] = useState<AutoExportRequest[]>([]);
  const [active, setActive] = useState<ExportJob | null>(null);
  const [documentHtml, setDocumentHtml] = useState<string | null>(null);

  const webViewRef = useRef<WebView>(null);
  const controllerRef = useRef<VideoExportController | null>(null);
  const fileRef = useRef<File | null>(null);
  const keepAwakeRef = useRef(false);

  const cleanupFile = useCallback((file: File) => {
    try {
      file.delete();
    } catch {
      // The cache file may already be gone.
    }
  }, []);

  const releaseKeepAwake = useCallback(() => {
    if (!keepAwakeRef.current) return;
    keepAwakeRef.current = false;
    void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
  }, []);

  const finishJob = useCallback(() => {
    controllerRef.current = null;
    setDocumentHtml(null);
    setActive(null);
    releaseKeepAwake();
  }, [releaseKeepAwake]);

  const abortCurrentFile = useCallback(() => {
    const file = fileRef.current;
    fileRef.current = null;
    if (file) cleanupFile(file);
  }, [cleanupFile]);

  const shareVideo = useCallback(
    async (file: File) => {
      try {
        const Sharing = await import("expo-sharing");
        await Sharing.shareAsync(file.uri, {
          dialogTitle: "Share video",
          mimeType: "video/mp4",
        });
      } catch (error) {
        Alert.alert(
          "Share failed",
          error instanceof Error
            ? error.message
            : "The video could not be shared.",
        );
      } finally {
        cleanupFile(file);
      }
    },
    [cleanupFile],
  );

  const stopExport = useCallback(() => {
    if (!active || active.status !== "recording") return;
    webViewRef.current?.injectJavaScript(
      "window.__cancelMobileAgentVideoExport ? (window.__cancelMobileAgentVideoExport(), true) : false;",
    );
    void controllerRef.current?.cancel();
    abortCurrentFile();
    finishJob();
  }, [abortCurrentFile, active, finishJob]);

  const beginExport = useCallback((html: string) => {
    const module = getHtmlVideoExportModule();
    if (!module) return;

    abortCurrentFile();
    const file = new File(Paths.cache, `video-${Date.now()}.mp4`);
    file.create({ overwrite: true, intermediates: true });
    fileRef.current = file;

    const finishExport = async (result: { uri: string; sizeBytes: number }) => {
      setActive({ status: "finishing" });
      try {
        const saved = await downloadFile(
          result.uri,
          `video-${Date.now()}.mp4`,
          "video/mp4",
        );
        if (!saved) {
          throw new Error("The video could not be saved to Downloads.");
        }
        Alert.alert("Video ready", `${saved.name} has been saved to Downloads.`, [
          { text: "Share", onPress: () => void shareVideo(file) },
          { text: "OK" },
        ]);
      } catch (error) {
        Alert.alert(
          "Video export failed",
          error instanceof Error
            ? error.message
            : "The video could not be saved.",
        );
        abortCurrentFile();
      }
    };

    const controller = new VideoExportController({
      outputPath: file.uri,
      module,
      onProgress: (progress) =>
        setActive({ status: "recording", progress }),
      onFinishing: () => setActive({ status: "finishing" }),
      onResult: (result) => {
        void finishExport(result).finally(finishJob);
      },
      onError: (message) => {
        Alert.alert("Video export failed", message);
        abortCurrentFile();
        finishJob();
      },
    });
    controllerRef.current = controller;
    setDocumentHtml(html);
    setActive({ status: "recording", progress: 0 });
    if (!keepAwakeRef.current) {
      keepAwakeRef.current = true;
      void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    }
  }, [abortCurrentFile, finishJob, shareVideo]);

  // Drain the queue one export at a time.
  useEffect(() => {
    if (active || pending.length === 0) return;
    const [next, ...rest] = pending;
    setPending(rest);
    beginExport(next.html);
  }, [active, beginExport, pending]);

  // Collect requests from the chat layer for as long as auto-export is usable.
  useEffect(() => {
    if (!canAutoExport) return;
    return subscribeAutoExport((request) => {
      setPending((current) => [...current, request]);
    });
  }, [canAutoExport]);

  // Stop the in-flight export and clean its temp file on unmount.
  useEffect(() => {
    return () => {
      void controllerRef.current?.cancel();
      abortCurrentFile();
      releaseKeepAwake();
    };
  }, [abortCurrentFile, releaseKeepAwake]);

  const attemptStart = (triesLeft: number) => {
    webViewRef.current?.injectJavaScript(
      "window.__startMobileAgentVideoExport ? (window.__startMobileAgentVideoExport(), true) : false;",
    );
    if (triesLeft > 0) {
      setTimeout(() => attemptStart(triesLeft - 1), 200);
    }
  };

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    void controllerRef.current?.handleMessage(event);
  }, []);

  if (!canAutoExport) return null;

  return (
    <>
      {documentHtml ? (
        <View
          pointerEvents="none"
          style={{
            backgroundColor: "transparent",
            height: EXPORT_VIEWPORT_HEIGHT,
            left: 0,
            opacity: 0.01,
            position: "absolute",
            top: 0,
            width: EXPORT_VIEWPORT_WIDTH,
          }}
        >
          <WebView
            ref={webViewRef}
            allowsInlineMediaPlayback
            originWhitelist={["http://*", "https://*"]}
            onLoadEnd={() => attemptStart(8)}
            onMessage={handleMessage}
            source={{ html: buildVideoExportDocument(documentHtml) }}
            style={{ backgroundColor: "transparent", flex: 1 }}
          />
        </View>
      ) : null}
      {active ? (
        <View
          className="absolute inset-x-0 z-50 items-center px-4"
          style={{ paddingTop: 48 }}
        >
          <View className="flex-row items-center gap-3 rounded-full border border-border bg-card px-4 py-2 shadow-sm dark:border-border-dark dark:bg-card-dark">
            <Text className="font-sans text-xs font-semibold text-foreground dark:text-foreground-dark">
              {active.status === "recording"
                ? `Recording video… ${Math.round(active.progress * 100)}%`
                : "Finalizing video…"}
            </Text>
            {active.status === "recording" ? (
              <Pressable
                accessibilityLabel="Stop video export"
                accessibilityRole="button"
                className="active:opacity-70"
                hitSlop={8}
                onPress={stopExport}
              >
                <Square color={theme.textSecondary} size={14} />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </>
  );
}