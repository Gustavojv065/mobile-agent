/**
 * Types and pure helpers for content shared into the app from other apps.
 *
 * Kept free of React Native/native imports so it can be unit tested in the
 * node-based Vitest environment.
 */

export type SharedFile = {
  /** `file://` path inside the app cache, copied by the native module. */
  uri: string;
  name: string;
  mimeType: string | null;
  size: number | null;
};

export type SharedContent = {
  text: string | null;
  subject: string | null;
  type: string | null;
  files: SharedFile[];
};

/** The shape `importFiles` accepts (a subset of expo-document-picker assets). */
export type SharedImportAsset = {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
  lastModified: number;
};

/**
 * Converts native share payloads into workspace import assets.
 *
 * Files are de-duplicated by cache path because some providers put the same
 * stream in both EXTRA_STREAM and ClipData.
 */
export function toImportAssets(
  payloads: readonly SharedContent[],
): SharedImportAsset[] {
  const seen = new Set<string>();
  const assets: SharedImportAsset[] = [];
  const lastModified = Date.now();

  for (const payload of payloads) {
    for (const file of payload.files ?? []) {
      const uri = file?.uri?.trim();

      if (!uri || seen.has(uri)) continue;

      seen.add(uri);

      const asset: SharedImportAsset = {
        uri,
        name: file.name?.trim() || fallbackFileName(assets.length),
        lastModified,
      };

      if (file.mimeType) {
        asset.mimeType = file.mimeType;
      }

      if (typeof file.size === "number" && Number.isFinite(file.size)) {
        asset.size = file.size;
      }

      assets.push(asset);
    }
  }

  return assets;
}

/**
 * Joins shared text blocks from all payloads (a multi-share can carry a caption
 * per file). Repeated identical text is only kept once.
 */
export function joinSharedText(
  payloads: readonly SharedContent[],
): string | null {
  const texts = payloads
    .map((payload) => payload.text?.trim())
    .filter((text): text is string => !!text);

  if (texts.length === 0) return null;

  return Array.from(new Set(texts)).join("\n\n");
}

/** Adds imported file ids to the current selection without duplicates. */
export function mergeSelectedFileIds(
  current: readonly string[],
  added: readonly string[],
): string[] {
  return Array.from(new Set([...current, ...added].filter(Boolean)));
}

function fallbackFileName(index: number) {
  return `shared-file-${index + 1}`;
}
