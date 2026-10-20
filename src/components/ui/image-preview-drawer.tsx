import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import * as Sharing from "expo-sharing";
import { Download, Share2 } from "lucide-react-native";
import { useState } from "react";
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

/** A plain uri-backed image shown in the shared preview drawer. */
export type MediaPreviewTarget = { alt: string; uri: string };

/**
 * Session-wide known aspect ratios (poster: real width ÷ height) keyed by
 * resolved uri. Without it, every image mounts at a 16:9 guess and jumps to
 * its real ratio on decode — a layout jump each time FlashList recycles the
 * row back in. Cache tabs: bounded, uri-keyed, cheap to hit.
 */
export const MEDIA_ASPECT_CACHE = new Map<string, number>();
const MEDIA_ASPECT_CACHE_LIMIT = 128;

export function rememberMediaAspectRatio(uri: string, ratio: number) {
  if (MEDIA_ASPECT_CACHE.size >= MEDIA_ASPECT_CACHE_LIMIT) {
    const oldest = MEDIA_ASPECT_CACHE.keys().next().value;
    if (oldest !== undefined) {
      MEDIA_ASPECT_CACHE.delete(oldest);
    }
  }
  MEDIA_ASPECT_CACHE.set(uri, ratio);
}

/** Caps how tall a preview can grow so it always fits inside the drawer body. */
const MAX_PREVIEW_HEIGHT = 420;

function PreviewUriImage({ uri }: { uri: string }) {
  const [aspectRatio, setAspectRatio] = useState(
    () => MEDIA_ASPECT_CACHE.get(uri) ?? 16 / 9,
  );
  // Yoga won't shrink a `width: "100%"` frame when `maxHeight` clamps a tall
  // portrait image — it just letterboxes inside a full-width box. So measure
  // the drawer's inner width and shrink-wrap the frame to the image instead:
  // width is the smaller of (space available) and (maxHeight × ratio), and the
  // height follows the ratio. The result always fits and never letterboxes,
  // and the wrapper's `alignItems: center` centers it horizontally.
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);

  const fittedWidth =
    availableWidth == null
      ? undefined
      : Math.min(availableWidth, MAX_PREVIEW_HEIGHT * aspectRatio);
  const fittedHeight =
    fittedWidth == undefined ? undefined : fittedWidth / aspectRatio;

  return (
    <View
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
      style={{ alignItems: "center", alignSelf: "stretch" }}
    >
      <Image
        cachePolicy="memory-disk"
        contentFit="contain"
        onLoad={(event) => {
          const { height, width } = event.source;
          if (width > 0 && height > 0) {
            rememberMediaAspectRatio(uri, width / height);
            setAspectRatio(width / height);
          }
        }}
        recyclingKey={uri}
        source={{ uri }}
        style={
          fittedWidth == null || fittedHeight == null
            ? // First paint, before we know the width: a full-width box capped
              // at the max height, so nothing overflows the drawer.
              { aspectRatio, maxHeight: MAX_PREVIEW_HEIGHT, width: "100%" }
            : { width: fittedWidth, height: fittedHeight }
        }
      />
    </View>
  );
}

/**
 * Bottom-sheet preview for a uri-backed image with save-to-gallery and share.
 * Shared between the chat message media cards and the Library screen so both
 * render the exact same preview with identical Save/Share behavior.
 */
export function ImagePreviewDrawer({ target, onDismiss }: { target: MediaPreviewTarget | null; onDismiss: () => void }) {
  const theme = useTheme();
  const [action, setAction] = useState<"download" | "share" | null>(null);

  const handleDownloadImage = async (image: { uri: string }) => {
    setAction("download");

    try {
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

      const localFile = await getLocalImageFile(image);

      await Asset.create(localFile.uri);

      Alert.alert("Image saved", "Image has been saved to your gallery.");
    } catch (error) {
      Alert.alert(
        "Download failed",
        error instanceof Error ? error.message : "Failed to save the image.",
      );
    } finally {
      setAction(null);
    }
  };

  const handleShareImage = async (image: { uri: string }) => {
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

      const localFile = await getLocalImageFile(image);

      await Sharing.shareAsync(localFile.uri, {
        dialogTitle: "Share generated image",
        mimeType: getImageMimeType(localFile.uri),
        UTI: "public.image",
      });
    } catch (error) {
      if (isUserCanceledShare(error)) {
        return;
      }

      Alert.alert(
        "Share failed",
        error instanceof Error ? error.message : "Failed to share the image.",
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
      open={target !== null}
    >
      <DrawerContent
        className="w-full max-w-full"
        contentClassName="max-w-full"
        showCloseButton
        showHandle
        size={720}
      >
        <DrawerHeader>
          <DrawerTitle>{target?.alt || "Image"}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="gap-sp-3" contentContainerClassName="gap-sp-3">
          {target ? <PreviewUriImage uri={target.uri} /> : null}
        </DrawerBody>
        <DrawerFooter className="flex-row gap-sp-2">
          <Button
            className="flex-1"
            leftIcon={<Download color={theme.text} size={16} />}
            loading={action === "download"}
            onPress={() => {
              if (!target) return;
              handleDownloadImage({ uri: target.uri }).catch(console.error);
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
              if (!target) return;
              handleShareImage({ uri: target.uri }).catch(console.error);
            }}
          >
            Share
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function getImageMimeType(uri: string) {
  const cleanUri = uri.split("?")[0].toLowerCase();

  if (cleanUri.endsWith(".jpg") || cleanUri.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (cleanUri.endsWith(".webp")) {
    return "image/webp";
  }

  return "image/png";
}

export function isUserCanceledShare(error: unknown) {
  return error instanceof Error && /cancel/i.test(error.message);
}

function getImageExtension(mimeType: string) {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  return "png";
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const getLocalImageFile = async (image: { uri: string }) => {
  const extension = getImageExtension(image.uri);
  const fileName = `generated-image-${Date.now()}.${extension}`;
  const localFile = new File(Paths.cache, fileName);

  if (image.uri.startsWith("data:")) {
    const comma = image.uri.indexOf(",");
    const meta = image.uri.slice(5, comma < 0 ? 5 : comma);
    const data = comma < 0 ? "" : image.uri.slice(comma + 1);
    const bytes = meta.includes(";base64")
      ? base64ToBytes(data)
      : new TextEncoder().encode(decodeURIComponent(data));
    localFile.create({ intermediates: true, overwrite: true });
    localFile.write(bytes);
    return localFile;
  }

  if (image.uri.startsWith("file://")) {
    return new File(image.uri);
  }

  if (image.uri.startsWith("content://")) {
    const sourceFile = new File(image.uri);
    sourceFile.copy(localFile, {
      overwrite: true,
    });

    return localFile;
  }

  const response = await fetch(image.uri);
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  localFile.create({
    overwrite: true,
    intermediates: true,
  });

  localFile.write(bytes);

  return localFile;
};
