import { Download, Film, Monitor, Smartphone, X, Code, Eye, Square, Play, Pause } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { File, Paths } from "expo-file-system";
import { useSQLiteContext } from "expo-sqlite";
import { captureRef } from "react-native-view-shot";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";
import { createDrizzleDb } from "@/core/db/repositories/shared";
import { createWorkspaceRepository } from "@/core/db/repositories/workspace-repository";
import {
  hasWorkspaceRefs,
  inlineAudioAssets,
  inlineImageAssets,
  inlineVideoAssets,
} from "@/modules/preview/video-assets";
import { useTheme } from "@/hooks/use-theme";
import { downloadFile, downloadText } from "@/core/services/download-service";
import { buildCodeDocument } from "@/modules/preview/code-document";
import { withDesktopPreviewViewport } from "@/modules/preview/html-document";
import { createSceneDocument } from "@/modules/preview/scene-document";
import {
  buildScenePlayerScript,
  formatPlayerTime,
  getSceneDuration,
  SCENE_PLAYER_MESSAGE_TYPE,
} from "@/modules/preview/scene-player";
import { Slider } from "@/components/ui/slider";
import { handlePreviewDownloadMessage, PREVIEW_DOWNLOAD_HOOK } from "@/modules/preview/preview-downloads";
import { buildVideoExportDocument } from "@/modules/preview/video-recorder";
import { VideoExportController, type VideoExportResult } from "@/modules/preview/video-export-messages";
import { getHtmlVideoExportModule } from "html-video-export";

/**
 * CSS viewport width used for desktop rendering. Wide enough to trip the
 * `@media (min-width: …)` breakpoints of anything written for a laptop, which
 * is the whole point: the mobile-width web view always renders the phone
 * layout, so a responsive page cannot be checked without this.
 */
const DESKTOP_VIEWPORT_WIDTH = 1280;

/**
 * Keeps a capture busy indicator on screen long enough to be perceived. The
 * capture itself is usually faster than a single frame, so without this the
 * button would appear to do nothing.
 */
const MIN_CAPTURE_FEEDBACK_MS = 350;

type Viewport = "desktop" | "mobile";
type ViewMode = "code" | "preview";

export type CodePreviewDialogProps = {
  /** Complete HTML document, as built by `buildPreviewDocument`. Omit to open straight in source (code) mode. */
  html?: string;
  /** Raw fenced code, shown when the user switches to the code view. */
  code: string;
  language: string;
  /** Which mode the dialog opens in. Defaults to "preview" when `html` is present. */
  initialMode?: ViewMode;
  /** Base name for manual video exports (a .mp4 extension is added if missing). */
  exportFileName?: string;
  onDismiss: () => void;
};

/**
 * Full-screen code/preview viewer.
 *
 * Usually you open it for a rendered markup fence, but non-markup code can
 * open straight into the highlighted source view by omitting `html`.
 */
export function CodePreviewDialog({
  html = "",
  code,
  language,
  initialMode,
  exportFileName,
  onDismiss,
}: CodePreviewDialogProps) {
  return (
    <Drawer
      dismissible
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
      open
    >
      <DrawerContent contentClassName="max-w-full" showHandle>
        <CodePreviewContent
          code={code}
          html={html}
          initialMode={initialMode}
          language={language}
          exportFileName={exportFileName}
          onDismiss={onDismiss}
        />
      </DrawerContent>
    </Drawer>
  );
}

/**
 * Preview body without its own modal. Render this inside an already-open
 * drawer when switching to markup content so the modal itself never
 * unmounts/remounts (which reads as a blink).
 */
export function CodePreviewContent({
  html = "",
  code,
  language,
  initialMode,
  exportFileName,
  onDismiss,
}: CodePreviewDialogProps) {
  const theme = useTheme();
  // Without markup there is nothing to preview, so the dialog opens in (and is
  // locked to) the highlighted source view.
  const canPreview = html.trim().length > 0;
  const [viewport, setViewport] = useState<Viewport>("mobile");
  const [mode, setMode] = useState<ViewMode>(
    initialMode ?? (canPreview ? "preview" : "code"),
  );
  const [frame, setFrame] = useState<{ height: number; width: number } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  // Capture only the page frame, without the drawer controls.
  const frameRef = useRef<View>(null);
  const desktop = viewport === "desktop";
  // Fall back to unscaled until the first layout pass reports the real frame.
  const scale =
    desktop && frame && frame.width > 0
      ? frame.width / DESKTOP_VIEWPORT_WIDTH
      : 1;
  const codeHtml = useMemo(
    () => mode === "code" ? buildCodeDocument(code, language, theme) : "",
    [code, language, mode, theme],
  );
  const [videoExport, setVideoExport] = useState<{
    progress: number;
    status: "recording" | "finishing";
  } | null>(null);
  // Video-scene player (play/pause/seek without rendering). Only video
  // scenes — HTML defining window.MOBILE_AGENT_VIDEO — get the transport
  // bar, the render button, and the silent-preview treatment; plain HTML
  // keeps today's UI (viewport toggle, download) untouched.
  const sceneDuration = useMemo(() => getSceneDuration(html), [html]);
  const isVideoScene = sceneDuration != null;
  const sqlite = useSQLiteContext();
  const workspaceRepository = useMemo(
    () => createWorkspaceRepository(createDrizzleDb(sqlite)),
    [sqlite],
  );
  // The export records the page as loaded: workspace:// refs must be inlined
  // first (audio, images, clips — same order as the renderVideo tool), or the
  // media silently goes missing from the MP4. The preview page loads the
  // inlined document so what you see is what the export records.
  const sceneNeedsAssets = isVideoScene && hasWorkspaceRefs(html);
  const [inlinedSceneHtml, setInlinedSceneHtml] = useState<string | null>(null);
  const [sceneAssetsError, setSceneAssetsError] = useState<string | null>(null);
  useEffect(() => {
    if (!sceneNeedsAssets) {
      setInlinedSceneHtml(null);
      setSceneAssetsError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { html: audioHtml } = await inlineAudioAssets(html, workspaceRepository);
        const { html: imageHtml } = await inlineImageAssets(audioHtml, workspaceRepository);
        const { html: sceneHtml } = await inlineVideoAssets(imageHtml, workspaceRepository);
        if (!cancelled) {
          setInlinedSceneHtml(sceneHtml);
          setSceneAssetsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setInlinedSceneHtml(null);
          setSceneAssetsError(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [html, sceneNeedsAssets, workspaceRepository]);
  const exportHtml = inlinedSceneHtml ?? html;
  const sceneAssetsPending =
    sceneNeedsAssets && inlinedSceneHtml === null && sceneAssetsError === null;
  const previewHtml = useMemo(
    () =>
      desktop
        ? withDesktopPreviewViewport(exportHtml, DESKTOP_VIEWPORT_WIDTH, scale)
        : exportHtml,
    [desktop, exportHtml, scale],
  );
  const [playerTime, setPlayerTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const webViewRef = useRef<WebView>(null);
  const exportControllerRef = useRef<VideoExportController | null>(null);
  const exportFileRef = useRef<File | null>(null);
  // File-backed preview document: multi-MB inlined scenes exceed what
  // `source={{ html }}` can load, so the page reads from cache like the
  // hidden render/preview hosts do.
  const documentRef = useRef<ReturnType<typeof createSceneDocument> | null>(null);
  const [documentUri, setDocumentUri] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== "preview" || !canPreview || sceneAssetsPending) {
      return;
    }
    let document: ReturnType<typeof createSceneDocument> | null = null;
    try {
      document = createSceneDocument(buildVideoExportDocument(previewHtml));
    } catch (error) {
      setPlayerError(
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    documentRef.current?.dispose();
    documentRef.current = document;
    setDocumentUri(document.uri);
    return () => {
      if (documentRef.current === document) {
        documentRef.current?.dispose();
        documentRef.current = null;
      }
    };
  }, [canPreview, mode, previewHtml, sceneAssetsPending]);
  useEffect(() => {
    return () => {
      documentRef.current?.dispose();
      documentRef.current = null;
    };
  }, []);
  // Set once the export page answers (first progress/finish/result/error).
  // Start retries keep firing until then: an inlined scene document can take
  // seconds to parse, long past a fixed small retry budget.
  const exportStartedRef = useRef(false);
  const canExportVideo = Platform.OS === "android" && getHtmlVideoExportModule() !== null;

  const playerCommand = useCallback((command: string) => {
    webViewRef.current?.injectJavaScript(
      `window.__mobileAgentPlayer ? (window.__mobileAgentPlayer.${command}, true) : false;`,
    );
  }, []);

  const pausePlayer = useCallback(() => {
    playerCommand("pause()");
    setPlaying(false);
  }, [playerCommand]);

  const resetPlayer = useCallback(() => {
    playerCommand("pause()");
    setPlayerTime(0);
    setPlaying(false);
    setPlayerError(null);
  }, [playerCommand]);

  const togglePlay = useCallback(() => {
    if (sceneDuration == null) return;
    if (playing) {
      pausePlayer();
      return;
    }
    setPlayerError(null);
    if (playerTime >= sceneDuration - 0.05) {
      playerCommand("seek(0)");
      setPlayerTime(0);
    }
    playerCommand("play()");
    setPlaying(true);
  }, [pausePlayer, playerCommand, playerTime, playing, sceneDuration]);

  const seekPlayer = useCallback(
    (value: number) => {
      if (!Number.isFinite(value)) return;
      setPlayerTime(value);
      setPlayerError(null);
      playerCommand(`seek(${value})`);
    },
    [playerCommand],
  );

  const installPlayer = useCallback(() => {
    webViewRef.current?.injectJavaScript(`${buildScenePlayerScript()}\ntrue;`);
  }, []);
  const previousHtml = useRef(html);

  const cleanupExportFile = useCallback(() => {
    const file = exportFileRef.current;
    exportFileRef.current = null;
    if (file) {
      try {
        file.delete();
      } catch {
        // The cache file may already be gone.
      }
    }
  }, []);

  const shareVideo = useCallback(async (file: File) => {
    try {
      const Sharing = await import("expo-sharing");
      await Sharing.shareAsync(file.uri, {
        dialogTitle: "Share video",
        mimeType: "video/mp4",
      });
    } catch (error) {
      Alert.alert(
        "Share failed",
        error instanceof Error ? error.message : "The video could not be shared.",
      );
    } finally {
      cleanupExportFile();
    }
  }, [cleanupExportFile]);

  const stopExport = useCallback(() => {
    if (!videoExport) return;
    webViewRef.current?.injectJavaScript(
      "window.__cancelMobileAgentVideoExport ? (window.__cancelMobileAgentVideoExport(), true) : false;",
    );
    void exportControllerRef.current?.cancel();
    exportControllerRef.current = null;
    setVideoExport(null);
    cleanupExportFile();
  }, [cleanupExportFile, videoExport]);

  const handleExportVideo = useCallback(() => {
    if (videoExport || mode !== "preview") return;
    if (hasWorkspaceRefs(exportHtml)) {
      Alert.alert(
        "Video export unavailable",
        sceneAssetsError ??
          "This scene references workspace files that could not be loaded here. Ask the agent to render it with renderVideo instead.",
      );
      return;
    }
    // The recorder drives its own frames: stop the player first so the two
    // loops never fight over the canvas.
    pausePlayer();
    const module = getHtmlVideoExportModule();
    if (!module) return;

    cleanupExportFile();
    const file = new File(Paths.cache, `video-${Date.now()}.mp4`);
    file.create({ overwrite: true, intermediates: true });
    exportFileRef.current = file;

    const finishExport = async (result: VideoExportResult) => {
      setVideoExport({ progress: 1, status: "finishing" });
      try {
        const saved = await downloadFile(result.uri, exportVideoName(exportFileName), "video/mp4");
        if (!saved) throw new Error("The video could not be saved to Downloads.");
        Alert.alert("Video saved", `${saved.name} has been saved to Downloads${result.hasAudio ? " with audio" : ""}.`, [
          { text: "Share", onPress: () => void shareVideo(file) },
          { text: "OK", onPress: () => cleanupExportFile() },
        ]);
      } catch (error) {
        Alert.alert(
          "Export failed",
          error instanceof Error ? error.message : "The video could not be saved.",
        );
      }
    };

    const controller = new VideoExportController({
      onConsumed: (id) => webViewRef.current?.injectJavaScript(
        `window.__mobileAgentExportConsumed?.(${id}); true;`,
      ),
      outputPath: file.uri,
      module,
      onConfig: () => { exportStartedRef.current = true; },
      onProgress: (progress) => {
        exportStartedRef.current = true;
        setVideoExport({ progress, status: "recording" });
      },
      onFinishing: () => {
        exportStartedRef.current = true;
        setVideoExport({ progress: 1, status: "finishing" });
      },
      onResult: (result) => {
        exportStartedRef.current = true;
        void finishExport(result).finally(() => {
          exportControllerRef.current = null;
          setVideoExport(null);
        });
      },
      onError: (message) => {
        exportStartedRef.current = true;
        exportControllerRef.current = null;
        setVideoExport(null);
        cleanupExportFile();
        Alert.alert("Video export failed", message);
      },
    });
    exportControllerRef.current = controller;
    exportStartedRef.current = false;
    setVideoExport({ progress: 0, status: "recording" });

    // The recorder script ships inside the document, so injectJavaScript may
    // run before the page evaluated it — especially with an inlined multi-MB
    // scene that needs seconds to parse. Retrying is safe: `start` ignores
    // calls while an export is already running. Retries stop once the page
    // answers, when the user stops, or after ~15 s with a loud failure
    // instead of a silent hang at 0%.
    const attemptStart = (triesLeft: number) => {
      if (exportControllerRef.current !== controller) return;
      if (exportStartedRef.current) return;
      webViewRef.current?.injectJavaScript(
        "window.__startMobileAgentVideoExport ? (window.__startMobileAgentVideoExport(), true) : false;",
      );
      if (triesLeft > 0) {
        setTimeout(() => attemptStart(triesLeft - 1), 200);
      } else {
        exportControllerRef.current = null;
        setVideoExport(null);
        cleanupExportFile();
        Alert.alert(
          "Video export failed",
          "The export page did not start. Close the preview and try again, or ask the agent to render it with renderVideo.",
        );
      }
    };
    attemptStart(75);
  }, [cleanupExportFile, exportFileName, exportHtml, mode, pausePlayer, sceneAssetsError, shareVideo, videoExport]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as {
        type?: unknown;
        t?: unknown;
        playing?: unknown;
        error?: unknown;
      } | null;
      if (payload && typeof payload === "object" && payload.type === SCENE_PLAYER_MESSAGE_TYPE) {
        if (typeof payload.t === "number" && Number.isFinite(payload.t)) {
          setPlayerTime(payload.t);
        }
        if (typeof payload.playing === "boolean") {
          setPlaying(payload.playing);
        }
        if (typeof payload.error === "string" && payload.error) {
          setPlayerError(payload.error);
        }
        return;
      }
    } catch {
      // Not a player message: fall through to the other handlers.
    }
    void handlePreviewDownloadMessage(event);
    void exportControllerRef.current?.handleMessage(event);
  }, []);

  // A new message replaces the document, so any in-flight export is stale.
  useEffect(() => {
    if (previousHtml.current === html) return;
    previousHtml.current = html;
    resetPlayer();
    webViewRef.current?.injectJavaScript(
      "window.__cancelMobileAgentVideoExport ? (window.__cancelMobileAgentVideoExport(), true) : false;",
    );
    void exportControllerRef.current?.cancel();
    exportControllerRef.current = null;
    setVideoExport(null);
    cleanupExportFile();
  }, [cleanupExportFile, html, resetPlayer]);

  // Leaving preview mode tears down the player page.
  useEffect(() => {
    if (mode === "preview") return;
    resetPlayer();
  }, [mode, resetPlayer]);

  // Tear down the export and its temp file when the preview unmounts.
  useEffect(() => {
    return () => {
      playerCommand("pause()");
      void exportControllerRef.current?.cancel();
      exportControllerRef.current = null;
      cleanupExportFile();
    };
  }, [cleanupExportFile, playerCommand]);

  const handleSave = useCallback(async () => {
    if (saving || !frameRef.current) {
      return;
    }

    setSaving(true);
    const startedAt = Date.now();

    try {
      if (mode === "code") {
        const extension = ["html", "htm", "svg", "xml"].includes(language.toLowerCase())
          ? language.toLowerCase() : "txt";
        const name = `code-${Date.now()}.${extension}`;
        const mimeType = extension === "svg" ? "image/svg+xml"
          : extension === "xml" ? "application/xml"
          : extension === "txt" ? "text/plain" : "text/html";
        const result = await downloadText(code, name, mimeType);
        if (result) Alert.alert("Code saved", `${result.name} has been saved to Downloads.`);
        return;
      }
      const uri = await captureRef(frameRef, {
        format: "png",
        quality: 1,
        result: "tmpfile",
      });

      // Loaded lazily so expo-media-library (a native-only module) is never
      // evaluated in the node/server-manifest bundle during `export:embed`.
      const {
        Asset,
        requestPermissionsAsync,
      } = await import("expo-media-library");

      const permission = await requestPermissionsAsync(true);

      if (!permission.granted) {
        Alert.alert(
          "Permission required",
          "Please allow photo access to save this image.",
        );
        return;
      }

      await Asset.create(uri);

      Alert.alert("Image saved", "The preview has been saved to your gallery.");
    } catch (error) {
      Alert.alert(
        "Download failed",
        error instanceof Error ? error.message : "Failed to save the file.",
      );
    } finally {
      // Hold the spinner long enough to be seen, otherwise the button appears
      // inert and users tap it repeatedly.
      const elapsed = Date.now() - startedAt;

      if (elapsed < MIN_CAPTURE_FEEDBACK_MS) {
        await new Promise((resolve) => {
          setTimeout(resolve, MIN_CAPTURE_FEEDBACK_MS - elapsed);
        });
      }

      setSaving(false);
    }
  }, [code, language, mode, saving]);

  const handleLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const { height, width } = nativeEvent.layout;
    setFrame((previous) =>
      previous && previous.width === width && previous.height === height
        ? previous
        : { height, width },
    );
  }, []);

  return (
    <>
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1 gap-1">
            <DrawerTitle>Preview</DrawerTitle>
            <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
              {language.toUpperCase()} ·{" "}
              {mode === "code"
                ? "Source"
                : desktop
                  ? `${DESKTOP_VIEWPORT_WIDTH}px desktop viewport`
                  : "Fits your screen"}
            </Text>
          </View>
          {canPreview ? (
            <ViewModeToggle
              value={mode}
              onChange={setMode}
              disabled={saving || videoExport !== null}
            />
          ) : null}
          {canExportVideo && mode === "preview" && isVideoScene ? (
            <ExportVideoButton
              disabled={videoExport !== null || !frame}
              onPress={handleExportVideo}
            />
          ) : null}
          {isVideoScene && mode === "preview" ? null : (
            <SavePreviewButton
              mode={mode}
              disabled={saving || videoExport !== null || !frame}
              onPress={handleSave}
              saving={saving}
            />
          )}
          <DrawerClose asChild>
            <Pressable
              accessibilityLabel="Close preview"
              className="h-11 w-11 items-center justify-center rounded-full bg-card dark:bg-card-dark"
            >
              <X color={theme.text} size={20} />
            </Pressable>
          </DrawerClose>
        </View>
        {mode === "preview" ? (
          videoExport ? (
            <VideoExportProgress
              progress={videoExport.progress}
              status={videoExport.status}
              onStop={stopExport}
            />
          ) : isVideoScene ? null : (
            <ViewportToggle value={viewport} onChange={setViewport} />
          )
        ) : null}
        {/*
          `flex-1` with a zero basis, so this frame's size comes from the drawer
          and never from the page inside it. That keeps the measured width — and
          therefore the desktop scale — independent of what is being rendered.
        */}
        <View
          className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card dark:border-border-dark dark:bg-card-dark"
          onLayout={handleLayout}
          ref={frameRef}
        >
          {frame && frame.width > 0 && frame.height > 0 ? (
            mode === "code" ? (
              <WebView
                key="source"
                javaScriptEnabled={false}
                originWhitelist={["about:blank"]}
                scrollEnabled
                nestedScrollEnabled
                showsHorizontalScrollIndicator
                showsVerticalScrollIndicator
                source={{ html: codeHtml }}
                style={{ backgroundColor: theme.backgroundElement, flex: 1 }}
              />
            ) : (
              <View style={{ flex: 1 }}>
                <WebView
                  key={viewport}
                  ref={webViewRef}
                  allowFileAccess
                  allowsInlineMediaPlayback
                  originWhitelist={["file://*", "http://*", "https://*"]}
                  scrollEnabled
                  setSupportMultipleWindows={false}
                  injectedJavaScript={PREVIEW_DOWNLOAD_HOOK}
                  onLoadEnd={installPlayer}
                  onMessage={handleMessage}
                  source={documentUri ? { uri: documentUri } : undefined}
                  style={{ backgroundColor: theme.backgroundElement, flex: 1 }}
                />
              </View>
            )
          ) : null}
        </View>
        {mode === "preview" &&
        isVideoScene &&
        sceneDuration != null &&
        !videoExport ? (
          <View className="gap-1 pt-2">
            <View className="flex-row items-center gap-3">
              <Pressable
                accessibilityLabel={playing ? "Pause scene" : "Play scene"}
                accessibilityRole="button"
                className="h-11 w-11 items-center justify-center rounded-full bg-card dark:bg-card-dark"
                onPress={togglePlay}
              >
                {playing ? (
                  <Pause color={theme.text} size={20} />
                ) : (
                  <Play color={theme.text} size={20} />
                )}
              </Pressable>
              <View className="min-w-0 flex-1">
                <Slider
                  accessibilityLabel="Scene time"
                  maximumValue={sceneDuration}
                  minimumValue={0}
                  onValueChange={seekPlayer}
                  step={0.05}
                  value={Math.min(playerTime, sceneDuration)}
                />
              </View>
              <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
                {formatPlayerTime(playerTime)} /{" "}
                {formatPlayerTime(sceneDuration)}
              </Text>
            </View>
            <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
              Silent preview — sound only plays after render.
            </Text>
            {playerError ? (
              <Text className="font-sans text-xs text-red-500">
                {playerError}
              </Text>
            ) : null}
          </View>
        ) : null}
    </>
  );
}

/**
 * Names a manual export after the scene when possible so it can be found in
 * Downloads; otherwise falls back to the old timestamped name.
 */
function exportVideoName(exportFileName: string | undefined): string {
  const base = (exportFileName ?? "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .trim()
    .replace(/\.mp4$/i, "");
  const safe = base || `video-${Date.now()}`;
  return `${safe}.mp4`;
}

/**
 * Saves raw source in code mode and the visible preview to the gallery otherwise.
 * Disabled until the frame is measured to avoid capturing an empty image.
 */
function SavePreviewButton({
  mode,
  disabled,
  onPress,
  saving,
}: {
  mode: ViewMode;
  disabled: boolean;
  onPress: () => void;
  saving: boolean;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityLabel={mode === "code" ? "Download source code" : "Save preview as image"}
      accessibilityRole="button"
      className="h-11 w-11 items-center justify-center rounded-full bg-card dark:bg-card-dark active:opacity-70"
      disabled={disabled}
      onPress={onPress}
      style={{ opacity: disabled && !saving ? 0.4 : 1 }}
    >
      {saving ? (
        <ActivityIndicator color={theme.text} size="small" />
      ) : (
        <Download color={theme.text} size={20} />
      )}
    </Pressable>
  );
}

function ViewModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: ViewMode;
  onChange: (value: ViewMode) => void;
  disabled: boolean;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityLabel={value === "preview" ? "Show code" : "Show preview"}
      accessibilityRole="button"
      className="h-11 w-11 items-center justify-center rounded-full bg-card dark:bg-card-dark active:opacity-70"
      disabled={disabled}
      onPress={() => onChange(value === "preview" ? "code" : "preview")}
    >
      {value === "preview" ? <Code color={theme.text} size={20} /> : <Eye color={theme.text} size={20} />}
    </Pressable>
  );
}

function ViewportToggle({
  value,
  onChange,
}: {
  value: Viewport;
  onChange: (value: Viewport) => void;
}) {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="tablist"
      className="flex-row gap-1 overflow-hidden rounded-xl bg-card p-1 dark:bg-card-dark"
    >
      {(
        [
          { label: "Mobile", value: "mobile" },
          { label: "Desktop", value: "desktop" },
        ] as const
      ).map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            accessibilityLabel={`${option.label} view`}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => {
              onChange(option.value);
            }}
            className="h-11 flex-1 flex-row items-center justify-center gap-2 rounded-lg active:opacity-70"
            style={{
              backgroundColor: selected
                ? theme.backgroundSelected
                : "transparent",
            }}
          >
            {option.value === "mobile" ? (
              <Smartphone
                color={selected ? theme.text : theme.textSecondary}
                size={18}
              />
            ) : (
              <Monitor
                color={selected ? theme.text : theme.textSecondary}
                size={18}
              />
            )}
            <Text
              className="font-sans text-sm font-semibold"
              style={{ color: selected ? theme.text : theme.textSecondary }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Starts exporting the preview as an MP4 from the page's
 * `window.MOBILE_AGENT_VIDEO` contract. Android-only: the native
 * `html-video-export` module does the muxing/encoding.
 */
function ExportVideoButton({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityLabel="Export preview as MP4 video"
      accessibilityRole="button"
      className="h-11 w-11 items-center justify-center rounded-full bg-card dark:bg-card-dark active:opacity-70"
      disabled={disabled}
      onPress={onPress}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <Film color={theme.text} size={20} />
    </Pressable>
  );
}

/** Live export progress bar with a stop button while frames are recorded. */
function VideoExportProgress({
  progress,
  status,
  onStop,
}: {
  progress: number;
  status: "recording" | "finishing";
  onStop: () => void;
}) {
  const theme = useTheme();
  const percent = Math.round(progress * 100);

  return (
    <View className="flex-row items-center gap-3 rounded-xl bg-card p-3 dark:bg-card-dark">
      <View
        className="h-2 flex-1 overflow-hidden rounded-full"
        style={{ backgroundColor: theme.backgroundElement }}
      >
        <View
          className="h-full rounded-full"
          style={{ backgroundColor: theme.text, width: `${percent}%` }}
        />
      </View>
      <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
        {status === "recording" ? `Recording ${percent}%` : "Finalizing…"}
      </Text>
      {status === "recording" ? (
        <Pressable
          accessibilityLabel="Stop video export"
          accessibilityRole="button"
          className="h-8 w-8 items-center justify-center rounded-full active:opacity-70"
          onPress={onStop}
        >
          <Square color={theme.text} size={16} />
        </Pressable>
      ) : null}
    </View>
  );
}
