# Honey Wallet

A monorepo containing the Honey Wallet API server (Rust), web app (React + Vite) and mobile app (Expo / React Native).

[![CI](https://github.com/honey-wallet/honey-wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/honey-wallet/honey-wallet/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

## NEAR hackathon

**What it is.** Honey is a multichain wallet (mobile, Chrome extension, web) for EVM, Solana and NEAR. Its hackathon feature is **Jars**: you describe an idea ("AI capex keeps growing"), an agent on NEAR AI Cloud reads it and any links, picks tokens that express it, and buys the mix in one go. Jars can be shared with friends, made public and copied, with the creator earning a cut of copiers' profit.

**The problem.** Acting on a market view today means researching tokens one by one, finding which chain each trades on, bridging, and placing several swaps. Jars turns one sentence into one reviewed, routed purchase.

**Try it (no keys, sample data):**

1. `pnpm install`, then `EXPO_PUBLIC_TEST_MODE=1 pnpm dev:mobile` and press `w` (web) or open it in Expo Go.
2. Tap the honey button in the bottom bar → the Jars page opens, with your portfolio on top and Yours / Explore below.
3. Tap **What do you believe in? Ask Honey** and type an idea → see the agent's stages, then a proposal with picks, weights, fees and sources.
4. Tap **Edit** → change weights or remove a pick; each pick shows the route its buy takes across chains, and the summary shows estimated slippage.
5. On Explore, open a jar → see its chart, holdings and owners; tap **Copy with $100** → it appears under Yours.

With the keys in `apps/server/.env` (see `.env.example`) and test mode off, the agent and prices are live.

**NEAR pieces**

| Piece | Where |
| --- | --- |
| NEAR AI Cloud: the thesis agent | `apps/server/src/thesis/near_ai.rs` |
| NEAR Intents (1Click): quotes, swaps and cross-chain routing | `apps/server/src/providers/near_intents.rs`, `packages/api-client/src/near-intents.ts` |
| Native NEAR accounts and transfers | `packages/keyring`, [`docs/NEAR.md`](docs/NEAR.md) |
| Route planner: splits each buy across chains within a max slippage | `apps/mobile/src/lib/jar-routes.ts` |

**What existed before the hackathon (disclosure, Q-002/Q-005).** Development started on 13 Oct 2026. Before the window opened on 19 Oct the project already had the wallet app's UI (mobile and extension), the keyring and an early API server. This public repo starts from a single snapshot commit, so there is no pre-hackathon diff to link; the work done in the window is listed here instead: Jars and the thesis agent on NEAR AI, NEAR Intents for swaps and bridging, NEAR chain support, the route planner, Supabase sign-in, and the landing page. Libraries used are the ones in each `package.json` and `Cargo.toml`; there are no templates.

The app has no users, has not run on mainnet with real users, and has not been launched.

## Repository layout

```
.
├── apps/
│   ├── server/          Rust API server (axum + tokio)
│   ├── web/             React web app (Vite)
│   └── mobile/          Expo app for iOS, Android and web (Expo Router)
├── packages/
│   └── api-client/      Typed API client shared by web and mobile
├── Cargo.toml           Cargo workspace
├── pnpm-workspace.yaml  pnpm workspace + shared version catalog
└── turbo.json           Task pipeline for every package (including the Rust server)
```

| Package                    | Port | Docs                                                     |
| -------------------------- | ---- | -------------------------------------------------------- |
| `@honey-wallet/server`     | 8080 | [`apps/server/.env.example`](apps/server/.env.example)   |
| `@honey-wallet/web`        | 5173 | [`apps/web/.env.example`](apps/web/.env.example)         |
| `@honey-wallet/mobile`     | 8081 | [`apps/mobile/.env.example`](apps/mobile/.env.example)   |
| `@honey-wallet/api-client` | —    | [`packages/api-client`](packages/api-client/src)         |

## Prerequisites

- **Node.js 24** (see [`.nvmrc`](.nvmrc); run `nvm use` or `fnm use`)
- **pnpm 10** (`corepack enable` picks up the version from `package.json`)
- **Rust**: install [rustup](https://rustup.rs). The pinned toolchain in [`rust-toolchain.toml`](rust-toolchain.toml) is installed automatically on first build.
- **Mobile (optional)**: the [Expo Go](https://expo.dev/go) app on a device, or Xcode / Android Studio for simulators

## Getting started

```sh
git clone https://github.com/honey-wallet/honey-wallet.git
cd honey-wallet
corepack enable
pnpm install

pnpm dev            # server + web + mobile
pnpm dev:web        # server + web
pnpm dev:mobile     # server + Expo dev server
pnpm dev:server     # server only
```

Then open http://localhost:5173 for the web app, or scan the QR code from the Expo terminal for the mobile app.

> **Testing on a physical phone?** Start the server with `HOST=0.0.0.0` (set it in `apps/server/.env`) so it accepts connections from your LAN. The mobile app finds the server through the Expo dev server's host automatically.

## Common tasks

All commands run from the repository root and go through [Turborepo](https://turborepo.com), so they cover every package, Rust included.

| Command          | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm dev`       | Run all apps in watch / dev mode                                    |
| `pnpm build`     | Production builds (`cargo build --release`, `vite build`)           |
| `pnpm test`      | `cargo test` + Vitest                                               |
| `pnpm typecheck` | TypeScript type checking                                            |
| `pnpm lint`      | Biome (TS/JSON/CSS) + `cargo fmt --check` + `cargo clippy`          |
| `pnpm format`    | Auto-format and fix everything Biome can                            |

To target one package: `pnpm turbo run test --filter=@honey-wallet/web`.

## Architecture

The production backend design and staged implementation are documented in
[`docs/backend/ARCHITECTURE.md`](docs/backend/ARCHITECTURE.md), with engineering
tradeoffs in [`DECISIONS.md`](docs/backend/DECISIONS.md) and current implementation,
verification and local setup in [`IMPLEMENTATION.md`](docs/backend/IMPLEMENTATION.md).
The implemented authentication and durable-job slice is described in
[`IDENTITY-AND-DURABILITY.md`](docs/backend/IDENTITY-AND-DURABILITY.md).
The 10,000-user capacity model is a test target, not a measured production claim.

- **Server** (`apps/server`) exposes `GET /health` (liveness), `GET /ready` (cached dependency readiness), and versioned routes under `/api/v1`. Application errors have the shape `{ "error": { "code", "message" } }`; readiness uses its own operational response on both 200 and 503. Configuration comes only from environment variables.
- **API client** (`packages/api-client`) is a dependency-free, typed `fetch` wrapper. Web and mobile both import it, so an API change is made once. It ships TypeScript source; Vite and Metro compile it directly, so there is no build step.
- **Web** and **mobile** read the server URL from `VITE_API_URL` and `EXPO_PUBLIC_API_URL`.

## Docker

The server ships as one small image (distroless, non-root, read-only filesystem, built-in health check) for `linux/amd64` and `linux/arm64`, so it runs on any container host: a VM with Docker, Kubernetes, Fly.io, Cloud Run, ECS and similar.

```sh
docker compose up --build -d          # build and run locally on 127.0.0.1:8080
HONEY_SERVER_PORT=8095 docker compose up --build -d   # if 8080 is taken

docker build -f apps/server/Dockerfile -t honey-server .   # image for this machine's architecture
docker run --rm -p 8080:8080 --read-only honey-server
```

Configuration is environment variables only (see `apps/server/.env.example`). Point platform health probes at `GET /health`. On every push to `main` and every `v*` tag, CI publishes a multi-arch image to `ghcr.io/honey-wallet/honey-server`, tagged with the branch, version and commit.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md) first. Before your first pull request can be merged, you will be asked to sign the [CLA](CLA.md). To report a security issue, follow [SECURITY.md](SECURITY.md). **Do not open a public issue.**

## License

Honey Wallet is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify and share it for any noncommercial purpose: personal projects, research, education, and use by charities and public institutions. **Commercial use is not permitted** under this license. Contact the maintainers if you need a commercial license.

All rights in the software, including commercial rights, belong to Honey Wallet. Contributions are welcome and voluntary: contributors sign our [Contributor License Agreement](CLA.md), which assigns their contributions to Honey Wallet and confirms that no payment is owed for them.

Distributed pairing and public prices: [`REDIS-AND-PRICES.md`](docs/backend/REDIS-AND-PRICES.md).
Measured local socket capacity and remaining production gates:
[`CAPACITY-LOCAL.md`](docs/backend/CAPACITY-LOCAL.md).

Private metrics, sampled traces, alerts and a disposable local collector stack:
[`OBSERVABILITY.md`](docs/backend/OBSERVABILITY.md).

Initial Aave V3 and Morpho Vault V2 indexed data adapters and public read smoke:
[`EARN-READERS.md`](docs/backend/EARN-READERS.md). Execution remains unavailable.

Fenced Earn caching, the public catalog API, and web/native delivery:
[`EARN-CATALOG.md`](docs/backend/EARN-CATALOG.md).

Immutable transaction preparation and authenticated restart recovery:
[`PREPARATION-AND-RECOVERY.md`](docs/backend/PREPARATION-AND-RECOVERY.md).
Aave preparation, independent wallet-signature verification and a disposable-fork
supply/withdraw proof: [`AAVE-EXECUTION.md`](docs/backend/AAVE-EXECUTION.md).
Database-backed receipt reconciliation, sequential dispatch and finality evidence:
[`RECEIPT-RECONCILIATION.md`](docs/backend/RECEIPT-RECONCILIATION.md).
Public transaction submission, running workers and frontend execution remain unfinished.

The authenticated local-fork Aave execution flow and its limits are documented in [AAVE-API.md](docs/backend/AAVE-API.md).
