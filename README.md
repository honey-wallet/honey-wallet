# Honey Wallet

**Turn a market idea into a reviewed basket of tokens, then follow and share the result.**
Honey is a mobile wallet for EVM, Solana and NEAR. It opens on a social feed. Its Jars
flow turns an idea into token allocations using NEAR AI Cloud, obtains cross-chain
quotes through NEAR Intents, and asks the wallet owner to approve funding. Group jars
add invitations, equal contributions and majority approvals using Sputnik DAO.

Built for [NEAR HACKATHON](https://nearhackathon.com/).

[![CI](https://github.com/honey-wallet/honey-wallet/actions/workflows/ci.yml/badge.svg)](https://github.com/honey-wallet/honey-wallet/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

- **Proposed tracks:** Social Money (`social`) and Unstoppable DeFi (`defi`), pending team selection.
- **Demo/X post:** not yet supplied by the team. This is a submission blocker.
- **Product site:** [honeywallet.org](https://honeywallet.org). The site is not the mobile app.
- **License:** [PolyForm Noncommercial 1.0.0](LICENSE); third-party notices are preserved.

## What is implemented, and what is simulated?

| Capability | Implementation and limits | Source |
| --- | --- | --- |
| Feed, profiles, follows, public jars and privacy | Native UI and PostgreSQL-backed API. Fresh local databases have no public content. | [social API](apps/server/src/routes/social.rs), [feed UI](apps/mobile/src/app/(wallet)/feed.tsx) |
| Idea → proposed basket | Live mode calls the server thesis agent. `NEAR_AI_API_KEY` enables NEAR AI Cloud; without it the server uses a disclosed `DRY_RUN` fixture. Client test mode uses a separate sample proposal. | [agent](apps/server/src/thesis), [client](apps/mobile/src/lib/thesis.ts) |
| Cross-chain jar buys and swaps | 1Click quote/deposit/status integration and device-side funding code. Quotes and asset catalogs require network access. No funded mainnet acceptance evidence is claimed by this README. | [jar API](apps/server/src/jar_buys.rs), [jar funding](apps/mobile/src/lib/jar-buy.ts), [swap](apps/mobile/src/lib/intents-swap.ts) |
| Group jars | Invitations and accounting API plus Sputnik DAO transaction/voting integration. Test mode simulates group actions. Real chain lifecycle is covered with mocked RPC tests; a funded deployment still needs separate evidence. | [groups API](apps/server/src/routes/social/groups.rs), [device DAO](apps/mobile/src/lib/jar-dao.ts) |
| Native NEAR | Shared key derivation, balance reads, signing and pending-transfer recovery. Read the documented scope before assuming every asset/flow is supported. | [NEAR support](docs/NEAR.md), [keyring](packages/keyring) |
| Jar selling, limit orders and copy fees | Prototype restrictions apply. Jar selling is test-mode only; do not interpret simulated receipts or displayed fees as proof of live settlement or fee collection. | [sell flow](apps/mobile/src/app/(jars)/jar-sell.tsx), [jar flow](apps/mobile/src/app/(jars)/thesis-new.tsx) |

`EXPO_PUBLIC_TEST_MODE=1` supplies sample money and simulates financial actions. It
is a UI demonstration, not proof of NEAR AI inference, an on-chain deposit, or a
successful cross-chain settlement. Prices and some discovery/feed requests can
still use live network services. Test mode is not an offline mode.

## Prerequisites

- **Node 24**, as pinned in [.nvmrc](.nvmrc), and **pnpm 10.26.0**.
- **Rust**, installed with rustup; [rust-toolchain.toml](rust-toolchain.toml) pins the toolchain.
- **Docker Desktop / Docker Compose** running for local PostgreSQL and Redis.
- **iOS:** macOS, Xcode, an installed iOS simulator runtime, and CocoaPods.
- **Android:** Android Studio, Android SDK/JDK, and a running emulator or connected device.

Use a native debug build for the product demo. Expo Go does not contain all of
Honey's native dependencies. **Do not use `expo start --web` to evaluate Jars:** the
browser build is the extension surface and intentionally hides Feed/Jars.

## Getting started

Clone and install from the repository root:

```sh
git clone https://github.com/honey-wallet/honey-wallet.git
cd honey-wallet
nvm use                  # or select Node 24 with your preferred version manager
corepack enable
pnpm install --frozen-lockfile
```

Terminal 1, from the root:

```sh
pnpm judge:server
```

This starts isolated, disposable PostgreSQL/Redis containers on **35432 / 36379**,
builds the API, applies migrations and runs it on **127.0.0.1:8080**. No provider key
is required for the local fixture path. Existing `apps/server/.env` provider keys
are still loaded if present; keep them out of Git. Leave this terminal running.
If port 8080 is occupied, use `PORT=18080 pnpm judge:server` and set the mobile
API URL to `http://127.0.0.1:18080` (Android Emulator: `http://10.0.2.2:18080`).
Keep the auth origin and chain unchanged.

Terminal 2, for an iOS simulator:

```sh
cd apps/mobile
EXPO_PUBLIC_API_URL=http://127.0.0.1:8080 \
EXPO_PUBLIC_AUTH_ORIGIN=http://localhost:5173 \
EXPO_PUBLIC_AUTH_CHAIN_ID=eip155:1 \
EXPO_PUBLIC_TEST_MODE=1 \
pnpm exec expo run:ios --port 8082
```

Expo generates the ignored native project, installs pods, compiles and opens the
app. The first build takes several minutes. If prompted, select an iPhone simulator.
Keep Metro running. After changing only JS/TS, restart with the same variables and
`pnpm exec expo start --clear --port 8082`, then open the installed app.

For Android Emulator, replace `127.0.0.1` in **EXPO_PUBLIC_API_URL only** with
`10.0.2.2`, and replace `run:ios` with `run:android`. Keep the auth origin identical
to the server. Physical phones need a reachable LAN API host; the default reviewer
script binds to loopback and is intended for simulators/emulators.

### Do this → see this

1. Launch Honey → **Feed**, with Everyone / Following / Leaderboard. An empty
   state on a new local database is expected, not an installation failure.
2. Tap **Join / Sign in** if offered → create a disposable wallet if asked, then
   review the wallet sign-in message and approve it. Follow any handle/profile
   setup prompts. Never import a wallet holding real funds for this demo.
3. The honey jar button → **Create a jar → Describe an idea**. Enter
   “AI data-centre spending keeps growing”, an amount and risk if requested →
   staged research and a proposal containing token picks, weights and a caution.
4. Review/edit the proposal and continue → the launch review. In test mode,
   confirm a sample buy → the jar's page, with its simulated value and holdings.
5. Open **Wallet → Jars** → inspect the created jar. Browse another public jar to
   inspect copying when content is available; a fresh database has no other creators.
6. In the jar's Sell flow, try 25%, 50% or all → a review and simulated receipt.
   This step is explicitly a test-mode demonstration.

If the simulator needs Face ID, use **Simulator → Features → Face ID → Enrolled**,
then **Matching Face** when the app asks for authentication. A device confirmation
is not a substitute for checking the displayed sign-in or transaction terms.

### Verify the API without a phone

```sh
curl --fail http://127.0.0.1:8080/health
curl --fail http://127.0.0.1:8080/ready
curl --fail http://127.0.0.1:8080/api/v1/auth/config
curl --fail http://127.0.0.1:8080/api/v1/social/feed
```

Expect HTTP 200, PostgreSQL/Redis `up`, auth enabled with
`http://localhost:5173` / `eip155:1`, and a feed object with `items` (initially empty).
“Wallet sign-in is not configured” means Metro did not receive the two auth values.
“Couldn't reach Honey” means the API URL/server is unavailable. Restart Metro after
environment changes. A 200 empty feed is different from a failed request.

Stop the API/Metro with Ctrl+C. To remove the disposable reviewer services:

```sh
docker compose -p honey-judge -f compose.backend.yaml down
```

## Verify the real NEAR integrations

Turn client test mode off (`EXPO_PUBLIC_TEST_MODE=0`) and restart Metro with the
same API/auth settings. The wallet can sign in without owning funds. Configure
server-only `NEAR_AI_API_KEY` for actual inference and optionally `LINKUP_API_KEY`
for external news research. See [server environment examples](apps/server/.env.example)
and [agent requirements](docs/thesis-agent/REQUIREMENTS.md).

Without an AI key, server output is a fixture. With a key, a failed model call must
not silently become a successful sample proposal. The 1Click partner JWT
`NEAR_INTENTS_API_KEY` is optional for the separate jar-buy flow, but required by
some authenticated provider/private-intent adapters; consult each route's docs.
The older bridge preview adapter and executable jar-buy API are different paths.

NEAR Intents is mainnet-only. A dry quote does not execute a trade. Funding a live
buy spends real assets and gas and requires the owner's explicit approval; the
reviewer path above never requires funding. Capture provider status and explorer
receipts separately before claiming a successful live settlement. Neither tests
with mock RPC nor test-mode receipts establish that evidence.

## Hackathon development history

The public repository's earliest commit is
[`f20e914`](https://github.com/honey-wallet/honey-wallet/commit/f20e914), dated
20 October 2026. It already contains substantial wallet/server infrastructure.
Treat that imported snapshot as **baseline**, not proof that every included file
was written during the event. Original authorship dates before that snapshot
cannot be established from this repository alone.

The reviewable development delta is
[baseline → current main](https://github.com/honey-wallet/honey-wallet/compare/f20e914...main).
Examples include the [thesis/Jars addition](https://github.com/honey-wallet/honey-wallet/commit/a88b684),
[NEAR Intents jar buys](https://github.com/honey-wallet/honey-wallet/commit/af04547),
[live swaps](https://github.com/honey-wallet/honey-wallet/commit/c5007d1),
and [group jars](https://github.com/honey-wallet/honey-wallet/commit/675f97c).
Freeze the final reviewed commit before submission; `main` is a moving comparison.
No team member is entering another project, as confirmed by the team on 13 November.

## Libraries and attribution

Honey uses Expo/React Native, Next.js, Rust/axum/tokio, viem, WalletConnect/Reown,
Firebase, Noble/Scure cryptography, Reanimated and other packages recorded in
[package manifests](package.json), [pnpm-lock.yaml](pnpm-lock.yaml) and
[Cargo.lock](Cargo.lock). AI-assisted development is used; no particular assistant
or model is claimed to have certified the implementation.

Third-party source includes the MIT-licensed [deck scaffold](deck/LICENSE) and
[liquid UI components](apps/web/src/components/liquid/LICENSE). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). These retain their own licenses.
We do not claim that this repository contains no templates or borrowed code.

## Checks and repository map

```sh
pnpm lint
pnpm typecheck
pnpm test
```

Use Node 24 for tests. CI additionally builds JS apps, checks Expo dependencies,
and runs explicitly selected PostgreSQL/Redis integration tests. Some integration
and live-provider tests are skipped by default; inspect the test output and CI
workflow for their scope. A green unit test run is not a funded-chain test.

| Path | Purpose |
| --- | --- |
| `apps/mobile` | Expo native product; Feed, Jars, Wallet and transaction flows |
| `apps/server` | Rust API; auth, social data, thesis agent and provider adapters |
| `apps/web` | Next.js product site/public share pages, port 3200 |
| `apps/extension` | Chrome wallet build; does not expose the phone's full product |
| `apps/console` | Separate backend operations/read surfaces; see its manifest |
| `deck` | Product presentation/demo visuals |
| `packages/api-client` | Shared typed API contracts/client |
| `packages/keyring` | Address derivation, device-held keys, backups and signing |

More setup: [CONTRIBUTING.md](CONTRIBUTING.md). Backend scope and operational
limitations: [docs/backend/IMPLEMENTATION.md](docs/backend/IMPLEMENTATION.md).
Report vulnerabilities privately following [SECURITY.md](SECURITY.md).

## License

Honey's first-party code remains source-available under
[PolyForm Noncommercial 1.0.0](LICENSE). Commercial use requires separate permission.
The team chose to retain this license; the hackathon does not require MIT.
Contributions follow [CLA.md](CLA.md). Third-party MIT notices remain applicable
to their respective components and must not be removed or relabeled as Honey's.
