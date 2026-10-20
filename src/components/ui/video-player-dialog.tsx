import * as Sharing from "expo-sharing";
import { useVideoPlayer, VideoView } from "expo-video";
import { Download, Share2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useTheme } from "@/hooks/use-theme";
import { getVideoPoster, toPlayableFileUri } from "@/modules/preview/video-poster";

export type VideoPlayerTarget = {
  displayName: string;
  localUri: string;
  mimeType: string;
};

// Matches the image drawer: caps how tall the frame grows so a 9:16 reel
// shrinks to fit instead of overflowing the drawer body.
const MAX_MEDIA_HEIGHT = 420;

/**
 * Bottom-sheet player for a rendered MP4. Opens from the in-chat video card and
 * offers playback plus save-to-gallery and share.
 */
export function VideoPlayerDialog({
  video,
  onDismiss,
}: {
  video: VideoPlayerTarget | null;
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const [action, setAction] = useState<"save" | "share" | null>(null);
  // Portrait/landscape/square — the frame follows the actual video, never a
  // hardcoded 16/9 box that letterboxes reels.
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);

  const playableUri = video ? toPlayableFileUri(video.localUri) : null;
  const player = useVideoPlayer(playableUri, (instance) => {
    instance.loop = false;
  });

  useEffect(() => {
    if (!playableUri) {
      setAspectRatio(null);
      return;
    }

    player.play();

    // The poster cache is shared with the chat card, so this is usually a
    // cache hit — dimensions are ready the moment the drawer opens.
    let cancelled = false;
    getVideoPoster(playableUri).then((thumbnail) => {
      if (cancelled || !thumbnail) {
        return;
      }
      if (thumbnail.width > 0 && thumbnail.height > 0) {
        setAspectRatio(thumbnail.width / thumbnail.height);
      }
    });

    return () => {
      cancelled = true;
      // The player instance is released when its source changes; pausing an
      // already-released instance throws, so guard the cleanup.
      try {
        player.pause();
      } catch {
        // Already released — nothing to pause.
      }
    };
  }, [player, playableUri]);

  const handleSave = async () => {
    if (!playableUri) return;
    setAction("save");

    try {
      // Loaded lazily so expo-media-library (a native-only module) is never
      // evaluated in the node/server-manifest bundle during `export:embed`.
      const { Asset, requestPermissionsAsync } = await import(
        "expo-media-library"
      );

      const permission = await requestPermissionsAsync(true);

      if (!permission.granted) {
        Alert.alert(
          "Permission required",
          "Please allow gallery access to save this video.",
        );
        return;
      }

      await Asset.create(playableUri);
      Alert.alert("Video saved", "The video has been saved to your gallery.");
    } catch (error) {
      Alert.alert(
        "Save failed",
        error instanceof Error ? error.message : "Failed to save the video.",
      );
    } finally {
      setAction(null);
    }
  };

  const handleShare = async () => {
    if (!playableUri || !video) return;
    setAction("share");

    try {
      const available = await Sharing.isAvailableAsync();

      if (!available) {
        Alert.alert(
          "Share unavailable",
          "Sharing is not available on this device.",
        );
        return;
      }

      await Sharing.shareAsync(playableUri, {
        dialogTitle: "Share video",
        mimeType: video.mimeType || "video/mp4",
        UTI: "public.movie",
      });
    } catch (error) {
      if (error instanceof Error && /cancel/i.test(error.message)) {
        return;
      }

      Alert.alert(
        "Share failed",
        error instanceof Error ? error.message : "Failed to share the video.",
      );
    } finally {
      setAction(null);
    }
  };

  return (
    <Drawer
      direction="bottom"
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      open={video !== null}
    >
      <DrawerContent
        className="w-full max-w-full"
        contentClassName="max-w-full"
        showCloseButton
        showHandle
        size={720}
      >
        <DrawerHeader>
          <DrawerTitle numberOfLines={1}>
            {video?.displayName ?? "Video"}
          </DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="gap-sp-3" contentContainerClassName="gap-sp-3">
          {video ? (
            // Same fit rule as the image drawer: cap the height and tie the
            // width to that cap so a 9:16 reel shrinks to fit the drawer
            // instead of overflowing it, and center the player horizontally.
            <View style={{ alignItems: "center", alignSelf: "stretch" }}>
              <VideoView
                contentFit="contain"
                fullscreenOptions={{ enable: true }}
                nativeControls
                player={player}
                style={{
                  aspectRatio: aspectRatio ?? 16 / 9,
                  maxHeight: MAX_MEDIA_HEIGHT,
                  maxWidth: MAX_MEDIA_HEIGHT * (aspectRatio ?? 16 / 9),
                  width: "100%",
                }}
                surfaceType="textureView"
              />
            </View>
          ) : null}
        </DrawerBody>
        <DrawerFooter className="flex-row gap-sp-2">
          <Button
            className="flex-1"
            leftIcon={<Download color={theme.text} size={16} />}
            loading={action === "save"}
            onPress={() => {
              handleSave().catch(console.error);
            }}
            variant="outline"
          >
            Save
          </Button>
          <Button
            className="flex-1"
            leftIcon={<Share2 color={theme.background} size={16} />}
            loading={action === "share"}
            onPress={() => {
              handleShare().catch(console.error);
            }}
          >
            Share
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
