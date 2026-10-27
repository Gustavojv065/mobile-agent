const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

/**
 * Registers Mobile Agent as an Android share target.
 *
 * Two filters are enough:
 *  - SEND          → one file, or text/links
 *  - SEND_MULTIPLE → several files at once
 *
 * A wildcard MIME filter keeps the sheet in sync with the workspace importer,
 * which already accepts any file type (images, video, audio, PDFs, Office docs,
 * zip, code…).
 * The actual URI extraction and copying live in the `share-target` local Expo
 * module; this plugin only makes the activity resolvable for ACTION_SEND.
 *
 * The activity must keep `launchMode="singleTask"` so a share received while the
 * app is already running is delivered through `onNewIntent` instead of stacking
 * a second activity. Expo's template already sets it, but we assert it here so a
 * future template change cannot silently break warm shares.
 */
const SHARE_ACTIONS = [
  "android.intent.action.SEND",
  "android.intent.action.SEND_MULTIPLE",
];

const SHARE_MIME_TYPE = "*/*";
const DEFAULT_CATEGORY = "android.intent.category.DEFAULT";

function hasShareFilter(activity, action) {
  return (activity["intent-filter"] || []).some((intentFilter) => {
    const actions = intentFilter.action || [];
    const data = intentFilter.data || [];

    return (
      actions.some(
        (entry) => entry.$["android:name"] === action,
      ) &&
      data.some(
        (entry) =>
          entry.$["android:mimeType"] === SHARE_MIME_TYPE &&
          !entry.$["android:scheme"],
      )
    );
  });
}

function addShareTargets(androidManifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest);

  activity.$["android:launchMode"] = "singleTask";

  const intentFilters = activity["intent-filter"] || [];

  for (const action of SHARE_ACTIONS) {
    if (hasShareFilter(activity, action)) continue;

    intentFilters.push({
      action: [{ $: { "android:name": action } }],
      category: [{ $: { "android:name": DEFAULT_CATEGORY } }],
      data: [{ $: { "android:mimeType": SHARE_MIME_TYPE } }],
    });
  }

  activity["intent-filter"] = intentFilters;

  return androidManifest;
}

module.exports = function withShareTarget(config) {
  return withAndroidManifest(config, (config) => {
    config.modResults = addShareTargets(config.modResults);
    return config;
  });
};
