import Constants from "expo-constants";
import type { Directory } from "expo-file-system";

const RELEASES_API_URL =
  "https://api.github.com/repos/TecnicalBot/mobile-agent/releases";
const RELEASE_CACHE_TTL_MS = 60 * 60 * 1000;

export type AvailableRelease = {
  apkName: string;
  apkUrl: string;
  /** Release notes body as published (`.release-notes.md`), may be empty. */
  body: string;
  currentVersion: string;
  name: string;
  tagName: string;
  url: string;
};

/** Release notes for one published release, without its install assets. */
export type ReleaseNotes = {
  body: string;
  name: string;
  url: string;
};

type GitHubRelease = {
  assets?: {
    browser_download_url?: string;
    name?: string;
  }[];
  body?: string | null;
  draft?: boolean;
  html_url?: string;
  name?: string;
  prerelease?: boolean;
  tag_name?: string;
};

let releasesCache: {
  fetchedAt: number;
  releases: GitHubRelease[];
} | null = null;
let pendingCheck: Promise<AvailableRelease | null> | null = null;
let pendingNotes: Promise<ReleaseNotes | null> | null = null;

function versionParts(value: string) {
  const match = value
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/);
  return match
    ? {
        numbers: match.slice(1, 4).map(Number),
        prerelease: match[4] ?? null,
      }
    : null;
}

export function isNewerVersion(candidate: string, current: string) {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);

  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < 3; index += 1) {
    if (candidateParts.numbers[index]! > currentParts.numbers[index]!) {
      return true;
    }
    if (candidateParts.numbers[index]! < currentParts.numbers[index]!) {
      return false;
    }
  }

  return currentParts.prerelease !== null && candidateParts.prerelease === null;
}

async function fetchPublishedReleases() {
  if (
    releasesCache &&
    Date.now() - releasesCache.fetchedAt < RELEASE_CACHE_TTL_MS
  ) {
    return releasesCache.releases;
  }

  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub release check failed (${response.status}).`);
  }

  const releases = ((await response.json()) as GitHubRelease[]).filter(
    (release) => !release.draft,
  );
  releasesCache = { fetchedAt: Date.now(), releases };
  return releases;
}

function toReleaseNotes(release: GitHubRelease | undefined) {
  const tagName = release?.tag_name?.trim() ?? "";
  const url = release?.html_url?.trim() ?? "";

  if (!release || !tagName || !url) return null;

  return {
    body: release.body?.trim() ?? "",
    name: release.name?.trim() || tagName,
    url,
  };
}

async function fetchGitHubReleaseUpdate() {
  const published = await fetchPublishedReleases();
  const currentVersion = Constants.expoConfig?.version ?? "0.0.0";

  const selectedRelease =
    published.find((item) => !item.prerelease && findApkAsset(item) !== null) ??
    published.find((item) => item.prerelease && findApkAsset(item) !== null);
  const apk = selectedRelease ? findApkAsset(selectedRelease) : null;
  const tagName = selectedRelease?.tag_name?.trim() ?? "";
  const url = selectedRelease?.html_url?.trim() ?? "";
  const availableRelease =
    tagName && url && apk && isNewerVersion(tagName, currentVersion)
      ? {
          apkName: apk.name,
          apkUrl: apk.url,
          body: selectedRelease?.body?.trim() ?? "",
          currentVersion,
          name: selectedRelease?.name?.trim() || tagName,
          tagName,
          url,
        }
      : null;

  return availableRelease;
}

/**
 * Notes for the release published for `version` — used by the OTA drawer, which
 * has no release of its own: an OTA update ships JS for the version the app is
 * already on, so the GitHub release for that version is the changelog.
 */
export function fetchReleaseNotes(version: string) {
  if (!pendingNotes) {
    pendingNotes = fetchPublishedReleases()
      .then((releases) => {
        const wanted = version.trim().replace(/^v/i, "");
        const match = releases.find(
          (release) =>
            release.tag_name?.trim().replace(/^v/i, "") === wanted &&
            !release.prerelease,
        );
        return toReleaseNotes(match);
      })
      .finally(() => {
        pendingNotes = null;
      });
  }

  return pendingNotes;
}

function findApkAsset(release: GitHubRelease) {
  const asset = release.assets?.find(
    (item) =>
      item.name?.toLowerCase().endsWith(".apk") && item.browser_download_url,
  );

  return asset?.name && asset.browser_download_url
    ? { name: asset.name, url: asset.browser_download_url }
    : null;
}

export function checkForGitHubReleaseUpdate() {
  if (!pendingCheck) {
    pendingCheck = fetchGitHubReleaseUpdate().finally(() => {
      pendingCheck = null;
    });
  }

  return pendingCheck;
}

/**
 * Removes installers left in the cache by earlier releases. Only the APK being
 * pulled right now survives (it is downloaded with `idempotent`, so a repeat
 * download overwrites in place), which keeps the cache from growing one stale
 * installer per release.
 */
function deleteStaleApks(cache: Directory, keepName: string) {
  try {
    for (const entry of cache.list()) {
      if (entry.name === keepName) continue;
      if (!entry.name.toLowerCase().endsWith(".apk")) continue;
      entry.delete();
    }
  } catch (error) {
    console.warn(error);
  }
}

/**
 * Downloads the APK and hands it to the Android package installer.
 *
 * `onProgress` receives a 0..1 fraction as bytes arrive; it only fires while
 * the server reports a total size, so callers must treat "no event yet" as an
 * unknown length rather than 0%.
 *
 * The installer keeps reading the APK after this resolves, so the file is not
 * deleted here — it is swept on the next update instead.
 */
export async function installAvailableRelease(
  release: AvailableRelease,
  onProgress?: (progress: number) => void,
) {
  const { Linking, Platform } = await import("react-native");

  if (Platform.OS !== "android") {
    await Linking.openURL(release.url);
    return;
  }

  const [{ Directory, File, Paths }, IntentLauncher] = await Promise.all([
    import("expo-file-system"),
    import("expo-intent-launcher"),
  ]);
  const safeName = release.apkName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const cache = new Directory(Paths.cache);
  deleteStaleApks(cache, safeName);
  const destination = new File(cache, safeName);
  const apk = await File.downloadFileAsync(release.apkUrl, destination, {
    idempotent: true,
    onProgress: onProgress
      ? ({ bytesWritten, totalBytes }) => {
          if (totalBytes > 0) {
            onProgress(Math.min(1, bytesWritten / totalBytes));
          }
        }
      : undefined,
  });

  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: apk.contentUri,
    flags: 1,
    type: "application/vnd.android.package-archive",
  });
}
