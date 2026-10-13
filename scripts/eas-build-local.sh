#!/usr/bin/env bash
# Throttled EAS local Android build.
# - Keeps working dir on /home disk instead of /tmp tmpfs (fixes
#   "Disk quota exceeded" on :react-native-reanimated:externalNativeBuildRelease).
# - Caps CPU via systemd scope so the PC stays usable.
# - Single ABI (arm64-v8a) + --max-workers=4 comes from the
#   "*-local" profiles in eas.json.
#
# Usage:
#   ./scripts/eas-build-local.sh [dev|prod|<profile>] [extra eas args...]
# Examples:
#   ./scripts/eas-build-local.sh              # dev (development-local)
#   ./scripts/eas-build-local.sh dev           # dev (development-local)
#   ./scripts/eas-build-local.sh prod          # prod (production-local)
#   ./scripts/eas-build-local.sh --help        # this help + eas build --help
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: eas-build-local.sh [dev|prod|<profile>] [extra eas args...]

  dev, development, development-local  -> development-local (default, debug APK)
  prod, production, production-local   -> production-local (release APK)

Any other first arg is treated as an explicit EAS profile name.
Remaining args are passed through to `eas build`.
EOF
}

PROFILE_INPUT="${1:-development-local}"
case "$PROFILE_INPUT" in
  -h|--help|help)
    usage
    echo
    exec eas build --help
    ;;
  dev|development|development-local)
    PROFILE="development-local"
    ;;
  prod|production|production-local)
    PROFILE="production-local"
    ;;
  -*)
    # No profile given, extra eas flags only — keep default.
    PROFILE="development-local"
    ;;
  *)
    PROFILE="$PROFILE_INPUT"
    ;;
esac

# Consume the profile arg unless it looks like an eas flag.
if [[ "$#" -gt 0 && "$PROFILE_INPUT" != -* ]]; then shift; fi

# EAS refuses to start if the workingdir isn't empty (e.g. leftover from a
# failed build), so reset it on every run. Artifacts dir is kept.
rm -rf "$ROOT/.eas-local"
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
