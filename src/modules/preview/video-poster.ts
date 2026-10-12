import { createVideoPlayer, type VideoThumbnail } from "expo-video";

/**
 * `expo-file-system` can hand back a `file:/path` URI (single slash), which
 * ExoPlayer tolerates but `MediaMetadataRetriever` (used for thumbnails)
 * rejects — it only treats `file://` as a file URL and attempts a network
 * fetch otherwise. Normalize defensively so both playback and thumbnails get
 * the canonical `file:///path` form.
 */
export function toPlayableFileUri(uri: string) {
  if (uri.startsWith("file://")) return uri;

  if (uri.startsWith("file:")) {
    const rest = uri.slice("file:".length);
    return rest.startsWith("/") ? `file://${rest}` : `file:///${rest}`;
  }

  return uri;
}

/**
 * First-frame posters for local MP4s, decoded on demand through expo-video's
 * headless thumbnail API (no extra native dependency).
 *
 * The player is created just to decode the frame and released immediately; the
 * returned thumbnail is a standalone native image reference that stays valid
 * as an expo-image source afterwards.
 *
 * Results are memoized per source URI so each video is decoded once per
 * session. Failures resolve to `null` and callers fall back to a plain
 * play-button tile.
 */
const posterCache = new Map<string, Promise<VideoThumbnail | null>>();
const MAX_CACHED_POSTERS = 24;

export function getVideoPoster(
  sourceUri: string,
): Promise<VideoThumbnail | null> {
  const cached = posterCache.get(sourceUri);
  if (cached) {
    return cached;
  }

  const pending = generatePoster(sourceUri).catch(() => null);

  if (posterCache.size >= MAX_CACHED_POSTERS) {
    const oldest = posterCache.keys().next();
    if (!oldest.done) {
      posterCache.delete(oldest.value);
    }
  }
  posterCache.set(sourceUri, pending);

  return pending;
}

async function generatePoster(
  sourceUri: string,
): Promise<VideoThumbnail | null> {
  const player = createVideoPlayer(toPlayableFileUri(sourceUri));

  try {
    // t=0 is often a fade-from-black; prefer a frame ~1s in and fall back to
    // earlier ones so short videos still get a poster.
    for (const time of [1, 0.25, 0]) {
      try {
        const [thumbnail] = await player.generateThumbnailsAsync(time, {
          maxWidth: 640,
        });
        if (thumbnail) {
          return thumbnail;
        }
      } catch {
        // Past-the-end timestamps throw; try an earlier frame.
      }
    }
    return null;
  } finally {
    player.release();
  }
}
