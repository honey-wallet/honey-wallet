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
# Public WalletConnect project ID. Set here, not in eas.json: eas.json is part of the runtime
# fingerprint, so editing it would cut today's store builds off from updates. Move it into
# eas.json's build env at the next store build.
export EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID=8ad4a8c682ffb4d49ff4dda0dc14bb1c

# Phones only: the web export is the extension's job (apps/extension), not an OTA update.
for platform in ios android; do
  npx eas-cli update --branch "$branch" --message "$message" --platform "$platform" \
    --environment production --non-interactive
done
# Pointing the store channel at the simulation branch puts every installed app on sample
# money, so it needs an explicit yes; a plain simulation run only publishes the branch.
if [ "$branch" = simulation ] && [ "${HONEY_POINT_STORE_AT_SIMULATION:-}" != yes ]; then
  echo "Published branch simulation. The store channel still serves its current branch."
  echo "To switch every store install to sample money: HONEY_POINT_STORE_AT_SIMULATION=yes $0 simulation \"...\""
  exit 0
fi
npx eas-cli channel:edit production --branch "$branch" --non-interactive
echo "Channel production now serves branch $branch. Every store install gets it on the next restart."
