import { File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";

/** Keep multi-megabyte inlined media out of WebView source props/loadData. */
export function createSceneDocument(html: string) {
  const file = new File(Paths.cache, `scene-${Crypto.randomUUID()}.html`);
  const dispose = () => {
    try { file.delete(); } catch { /* Cache may already have been reclaimed. */ }
  };
  try {
    file.create({ overwrite: true, intermediates: true });
    file.write(html);
  } catch (error) {
    dispose();
    throw new Error(`Could not prepare scene document: ${String(error)}`);
  }
  return { uri: file.uri, dispose };
}
