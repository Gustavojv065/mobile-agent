#!/usr/bin/env bash
# Throttled EAS local Android build.
# - Keeps working dir on /home disk instead of /tmp tmpfs (fixes
#   "Disk quota exceeded" on :react-native-reanimated:externalNativeBuildRelease).
# - Caps CPU via systemd scope so the PC stays usable.
# - Single ABI (arm64-v8a) + --max-workers=4 comes from the
#   "development-local" profile in eas.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-development-local}"
if [[ "$#" -gt 0 ]]; then shift; fi

mkdir -p "$ROOT/.eas-local" "$ROOT/dist-eas"

exec systemd-run --user --scope \
  -p CPUQuota=400% \
  -p CPUWeight=10 \
  env \
    "EAS_LOCAL_BUILD_WORKINGDIR=$ROOT/.eas-local" \
    "EAS_LOCAL_BUILD_ARTIFACTS_DIR=$ROOT/dist-eas" \
    EAS_LOCAL_BUILD_SKIP_CLEANUP=0 \
    NODE_OPTIONS=--max-old-space-size=4096 \
    JOBS=4 \
    CMAKE_BUILD_PARALLEL_LEVEL=4 \
    ORG_GRADLE_PROJECT_reactNativeArchitectures=arm64-v8a \
    nice -n 10 ionice -c3 \
    eas build --platform android --profile "$PROFILE" --local "$@"
