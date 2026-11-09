#!/usr/bin/env bash
# Publish an over-the-air update to the store builds (channel "production") and point
# that channel at it. JS and asset changes only: a change to native code, permissions,
# the app name or icons needs a new store build first (the runtime fingerprint changes).
#
#   scripts/ota.sh production "Fix the send screen"   # real money, test mode off
#   scripts/ota.sh simulation "Tester build"          # sample money, every feature on
set -euo pipefail
cd "$(dirname "$0")/.."

branch=${1:?usage: scripts/ota.sh <production|simulation> "message"}
message=${2:?usage: scripts/ota.sh <production|simulation> "message"}
case "$branch" in
  production) unset HONEY_SIMULATION ;;
  simulation) export HONEY_SIMULATION=1 ;;
  *) echo "branch must be production or simulation" >&2; exit 1 ;;
esac

# The same public settings the production store build was made with.
eval "$(node -e '
  const env = require("./eas.json").build.production.env;
  for (const [k, v] of Object.entries(env)) console.log(`export ${k}=${JSON.stringify(v)}`);
')"
if [ "$branch" = simulation ]; then export EXPO_PUBLIC_TEST_MODE=1; fi

npx eas-cli update --branch "$branch" --message "$message" --non-interactive
npx eas-cli channel:edit production --branch "$branch" --non-interactive
echo "Channel production now serves branch $branch. Testers get it on the next app restart."
