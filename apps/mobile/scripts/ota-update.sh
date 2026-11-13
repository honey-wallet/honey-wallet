#!/usr/bin/env bash
# Publishes an over-the-air update that the store builds actually take.
#
# `eas update` doesn't read eas.json's build env, but the store builds were made with it, and
# it changes the native fingerprint (runtime version). Published without it, an update
# targets a runtime no installed build has, and phones silently ignore it (2026-11-14).
# This loads the production build env, shows the runtime each platform will target next to
# the latest store build's, refuses on a mismatch, then publishes iOS and Android.
#
# Usage, from apps/mobile:  scripts/ota-update.sh "What changed"
set -euo pipefail
cd "$(dirname "$0")/.."
message="${1:?Usage: scripts/ota-update.sh \"What changed\"}"

eval "$(python3 -c '
import json, shlex
env = json.load(open("eas.json"))["build"]["production"].get("env", {})
print(" ".join(f"export {k}={shlex.quote(str(v))};" for k, v in env.items()))
')"

eas() { npx -y eas-cli@latest "$@"; }

for platform in ios android; do
  local_rt=$(pnpm exec expo-updates fingerprint:generate --platform "$platform" 2>/dev/null |
    python3 -c 'import sys, json; print(json.load(sys.stdin)["hash"])')
  store_rt=$(eas build:list --platform "$platform" --status finished --limit 1 --non-interactive --json 2>/dev/null |
    python3 -c 'import sys, json; b = json.load(sys.stdin); print((b[0].get("runtime") or {}).get("version", "") if b else "")')
  echo "$platform: update targets $local_rt, latest store build runs $store_rt"
  if [ "$local_rt" != "$store_rt" ]; then
    echo "Mismatch on $platform: this update would not reach the installed build. Make a new build instead." >&2
    exit 1
  fi
done

for platform in ios android; do
  eas update --channel production --environment production --platform "$platform" --message "$message"
done
