/**
 * Loopback asset server manager for scene clips.
 *
 * Data-URI inlining inflates every clip ~33% and parks multi-megabyte
 * strings in the JS heap and the WebView bridge. This manager starts the
 * native loopback HTTP server once per process (an idle accept() thread
 * costs ~nothing) and maps workspace/cache files to same-origin URLs, so
 * scene pages load clips with zero heap inflation, byte-range seeking,
 * and clean canvas readback.
 *
 * Falls back to null wherever the native module is missing (non-Android,
 * dev mocks) — callers then use the legacy data-URI path.
 */

let cachedBaseUrl: string | null | undefined;

function stripFileScheme(uri: string): string {
  return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
}

/**
 * Starts the asset server on first use and returns its base URL
 * (`http://127.0.0.1:<port>`), or null when unavailable. Process-wide:
 * never released — an idle loopback listener is cheaper than lifecycle
 * races across the tool→host handoff.
 */
export async function ensureAssetServer(): Promise<string | null> {
  if (cachedBaseUrl !== undefined) return cachedBaseUrl;
  cachedBaseUrl = null;
  try {
    const [fs, native] = await Promise.all([
      import("expo-file-system"),
      import("html-video-export"),
    ]);
    const module = native.getHtmlVideoExportModule();
    if (!module || typeof module.startAssetServer !== "function") return cachedBaseUrl;
    const { getWorkspaceDirectory } = await import(
      "@/core/services/workspace-file-service"
    );
    const wsPath = stripFileScheme(getWorkspaceDirectory().uri);
    const cachePath = stripFileScheme(fs.Paths.cache.uri);
    const { port } = await module.startAssetServer(wsPath, cachePath);
    if (typeof port === "number" && port > 0) {
      cachedBaseUrl = `http://127.0.0.1:${port}`;
    }
  } catch {
    cachedBaseUrl = null;
  }
  return cachedBaseUrl;
}

/** Test-only reset for the process-wide cache. */
export function resetAssetServerForTests(): void {
  cachedBaseUrl = undefined;
}

function encodeSegments(relativePath: string): string {
  return relativePath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Same-origin URL for a workspace-relative file (`<id>/name.mp4`). */
export function workspaceFileUrl(baseUrl: string, relativePath: string): string {
  return `${baseUrl}/files/${encodeSegments(relativePath)}`;
}

/** Same-origin URL for a scene document written to cache (keeps canvas clean). */
export function cacheFileUrl(baseUrl: string, name: string): string {
  return `${baseUrl}/cache/${encodeURIComponent(name)}`;
}

/** Maps a `file://` cache URI to its served same-origin URL. */
export function servedCacheUrl(baseUrl: string, fileUri: string): string {
  const name = fileUri.split("/").filter(Boolean).pop() ?? "";
  return cacheFileUrl(baseUrl, name);
}
