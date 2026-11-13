# More tokens: DEX routing beyond the 1Click list

Status: research and proposal, 2026-11-13. No code has changed. All prices, limits and
fees were checked against the provider docs on that date (links inline). Gas figures use
live `eth_gasPrice` readings and CoinGecko prices from the same day (ETH $1,929, SOL $79.57,
POL $0.087).

## 1. Where we are

- **Jar buys** (`apps/mobile/src/lib/jar-buy.ts`, `apps/server/src/jar_buys.rs`) use NEAR
  Intents 1Click only. The app sends one USDC deposit per leg. On Base, up to 6 deposits go
  in one sponsored Calibur batch. **Jar sells** (`lib/jar-sell.ts`) run one 1Click swap per
  token back to USDC/ETH on Base or SOL.
- **The thesis registry** (`apps/server/src/thesis/registry.rs`) uses the 1Click
  `/v0/tokens` list as its whole universe. Models name instruments; code resolves the
  addresses.
- **Uniswap Trading API** has a large, careful server stack: `providers/uniswap*.rs`,
  `permit2.rs`, `uniswap_service.rs`, `swap_review.rs`, `routes/swaps.rs`, mobile
  `lib/uniswap-execution.ts`. It covers quote validation, a Universal Router decoder,
  Permit2 checks and fee proofs. It is **quote-only in production**: execution is
  local-fork only (`UNISWAP-SERVICE.md`), tokens must be pre-registered, hooks and
  fee-on-transfer tokens are excluded, and no API key was ever supplied (`UNISWAP-QUOTES.md`).
- **Relay**: an authenticated quote *preview* exists (`providers/relay_quotes.rs`,
  `routes/relay_quotes.rs`). It returns no executable steps.
- **Across**: no live integration. `database.rs` has a "remove Across settlement" migration.
  0x, 1inch, LI.FI, Kyber, Odos, CoW, Velora, Jupiter and Rhea: not wired.
- **Sponsored gas** (`evm_sponsor.rs`) on Base/Arbitrum/Polygon accepts **only plain
  transfers**: one transfer to anyone, or up to `MAX_CALLS = 6` transfers into quoted
  1Click deposits. Each chain has a gas cap (Base `max_gas` 600k). An `approve` or a router
  call is refused today.
- **The Solana fee payer** (`solana_relayer.rs`) accepts legacy messages only, with no
  lookup tables and only System/SPL/ATA/ComputeBudget/Memo programs. A Jupiter swap is
  refused today.
- **Gas ledger** (`gas_allowance.rs`): each person gets $1 per 30 days, plus $0.10 per chain
  per day. Each chain has a daily total across all users: Base, Arbitrum and Polygon $0.50,
  Solana $1. Honey pays the rent for one new Solana token account per person per 30 days.
- **Keyring**: it already signs Solana v0 transactions (`sign.ts` `readSolanaTransaction`)
  and Calibur batches (`evm-sponsor.ts`).

## 2. Provider comparison

"7702 fit": can the swap be expressed as plain calls inside one Calibur batch the user signs
once, with Honey paying gas? An "exact approve + router call" design fits. A design that
needs an off-chain order signature does not, or only in part.

| Provider | Chains we need | Cross-chain | Key / cost / limits | Integrator fee | Approval model | 7702 fit | MEV | Notes |
|---|---|---|---|---|---|---|---|---|
| **0x Swap API v2** | Base, Arb, Polygon, Eth (Solana not in Swap API table) | separate Cross-Chain API | key from dashboard; 5 RPS; **0.15% on "select pairs"**; 0x keeps trade surplus on Standard. Pricing page shows "Standard $1000" with no period given; rate-limit page calls 5 RPS the "Free Tier" | `swapFeeBps` 0–1000 to up to N recipients, in buy or sell token | **AllowanceHolder** (recommended): `approve(AH)` then `AH.exec`; Permit2 optional | **Yes**: approve + exec as 2 calls | RFQ only; AMM legs public | Response carries `buyTaxBps`/`sellTaxBps` and allowance/balance `issues`. 150+ sources incl. Aerodrome |
| **Uniswap Trading API** | Base, Arb, Polygon, Eth (+ UniswapX on Eth/Arb/Base) | `BRIDGE` routing | key via Uniswap dev platform; **API free, no API fee**; 6 RPS | `integratorFees` ≤4 × ≤500 bps (Σ ≤500) | Permit2 (`permitData`), or `/swap_7702` / `/swap_5792` | **Yes**: `/swap_7702` targets *Uniswap's* 7702 delegate, i.e. Calibur (confirm) | UniswapX fills privately | Uniswap pools only (v2/v3/v4), so no Aerodrome. Unsupported-token list. Repo already validates it |
| **KyberSwap** | all four | no | public, 3 RPS (`x-client-id`); keys for more | `feeAmount` + `chargeFeeBy` in/out | approve router | Yes | none | No protocol fee; positive slippage taken on some trades |
| **1inch** | all four | separate Fusion+ | free Dev plan 60 req/min, 100k/mo; paid from $10/mo | `fee` param | approve router / Permit2 | Yes (Classic); Fusion needs signed orders | Fusion is private | Business portal terms and KYC for x402 |
| **LI.FI** | all four + Solana | **yes** (bridges + DEX) | keyless 75 quotes/2h; key 100 req/min | `fee` fraction; LI.FI "may receive a share" | approve LI.FI Diamond | Yes (same-chain) | depends on sub-route | A meta-aggregator; adds a hop and another contract |
| **Relay** | all four + Solana | **yes**, single deposit | no key needed; rev share only at >$10M/30d plus KYB | app fees | approve/deposit steps | Partly: step list must be validated per step | solver fills | Platform fee 0.01% stables, 0.06% majors, **0.15% minor**, + $0.02 + dest gas |
| **Velora (ParaSwap)** | all four | Delta (intents) | anon partner works; partner key via email | `partnerFeeBps` ≤200; Market split 85/15 | approve TokenTransferProxy | Yes (Market) | Delta private | anon partner pays a flat 1 bps |
| **Odos** | all four | no | free ~1,000 req / 5 min; enterprise key | referral code; partner gets 80% | approve router | Yes | none | fee page returned HTTP 530 on 2026-11-13: re-check |
| **CoW** | Eth, Arb, Base, Polygon (verify) | no | free API | partner fee, CoW keeps 15% | one approve to VaultRelayer + EIP-712 order | Approve only; solver pays swap gas | **batch auction, MEV-protected** | ~30 s+ settlement; weak on long tail and tiny orders |
| **Jupiter Swap V2** | Solana | no | keyless 0.5 RPS; Free 1 RPS; Dev $25/mo 10 RPS; Launch $100 50 RPS; Pro $500 150 RPS; `/execute` 50–100 RPS | `/order`: `referralFee` 50–255 bps (Jupiter keeps 20%); `/build`: `platformFeeBps` | n/a (SPL) | n/a. Gas: Jupiter gasless, or `payer` | Jupiter landing, private until on-chain | `/order` fee 0–10 bps, **50 bps for tokens <24h old**. **Ultra is deprecated** in favour of Swap V2 |
| **Rhea (Ref)** | NEAR only | no | SDK expects your own FindPath backend | — | NEAR `ft_transfer_call` | n/a | — | Overlaps 1Click's NEAR list; low value |

Sources: 0x [intro](https://docs.0x.org/evm/0x-swap-api/introduction),
[pricing](https://0x.org/pricing), [rate limits](https://docs.0x.org/docs/developer-resources/rate-limits),
[fees](https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap),
[tax tokens](https://docs.0x.org/evm/0x-swap-api/additional-topics/buy-sell-tax-support),
[chains](https://docs.0x.org/docs/introduction/supported-chains), [FAQ](https://docs.0x.org/docs/introduction/faq);
Uniswap [FAQ](https://developers.uniswap.org/docs/trading/swapping-api/faqs),
[/swap_7702](https://developers.uniswap.org/docs/api-reference/create_swap_7702_transaction),
[/swap_5792](https://developers.uniswap.org/docs/api-reference/create_swap_5792_transaction),
[chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains);
Kyber [rate limits](https://docs.kyberswap.com/developer-guide/start-here/rate-limits-and-client-id),
[fees](https://docs.kyberswap.com/getting-started/fee-schedule);
1inch [pricing](https://business.1inch.com/pricing), [plans](https://business.1inch.com/portal/documentation/payment-methods/subscriptions);
LI.FI [rate limits](https://docs.li.fi/api-reference/rate-limits), [fees](https://docs.li.fi/introduction/integrating-lifi/monetizing-integration);
Relay [fees](https://docs.relay.link/references/api/api_core_concepts/fees);
Velora [monetization](https://www.velora.xyz/docs/overview/monetization);
Odos [pricing](https://docs.odos.xyz/build/api_pricing), [referral](https://docs.odos.xyz/product/sor/v2/referral-code);
CoW [fees](https://docs.cow.fi/governance/fees), [partner fee](https://docs.cow.fi/governance/fees/partner-fee);
Jupiter [Swap V2](https://developers.jup.ag/docs/swap.md), [gasless](https://developers.jup.ag/docs/swap/advanced/gasless.md),
[rate limits](https://developers.jup.ag/docs/portal/rate-limits.md), [plans](https://developers.jup.ag/docs/portal/plans.md),
[Ultra notice](https://developers.jup.ag/docs/ultra); 1Click [fees](https://docs.near-intents.org/resources/fees)
(0.2% extra without a partner JWT; `NEAR_INTENTS_API_KEY` must stay set).

## 3. Recommendation

**Keep 1Click for anything it lists and for moving USDC between chains. Add one
chain-native aggregator per VM for the last mile: 0x Swap API v2 (AllowanceHolder) on
Base/Arbitrum/Polygon/Ethereum, and Jupiter Swap V2 on Solana.** On a sponsored EVM chain,
an EVM swap is an atomic Calibur batch `[approve(token, AllowanceHolder, exact), AH.exec(...)]`
that Honey pays for. If the user's USDC is already on the target chain, nothing crosses
chains.

Why 0x over Uniswap for v1:
- Coverage. Base long-tail liquidity is split between Uniswap and Aerodrome, Polygon has
  QuickSwap, Arbitrum has Camelot. Uniswap's API routes only Uniswap pools. 0x aggregates
  150+ sources.
- Tax and honeypot hints. 0x returns `buyTaxBps`/`sellTaxBps` per quote.
- A simpler call shape. AllowanceHolder needs one exact approve and one call, with no
  off-chain permit signature. The sponsor can allowlist one fixed spender
  (`0x0000000000001fF3684f28c67538d4D072C22734` on Cancun chains, from the 0x response) and
  decode `exec(operator, token, amount, target, data)` to pin token and amount.

Uniswap remains a strong **second quote source in phase 2**: it is free, its `/swap_7702`
is built for Calibur, and the repo already validates its responses. It is the fallback if
0x's commercial terms turn out to be a paid commitment.

Rejected as the primary route:
- **Relay/LI.FI**: one signature cross-chain is attractive, but they add an opaque
  multi-step execution plan and another fee layer (Relay charges 0.15% on minor tokens). Relay
  is the phase-3 candidate to collapse two legs into one.
- **CoW**: too slow and weak on the long tail.
- **1inch/Kyber/Odos/Velora**: viable but redundant. Kyber is the free fallback with the
  same call shape.

### Buy, cross-chain (USDC on Base → long-tail token on Arbitrum)

```
User        App (device keys)        Honey server            1Click        0x API     Arbitrum (Calibur)
 | Face ID ->|                         |                       |              |              |
 |           |-- jar quote ----------->| plan: leg A intents   |              |              |
 |           |                         |  USDC.base→USDC.arb   |              |              |
 |           |                         |  to user's own addr --+--> quote --->|              |
 |           |                         | leg B dex quote (sell=minOut(A))---->| quote+data   |
 |           |<-- legs + calldata -----|                       |              |              |
 |           | verify A with 1Click; decode B (spender, token, amount, recipient=self, minOut)
 |           | sign batch A on Base (deposit); sign batch B on Arbitrum
 |           |   (deadline ≤600 s, exact approve, AMM-only quote) under the one Face ID
 |           |-- submit A (sponsored) ->| relayer sends on Base  |              |              |
 |           |-- park B --------------->| store signed B (encrypted, until deadline)          |
 |           |                         |<-- status SUCCESS -----|              |              |
 |           |                         | eth_call/eth_simulateV1 B: USDC −x, token ≥ minOut   |
 |           |                         |-- relayer execute(B) ---------------------------->|
 |           |<-- push / poll: leg B done or REVERTED (user keeps USDC on Arbitrum)            |
```

- Leg B sells exactly 1Click's guaranteed `minAmountOut` of USDC. Any surplus USDC stays as
  "change" in the jar and is shown, never lost.
- Pre-signing only works where Honey sponsors gas. On Ethereum, and on Solana (whose
  blockhash lives ~60–90 s, shorter than a bridge), leg B is signed by the device when the
  funds land while the app is open. Otherwise it becomes a "Finish buying" card that takes
  one more Face ID.
- **Same-chain shortcut (Q2): yes, always prefer it.** When the target chain already holds
  enough USDC (or ETH/SOL, swapped directly), skip 1Click. It costs one transaction,
  carries no bridge fee or partial-failure state, and is atomic. `planOrigins` should rank
  "same chain as the leg" before "largest balance". On Base, the 1Click deposits and the
  DEX swaps of one jar share **one** batch (1 approve(Σ) + N `exec` + M transfers), so a jar
  buy on Base is all-or-nothing.

### What breaks in two legs (Q1)

| Failure | Result | UX |
|---|---|---|
| 1Click can't fill leg A | USDC refunded to origin (existing behaviour) | Leg shows Refunded; parked B expires at its deadline, server drops it |
| A fills, B reverts (price moved past slippage, liquidity pulled) | Atomic revert; user holds USDC on target chain; Honey lost ~$0.01 gas | Jar leg "Holding $24.80 USDC on Arbitrum": **Finish** (re-quote, Face ID) or **Move back** (1Click to Base) |
| A late, B past deadline | Same as above | Same |
| App killed between A and B (non-sponsored chains) | Same as above | Card on next open |
| Two-leg slippage | Leg A is USDC→USDC (~0.05–0.1%); leg B is the DEX. The combined bound must stay ≤ `MAX_SLIPPAGE_BPS` (300) | One "max slippage" number in review covering both legs |

Activity and jar: extend `BuyLeg` with `route: 'intents' | 'dex'`, an optional `bridge`
(the 1Click part) and a `swap: {chainId, txHash, sellAmount, minOut, status}`.
`jar-holdings` counts a leg in `HOLDING_USDC` at its USDC value, so the jar total never
dips during a pending leg.

## 4. Token universe and scam filtering (Q3)

A token becomes **dex-buyable** only through an offline job (every 6 h). It runs on the
server; the model never supplies an address (registry rule R-AU-1..3 stays).

1. **Candidates**: CoinGecko `/coins/list?include_platform=true` (contract per platform;
   `COINGECKO_API_KEY` already supported), the Uniswap default list (`tokens.uniswap.org`)
   for EVM, and Jupiter `GET /tokens/v2/tag?query=verified` for Solana
   ([tokens API](https://developers.jup.ag/docs/api-reference/tokens/tag.md)).
2. **Liquidity floors** (DexScreener/GeckoTerminal, already in `market_data.rs`): pool depth
   ≥ $100k (twice `jar-routes` `MIN_DEPTH_USD`), 24 h volume ≥ $50k, oldest pool ≥ 7 days,
   and a price from two sources that agree within 2%.
3. **Contract checks**:
   - GoPlus `token_security` (EVM + Solana): free tier 150k CU per month, 30k per day, 150
     per minute ([pricing](https://gopluslabs.io/security-api)). Reject honeypot, owner can
     mint, blacklist or whitelist, transfer pausable, buy or sell tax > 1%, proxy with
     mutable owner.
   - Honeypot.is: free, no key, **Ethereum/BSC/Base only** ([chains](https://docs.honeypot.is/chains)).
     Use it as a second opinion on Base.
   - Solana: Jupiter `audit.isSus` absent, `mintAuthorityDisabled` and
     `freezeAuthorityDisabled` true, `organicScoreLabel` ≠ low, and Token-2022
     transfer-fee/hook extensions refused.
   - Blockaid (transaction scanning, sales-led pricing) is phase 3.
4. **Per-quote checks**: refuse when 0x `buyTaxBps`/`sellTaxBps` is non-zero or null. Run a
   **sell-back probe** (quote token → USDC for the bought amount) and refuse when no route
   exists or the round trip loses more than 3% plus fees.

Registry merge (the `thesis/registry.rs` owner should make this change): add
`route: Intents | Dex { venue: ZeroEx | Jupiter }` and `safety: {checkedAt, flags}` to
`RegistryAsset`. Prefer `Intents` when 1Click lists the same chain+contract, because that
path is proven and has refunds. Fall back to `Dex` only for assets in the allowlist above.
Key both on `(chain, contract)`, and join `coingecko_id` so look-alike symbols never
collide. Cap the universe at a few thousand assets so prompts stay bounded.

## 5. Selling (Q4)

The reverse uses the same pieces. For each `dex` leg, a same-chain swap token → USDC goes in
one sponsored batch per chain (approve exact + exec), with the sell amount floored as
`sellUnits` does today. Proceeds land as USDC on that chain. When the user picked "USDC on
Base" and the token was elsewhere, a 1Click USDC→USDC.base leg follows, so a cross-chain
sell can leave USDC on the token's chain. Show that state the way buys show it. On
Solana, Jupiter `/order` → sign → `/execute`. Refuse to sell when `sellTaxBps` exceeds the
value the review shows. `recordSell` gains `route` and `txHash`.

## 6. Gas cost against the $1 allowance (Q5)

Estimate: approve (~46k) + aggregator swap (150–350k) + Calibur overhead (~40k), plus ~25k
the first time for the 7702 authorization. That is ≈250–450k gas per swap.

| Chain | Gas price 2026-11-13 | Cost per swap | Swaps per $1 | Binding limit today |
|---|---|---|---|---|
| Base | 0.006 gwei (+ L1 data fee, measure) | ≈ $0.003–0.006 + <$0.005 L1 | ~100+ | **chain total $0.50/day ⇒ ~50–100 swaps/day for all users** |
| Arbitrum | 0.02 gwei | ≈ $0.010–0.017 | ~60 | $0.10/person/day ⇒ ~6 swaps |
| Polygon | 284 gwei POL | ≈ $0.006–0.011 | ~90 | chain total $0.50/day |
| Ethereum | 0.45 gwei (not sponsored) | ≈ $0.22–0.39, user pays in ETH | — | phase 3 |
| Solana | 5k lamports/sig + priority | ≈ $0.001–0.01 fees; **new token account rent 0.00204 SOL ≈ $0.16** | rent-bound | 1 sponsored new account per 30 d |

- On EVM, the per-person $1 is not the problem; **the per-chain daily totals are**. Raise
  `GAS_DAILY_USD_BASE` and its siblings before launch, e.g. $5/day for ≈$150/month worst
  case per chain.
- A 5-token Base jar is ~1.0–1.5M gas. That needs `max_gas` on Base raised from 600k to
  ~1.5M and `MAX_CALLS` from 6 to ~12. Cost is still ≈$0.01–0.02.
- On Solana, phase 1 should **not** use Honey's payer. Jupiter's automatic gasless covers
  fees **and ATA rent** when the taker has <0.01 SOL and the trade is ≳$10, recovering the
  cost from the swap. It is disabled when `payer` or a referral fee is set. So for phase 1:
  Solana DEX legs ≥ $10 and no Honey fee on Solana. Phase 2 can add `payer` = Honey relayer
  plus a referral fee, which needs a new `solana_relayer.rs` policy branch (v0 + ALTs +
  Jupiter program, with a simulated balance-delta check).

## 7. Safety (Q6)

- **Caps**: DEX legs ≤ $250 each (server `DEFAULT_CAP_USD`) and ≤ $1,000 per buy (client
  `MAX_BUY_USD`). Start the dex route at $100 per leg until the success rate is measured.
- **Slippage**: default 1% for `Dex` assets with depth ≥ $1M, else 2%. Hard max 3%, as
  today. Jupiter `/order` picks its own (RTSE), so the app refuses an `otherAmountThreshold`
  below `out × (1 − max)`.
- **Quote expiry**: re-quote quotes older than 30 s before signing (0x and Uniswap both
  advise this; 0x RFQ lives ~60 s). Parked leg-B batches use AMM-only quotes (exclude RFQ
  sources) and the Calibur deadline (≤600 s).
- **Device checks before signing** (like `checkQuote`):
  - the target is AllowanceHolder;
  - the approve is to AllowanceHolder for exactly the sell amount;
  - the decoded `exec` token and amount match;
  - the recipient is the wallet itself;
  - `minBuyAmount` is within the slippage bound;
  - `transaction.value == 0` for ERC-20 input;
  - the 0x `issues` field is empty.
  For Solana: the program set is a known list, the taker is the only user signer, and
  there is no `SetAuthority`/`CloseAccount` on user accounts.
- **Simulation before relaying**:
  - The server already runs `eth_estimateGas` on the batch. Add `eth_simulateV1` (or
    Tenderly) with transfer tracing and assert: the wallet's sell token falls by ≤ the sell
    amount, the buy token rises by ≥ `minOut`, and no other token leaves.
  - Solana: `simulateTransaction` with `accounts` to read the post-balances.
  - Tenderly costs money; prefer `eth_simulateV1` and check our RPC providers support it on
    all three chains.
- **MEV**: the Base/Arbitrum/Polygon sequencers have no public mempool, so sandwich risk is
  low but not zero. Use tight `minOut`. Ethereum swaps go through a private RPC (Flashbots
  Protect or MEV Blocker). Jupiter `/execute` lands privately.

## 8. Files that would change

Server:
- New: `providers/zeroex.rs`, `providers/jupiter.rs`, `token_safety.rs`,
  `routes/dex_swaps.rs`. Edits: `providers/mod.rs`, `routes/mod.rs`, `lib.rs`, `config.rs`
  (`ZEROEX_API_KEY`, `JUPITER_API_KEY`, `GOPLUS_*`).
- `evm_sponsor.rs` and `evm_sponsor/store.rs`: a new call class "quoted swap". Only
  approve-exact-to-AllowanceHolder plus `AH.exec` matching a server-issued dex quote
  (`quoted_swap` alongside `quoted_deposit`). Also: parked-batch storage and submit-on-arrival,
  and `MAX_CALLS`/`max_gas` raised.
- `gas_allowance.rs` (daily defaults), `jar_buys.rs` (split intents and dex legs; a leg-A
  recipient is the user's own target-chain address), and `database.rs` (`dex_swaps` table).
- `market_data.rs`: the CoinGecko platform map and `Venue.route`.
- `thesis/registry.rs` gets the route flag (owned by the thesis agent; coordinate).
- `.env.example`.

Shared:
- `packages/api-client/src/types.ts`: `DexQuote`, `JarBuyLeg.route/swap`, `RegistryAsset.route`.
- `packages/keyring/src/evm-sponsor.ts`: `erc20ApproveCall`.

Mobile:
- New: `lib/dex-swap.ts` (quote checks, AllowanceHolder decode, Calibur calls, Jupiter sign
  and execute).
- Edits: `lib/jar-buy.ts` (route split, same-chain-first `planOrigins`, combined Base batch,
  parked leg B), `lib/jar-sell.ts`, `lib/jar-holdings.ts` (HOLDING_USDC),
  `lib/jar-routes.ts` (dex venues, bridge cost), `lib/evm-gas.ts`, and the Activity
  rendering.
- Tests: `apps/mobile/tests/jar-buy*.test.ts` and `apps/server/tests/` (sponsor policy,
  decode, fixtures).

## 9. Phased plan

**Phase 1: same-chain only, Base + Solana (~2 weeks).**
- `Dex` assets on Base via 0x, paid from Base USDC only. Solana via Jupiter Swap V2
  `/order`→`/execute`, paid from Solana USDC only, legs ≥ $10, Jupiter gasless.
- Offline allowlist (CoinGecko + Jupiter verified + GoPlus + floors). Registry route flag.
  Sponsor "quoted swap" class.
- Device checks and server simulation, the $100 per-leg cap, sells back to USDC on the same
  chain.
- No cross-chain legs: a dex token whose chain lacks USDC shows "Add USDC on Base to buy
  this".

**Phase 2: cross-chain and more chains.**
- Arbitrum and Polygon. 1Click leg A plus parked, pre-signed leg B. The HOLDING_USDC state
  with Finish and Move back.
- Uniswap Trading API as a second quote, taking the better net-of-gas price.
- Jupiter `payer` + referral fee, with the Solana relayer policy extended.
- Optional Honey integrator fee (0x `swapFeeBps`, Jupiter referral).

**Phase 3: polish.**
- Ethereum (user-paid gas, private RPC).
- Evaluate Relay to replace two legs with one deposit.
- Blockaid scanning, raised caps.

## 10. Risks

1. **The sponsor becomes a general router payer.** Opaque aggregator calldata turns
   Honey's gas into a target. Mitigations: a fixed spender allowlist, server-issued quote
   binding, exact approvals, balance-delta simulation and per-chain gas caps. **This is the
   biggest risk.** A mistake here pays gas for, or approves, arbitrary calls.
2. **Scam tokens getting through.** Filters lag fresh rugs. Floors, the 7-day age rule and
   the sell-back probe reduce the risk; they don't remove it. A model-picked jar makes
   Honey look responsible for the pick.
3. **The two-leg limbo state** confuses users and adds support load; phase 1 avoids it.
4. **0x commercial terms are unclear**: "Standard $1000" with no period, a 0.15%
   select-pair fee, and surplus capture. Kyber and Uniswap are drop-in fallbacks.
5. **Per-chain daily gas totals** throttle all users at about 50–100 swaps per day.
6. **Provider concentration**: one aggregator per VM. Rate limits are 5–6 RPS on 0x and
   Uniswap and 1 RPS on the Jupiter free tier, so cache quotes and fan out per jar carefully.
7. **Regulatory**: Uniswap's unsupported list, 0x's RWA geofencing note, and India-law
   terms (`3e0f62a`). Long-tail tokens may also be unregistered securities.

## 11. Open questions for the founder

1. Create **0x** (dashboard.0x.org) and **Jupiter** (developers.jup.ag/portal) keys. Is the
   Jupiter Developer plan ($25/mo, 10 RPS) acceptable? Get a **Uniswap Trading API** key
   too, since it also unblocks the existing stack.
2. Confirm the 0x plan in writing: free tier vs "$1000 Standard", and which pairs pay 0.15%.
3. GoPlus: is the free tier (150k CU per month) enough, or do we pay $199/mo?
4. Do we charge an integrator fee on DEX legs? (We would need fee-recipient addresses and a
   Jupiter referral account.) Note that a Jupiter referral fee disables Jupiter gasless.
5. Raise the per-chain daily gas totals, and to what? $5/day per chain is about $150/month
   worst case.
6. What per-leg cap at launch: $100 or $250? What minimum Solana leg: $10?
7. Are "Holding USDC on Arbitrum" states acceptable in phase 2, or should we wait for a
   one-deposit route (Relay)?
8. Is `NEAR_INTENTS_API_KEY` (partner JWT) set in production? Without it, every 1Click leg
   pays an extra 0.2%.
