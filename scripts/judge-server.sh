#!/usr/bin/env bash
# Disposable local infrastructure and the API used by the README's reviewer path.
set -euo pipefail
cd "$(dirname "$0")/.."

export HONEY_POSTGRES_PORT=35432
export HONEY_REDIS_PORT=36379
export DATABASE_URL='postgres://honey:honey_local_only@127.0.0.1:35432/honey?sslmode=disable'
export REDIS_URL='redis://127.0.0.1:36379'
export HOST=127.0.0.1
export PORT="${PORT:-8080}"
export SERVER_ROLE=combined
export REQUIRE_INFRASTRUCTURE=true
export AUTH_ORIGIN=http://localhost:5173
export AUTH_CHAIN_ID=1
export RUST_LOG="${RUST_LOG:-honey_server=info,warn}"

echo 'Starting disposable reviewer database and Redis (ports 35432 / 36379).'
echo "API: http://127.0.0.1:${PORT}; wallet sign-in: http://localhost:5173 / eip155:1."
echo 'This database is empty initially and loses its data when its container restarts.'
echo 'Provider secrets, if configured in apps/server/.env, are still loaded by the server.'
docker compose -p honey-judge -f compose.backend.yaml up -d --wait
cargo build --locked -p honey-server
(
  cd apps/server
  ../../target/debug/honey-server migrate
)
cd apps/server
exec ../../target/debug/honey-server
