import { Image, type ImageRef } from "expo-image";
import { useEffect, useState } from "react";

import { createThumbnailQueue } from "@/modules/files/thumbnail-queue";

const enqueue = createThumbnailQueue(2);

/** Own the native reference; release it on recycle/unmount, including late loads. */
export function useWorkspaceThumbnail(uri: string, pixels: number) {
  const [loaded, setLoaded] = useState<{ uri: string; pixels: number; image: ImageRef } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let owned: ImageRef | null = null;
    void enqueue(
      () => Image.loadAsync({ uri, isAnimated: false }, { maxWidth: pixels, maxHeight: pixels }),
      controller.signal,
    ).then((image) => {
      if (!image) return;
      if (controller.signal.aborted) {
        image.release();
        return;
      }
      owned = image;
      setLoaded({ uri, pixels, image });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded(null);
    });
    return () => {
      controller.abort();
      owned?.release();
    };
  }, [uri, pixels]);
  return loaded?.uri === uri && loaded.pixels === pixels ? loaded.image : null;
}
