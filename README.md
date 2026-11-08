# Honey Wallet: Jars

**Turn one sentence about the market into one routed, cross-chain purchase.** Honey is a multichain wallet (mobile, Chrome extension, web) for EVM, Solana and NEAR. Its hackathon feature is **Jars**: you write an idea ("AI data-centre spending keeps growing"), an agent on **NEAR AI Cloud** turns it into a basket of tokens, and **NEAR Intents** buys the basket across chains in one approval.

Built for **NEAR Hackathon** (19 Oct – 14 Nov 2026).

[![CI](https://github.com/honey-wallet/honey-wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/honey-wallet/honey-wallet/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

- **Tracks:** `defi` (Unstoppable DeFi), `agents` (Agent Economy)
- **Demo video:** _X post link added before submission_
- **License:** [PolyForm Noncommercial 1.0.0](LICENSE)

## The problem

Acting on a market view today means researching tokens one by one, finding which chain each trades on, bridging, and placing several swaps with different slippage. Most people give up, or buy one token and hope. Jars makes the view the unit: one idea, one reviewed basket, one routed purchase.

## What NEAR does here

| NEAR piece | What it does in Honey | Code |
| --- | --- | --- |
| **NEAR AI Cloud** | Runs the thesis agent: reads the idea and any links, names the exposures, picks tokens, sizes weights, and writes the critic's objection | `apps/server/src/thesis/near_ai.rs`, `apps/server/src/thesis/` |
| **NEAR Intents (1Click)** | Quotes and settles every buy and bridge across chains, so one approval can fill picks on Solana, Ethereum, Base and NEAR. Quotes use `dry: true` until the user confirms (Q-007) | `apps/server/src/providers/near_intents.rs`, `packages/api-client/src/near-intents.ts` |
| **Route planner** | Splits each pick's buy across the venues and chains it trades on, cheapest first, within the user's max slippage; skips pools under $50k of liquidity | `apps/mobile/src/lib/jar-routes.ts` |
| **Native NEAR accounts** | Derives, signs and recovers NEAR accounts in the shared keyring | `packages/keyring`, [`docs/NEAR.md`](docs/NEAR.md) |

The agent's full spec, including its safety rules (prompt injection, limit orders, spend limits), is in [`docs/thesis-agent/REQUIREMENTS.md`](docs/thesis-agent/REQUIREMENTS.md).

## Try it in 5 minutes (no keys needed)

Test mode runs the real app with sample prices and fake money.

```sh
git clone https://github.com/honey-wallet/honey-wallet.git && cd honey-wallet
corepack enable && pnpm install
cd apps/mobile && EXPO_PUBLIC_TEST_MODE=1 pnpm exec expo start --web
```

1. **Open the honey button** in the bottom bar → the Jars page opens: your total across jars on top, **Yours / Explore** below.
2. **Tap "What do you believe in? Ask Honey"** and type an idea → see the agent's stages run, then a proposal: picks, weights, fees, sources and the critic's caution.
3. **Tap Edit** → change a weight or remove a pick; under each pick, see the route its buy takes ("Solana · Jupiter $600 + Ethereum · Uniswap $400") and the estimated slippage in the summary.
4. **Continue** → choose public/private, max slippage (0.5 / 1 / 2%) and market or limit order → **Buy $500 and launch** → the jar appears under Yours.
5. **Explore → open a jar → Copy with $100** → see your copy under Yours, with the creator's fee shown.

**Live mode:** put the keys from [`apps/server/.env.example`](apps/server/.env.example) (NEAR AI Cloud, 1Click, Tavily, CoinGecko) in `apps/server/.env`, run `pnpm dev:mobile` without test mode, and the proposal's price note reads "NEAR Intents 1Click token list" instead of "Sample prices (test mode)".

**Check the code works:** `pnpm lint && pnpm typecheck && pnpm test` (Rust server, mobile, extension, keyring and API client).

## Built during the hackathon, and what came before

Development started on 13 Oct 2026. Before the window opened on 19 Oct the project already had the wallet's UI (mobile and extension), the keyring and an early API server; that is baseline (Q-002, Q-005). This public repository starts from a single snapshot commit, so there is no pre-hackathon diff to link (Q-003). Built in the window:

- Jars: idea chat, proposals, editing, shared, public and copyable jars with a creator fee
- The thesis agent on NEAR AI Cloud
- NEAR Intents for quotes, swaps and bridging (replacing Across)
- NEAR chain support across the app
- The cross-chain route planner with max slippage
- Supabase sign-in and the landing page

Main libraries: Expo / React Native, React, Vite, axum and tokio (Rust), viem, WalletConnect, `@noble` crypto. Full lists are in each `package.json` and `Cargo.toml`. No templates.

The app has no users, has not run on mainnet with real users, and has not been launched.

## Developer guide

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

Configuration is environment variables only (see `apps/server/.env.example`). Point platform health probes at `GET /health`. On every push to `main` and every `v*` tag, CI publishes a multi-arch image to `ghcr.io/honey-wallet/honey-wallet-server`, tagged with the branch, version and commit.

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
