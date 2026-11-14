# Honey at NEAR HACKATHON

Honey is a mobile wallet for investing with friends. You build a jar (a basket of tokens),
post it, let friends copy it and earn a cut of their profit, or buy one together from a
shared treasury held by a Sputnik DAO on NEAR. Every swap goes through NEAR Intents first.

This file is the submission write-up. Product overview and setup: [README.md](README.md).
The organizers' rules live at [nearhackathon.com/HACKATHON.md](https://nearhackathon.com/HACKATHON.md).

| | |
| --- | --- |
| Event | [NEAR HACKATHON](https://nearhackathon.com), 1 to 14 Nov 2026 (code from the 19 Oct announcement counts, rule Q-001) |
| Tracks | Social Money (`social`), Unstoppable DeFi (`defi`). TODO(owner): confirm the final list. |
| Repository | [github.com/honey-wallet/honey-wallet](https://github.com/honey-wallet/honey-wallet) |
| App | iOS public beta on [TestFlight](https://testflight.apple.com/join/5krzqTCR). Android coming soon. |
| Website and deck | [honeywallet.org](https://honeywallet.org), [honeywallet.org/deck](https://honeywallet.org/deck) |
| API | [api.honeywallet.org](https://api.honeywallet.org/health) |
| Demo post on X | TODO(owner): link to the published post with the demo video. |
| Demo video | TODO(owner): link. |
| License | [PolyForm Noncommercial 1.0.0](LICENSE) |

## Tracks

### Social Money (`social`)

The track asks for shared budgets, collective ownership and programmable rewards on
Sputnik DAO. Honey builds what friends do with a multisig, not the multisig.

| Track idea | What Honey built | Evidence |
| --- | --- | --- |
| Collective ownership | Group jars: 2 to 5 people put in the same share and each owns 1/N of one jar. | [groups.rs](apps/server/src/routes/social/groups.rs), [group-jars.ts](apps/mobile/src/lib/group-jars.ts) |
| Sputnik DAO | One DAO per group (`<name>.sputnik-dao.near`), created from the official factory with a majority policy (2 of 2, 2 of 3, 3 of 4, 3 of 5). Buys and sells are DAO proposals; the approval that reaches the threshold executes them. | [jar_dao.rs](apps/server/src/jar_dao.rs), [sputnik.ts](packages/keyring/src/sputnik.ts), [jar-dao.ts](apps/mobile/src/lib/jar-dao.ts) |
| Shared budget | The jar's money is held as NEAR Intents balances owned by the DAO on `intents.near`. The server checks every deposit and proposal on chain; it never signs for the jar. | [routes/jar_dao.rs](apps/server/src/routes/jar_dao.rs) |
| Programmable rewards | Creators set a cut of copiers' profit (0 to 30%, never on a loss). It is collected on the copier's sell through 1Click `appFees`. | [copy_fees.rs](apps/server/src/copy_fees.rs) |
| Reputation | Public profiles, follows, a Feed and a Leaderboard of the top 20 jars by return over 7 days, 30 days or all time, valued at 1Click prices. | [social.rs](apps/server/src/routes/social.rs) |
| Onboarding friends | Honey's relayer pays members' DAO gas as NEP-366 meta transactions and pays the DAO creation deposit. | [near_relayer.rs](apps/server/src/near_relayer.rs) |

Not used: Trezu. Members are NEAR implicit accounts derived from their phrase, not
named accounts.

### Unstoppable DeFi (`defi`)

The track asks for trading that settles across chains through NEAR Intents, with no
custodian.

| Track idea | What Honey built | Evidence |
| --- | --- | --- |
| Trading through NEAR Intents | Every swap, jar buy and jar sell is quoted on 1Click first. A DEX is used only when 1Click can't do the trade, and "Private routes only" turns that off. | [route_planner.rs](apps/server/src/route_planner.rs), [BEST-ROUTE.md](docs/routing/BEST-ROUTE.md) |
| Cross-chain baskets | A jar's picks can sit on different chains; one approval pays every 1Click deposit. | [jar_buys.rs](apps/server/src/jar_buys.rs), [jar-buy.ts](apps/mobile/src/lib/jar-buy.ts) |
| No custodian | Keys stay on the phone. Deposits go from the wallet to 1Click; unfilled swaps refund to the user's address. | [packages/keyring](packages/keyring), [intents-swap.ts](apps/mobile/src/lib/intents-swap.ts) |
| Trading agent | The thesis agent on NEAR AI Cloud turns an idea into a jar and dry-quotes every pick on 1Click before proposing it. | [thesis/](apps/server/src/thesis), [EVAL.md](docs/thesis-agent/EVAL.md) |

Not used: Chain Signatures.

### Other tracks

TODO(owner): decide whether to add any other track. The closest fit is Privacy & Private
AI (`privacy`): the agent runs on NEAR AI Cloud, and a Confidential Intents proxy for
private jars exists but is off by default. Honey does not use TEE attestation.

## What was built during the hackathon

- The NEAR HACKATHON announcement was posted on 19 Oct 2026. Rule Q-001 counts code from
  then; earlier work is baseline.
- This repository's first commit, [`f20e914`](https://github.com/honey-wallet/honey-wallet/commit/f20e914)
  (20 Oct 2026), imports Honey's existing EVM wallet: keyring, server, savings and sign-in.
  We treat it as the baseline (rules Q-002, Q-004). It contains no NEAR Intents, Sputnik
  DAO or NEAR AI code: `git grep -il '1click\|sputnik\|near ai' f20e914` finds nothing.
- After it: 5 commits from 20 to 22 Oct, then 369 commits from 8 to 14 Nov.
- Full diff: [f20e914...main](https://github.com/honey-wallet/honey-wallet/compare/f20e914...main).

| Date | Commit | What landed |
| --- | --- | --- |
| 20 Oct | [`cbaecaa`](https://github.com/honey-wallet/honey-wallet/commit/cbaecaa) | Native NEAR accounts in the keyring; test mode |
| 8 Nov | [`a88b684`](https://github.com/honey-wallet/honey-wallet/commit/a88b684) | Thesis jars: the agent on NEAR AI Cloud |
| 8 Nov | [`af04547`](https://github.com/honey-wallet/honey-wallet/commit/af04547) | Real jar buys through NEAR Intents 1Click |
| 9 Nov | [`eb0350e`](https://github.com/honey-wallet/honey-wallet/commit/eb0350e) | Shared jars on NEAR as Sputnik DAOs |
| 10 Nov | [`c5007d1`](https://github.com/honey-wallet/honey-wallet/commit/c5007d1) | Swaps through 1Click: quote, verify, pay, follow |
| 13 Nov | [`675f97c`](https://github.com/honey-wallet/honey-wallet/commit/675f97c) | Group jars v1 and the NEP-366 relayer |
| 13 Nov | [`b7ec79e`](https://github.com/honey-wallet/honey-wallet/commit/b7ec79e) | Free gas on Base, Arbitrum, Polygon, Solana and NEAR |
| 13 Nov | [`a214349`](https://github.com/honey-wallet/honey-wallet/commit/a214349) | Social: one jar flow, profile privacy |
| 14 Nov | [`50496b0`](https://github.com/honey-wallet/honey-wallet/commit/50496b0) | Route planner: NEAR Intents first, DEX fallback |
| 14 Nov | [`a88e310`](https://github.com/honey-wallet/honey-wallet/commit/a88e310) | Creator copy fees through 1Click `appFees` |

## Demo script (about 2.5 minutes)

Record on the TestFlight build with small amounts, or on a local test-mode build. Say
which on screen: test-mode balances and receipts are samples.

| Time | Screen | Say |
| --- | --- | --- |
| 0:00 | Feed, Everyone | "Friends already trade ideas in group chats. Honey makes that a wallet." |
| 0:15 | Tap **Copy** on a jar → review → approve | "Copying a jar buys the same tokens. The creator earns a cut of my profit, never of a loss." |
| 0:40 | Jar button → **Create a jar → Describe an idea** → type "AI data-centre spending keeps growing" | "The agent runs on NEAR AI Cloud." Show the stages as they appear. |
| 1:05 | The proposal: picks, weights, the caution | "Models only choose from lists the code builds. Weights and amounts come from code. A critic writes the case against." |
| 1:20 | **Launch your jar** → one approval → the jar page | "One approval pays every pick through NEAR Intents." |
| 1:40 | Settings → **Your cut on copies** | "Creators set their cut here." |
| 1:50 | Group jar: invite friends → a friend accepts → **Your share is in** | "Up to five friends, equal shares. The money sits in a Sputnik DAO on NEAR." |
| 2:15 | Group jar page: **Changes need 2 of 3** | "Selling is a DAO proposal. It runs when the majority approves on their own phones." |
| 2:30 | The group's DAO on a NEAR explorer | TODO(owner): a real DAO account to show, only if one was funded. |

## Judging notes

### Technical depth

- **Route planner.** Every candidate is quoted in parallel under a timeout; a DEX wins
  only on one of four stated reasons, never on price alone
  ([route_planner.rs](apps/server/src/route_planner.rs)).
- **NEAR relayer without a NEAR SDK.** Borsh transactions and NEP-366 delegate actions
  are built and signed in Rust; byte layouts are pinned against `near-api-js` 7.3.1 output
  ([near_relayer.rs](apps/server/src/near_relayer.rs),
  [fixtures](packages/keyring/src/fixtures)).
- **Copy fee math on the server.** FIFO across copied lots, fee only on profit, capped
  so 1Click's own fee still fits under its 500 bps limit
  ([copy_fees.rs](apps/server/src/copy_fees.rs), [tests](apps/server/tests/copy_fees.rs)).
- **Gas ledger.** One allowance across six chains, decided under a PostgreSQL advisory
  lock so racing requests can't overspend ([gas_allowance.rs](apps/server/src/gas_allowance.rs)).
- **Agent eval.** 35 cases against the real model, live news and dry 1Click quotes, with a
  before and after table ([EVAL.md](docs/thesis-agent/EVAL.md),
  [thesis_evals.rs](apps/server/tests/thesis_evals.rs)).

### Use of NEAR

NEAR Intents 1Click for all trading and for copy fees; `intents.near` balances as the
group treasury; Sputnik DAO v2 for group ownership and votes; NEP-366 meta transactions
so members pay no gas; NEAR AI Cloud for every model call; NEAR implicit accounts in the
keyring. Table with file links: [README, How Honey uses NEAR](README.md#how-honey-uses-near).

### User experience

- One approval buys a whole jar across chains.
- Face ID confirms; the phone checks each quote before it signs.
- When a trade can't go through NEAR Intents, the review says why in one line and that
  the swap is public.
- Nothing is public until you claim a handle. Sharing trades is off by default.

### Impact

Honey is for people who already invest with friends. It turns "what are you buying?"
into a jar you can copy, and a group bet into a treasury no single friend controls.
Creators get paid when their picks make money for others.

## Known limitations

- NEAR Intents has no testnet, so live flows spend mainnet funds.
- iOS only (TestFlight public beta). Android is not on a store yet.
- Gas sponsorship and the DEX fallback are server switches, off by default.
- Private jars (Confidential Intents) are experimental and off by default.
- No card on-ramp or cash off-ramp. Earn shows rates only.
- Test mode receipts and sample screens are not proof of settlement.

## What's next

These are marked "coming soon" or switched off in the code today.

- Android release.
- Private jars on Confidential Intents (code exists behind `EXPO_PUBLIC_STEALTH_JARS`).
- Card on-ramp and cash off-ramp (no provider connected).
- Earn deposits (the app shows rates only).

## Disclosures

- **Existing product (Q-002).** Honey existed as an EVM wallet before the event; see the
  baseline above. Only the NEAR work after it is submitted.
- **Libraries and AI (Q-005).** Dependencies are listed in [package.json](package.json),
  [pnpm-lock.yaml](pnpm-lock.yaml) and [Cargo.lock](Cargo.lock). Third-party code:
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). AI coding assistants were used.
- **Other projects (Q-015).** No team member is entering another project, as confirmed
  by the team on 13 November.

## Before submitting (owner)

- [ ] TODO(owner): publish the X demo post (tags @NEARProtocol and #NEARHackathon, video attached) and add its link above.
- [ ] TODO(owner): confirm tracks.
- [ ] TODO(owner): team names and roles in [README.md](README.md#team-license-acknowledgements).
- [ ] TODO(owner): the `pre-hackathon` tag on GitHub points to `06f9ec1`, which is not in
      `main`'s history. Move it to `f20e914` (or delete it) and add a `hackathon-submission`
      tag on the final commit (rule Q-003).
- [ ] Project name, team lead, email, team size, payout NEAR account and consent go in the
      submission form only, never in this repository.
