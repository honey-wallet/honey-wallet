# DEX routing and sponsored swaps: security audit

Date: 2026-11-13. Scope: the uncommitted `feat/dex-routing` worktree against `main` 4b09702.
Files: `apps/server/src/dex/*`, `routes/dex.rs`, the DEX changes to `evm_sponsor.rs`,
`solana_relayer.rs`, `routes/gas.rs`, `gas_allowance.rs`, `lib.rs`, and the mobile
`lib/dex.ts`, `lib/jar-dex.ts`, `lib/dex-tokens.ts`. Read-only review; no code changed.

Threat model: a signed-in attacker with a modified client, many sybil accounts, and tokens
or pools they deploy. Relayers hold about $1–2 each.

Method: every path from `POST /dex/quote` through `/gas/evm/{prepare,submit}` and
`/gas/solana/sponsor` was read end to end. The deployed KyberSwap router source
(`MetaAggregationRouterV2` at `0x6131…37b5`, from the verified-source mirror) was read to
check what the router enforces on chain. The live Kyber fixture was decoded. `cargo test
--lib dex::` passes (34 tests).

## Status (2026-11-13, after the fixes)

All eight findings are fixed in this worktree; each finding below has a **Status** line
naming its tests. Two known limits, both failing closed: an Ethereum Kyber build that
sends the sell token straight to a pool (a `srcReceiver` other than the executor, seen
once live) is refused, and only `shared_accounts_route_v2` has been checked against a
live Jupiter transaction (the other three route layouts are decoded from the IDL; a
mismatch is refused, not allowed). Both flags stay off until the founder turns them on.

## Verdict

**No Critical or High findings.** A relayer cannot be made to pay for anything other than
the exact quoted batch or message. Gas lost to griefing is charged to the attacker's own
ledger and bounded by the per-chain daily caps and relayer floors. User funds are protected
on chain by Kyber's `minReturnAmount` on the account's own balance, by an exact approve,
and by Jupiter's slippage check.

It is safe to ship **behind a flag** once findings 1–3 are fixed. Today there is no flag
(finding 2). Findings 4–8 can follow.

## What holds (checked, no finding)

- **EVM binding.**
  - `check_quoted_calls` (`dex/evm.rs:168`) requires byte-for-byte the stored calls: an
    exact `approve(router, sellAmount)` of the sell token, then one Kyber `swap` with
    value 0 to the single allowlisted router.
  - It then re-decodes the calldata from first principles: `srcToken`, `dstToken`,
    `dstReceiver == account`, `amount`, `minReturn ≥ stored min`, no fee receivers, no
    permit.
  - The batch is signed over those calls (Calibur `revertOnFailure = true`, executor = the
    relayer). Owned account, chain, taker, user, expiry and single use (`SET NX`) are all
    checked.
  - Alternative selectors (`swapGeneric`, `swapSimpleMode`), a different receiver, value,
    permit, unlimited or wrong-spender approves, reordering and extra calls are all refused.
- **Replay.** A quote is bound to user, chain and taker. Calibur's nonce and domain stop
  on-chain replay. Redis `SET NX` stops a double submit across replicas. Without Redis,
  each replica only knows its own quotes, which fails closed.
- **Quote mutation.** The stored quote is immutable. Prepare and submit both re-check it.
- **Gas.** `gas_limit = estimate × 1.3 + 10k`, at most `max_gas` (1M), and the reservation
  is at most `EVM_SPONSOR_MAX_TX_USD` ($0.05). Reverted receipts are settled at their real
  cost (`evm_sponsor.rs:1604`), so griefing reverts cost the attacker's own allowance.
- **Solana binding.**
  - The message must be byte-equal to the stored Jupiter message.
  - Exactly two signers: the relayer at index 0, then the taker. No duplicate keys.
    Programs must be static keys.
  - Only Compute Budget (≤1.4M CU, priority ≤0.0001 SOL), Jupiter v6, ATA
    `CreateIdempotent` (relayer as funder at most once, wallet = taker) and Token
    `SyncNative`/`CloseAccount` (owner = taker) are allowed. The System program is refused,
    so there are no transfers and no durable-nonce advance.
  - The relayer appears in no other instruction. ALTs cannot re-load it: the runtime
    rejects an account loaded twice.
  - The simulation caps the relayer's outflow at fee + rent and checks the taker's output
    ATA rises by at least the minimum.
- **Caches** are bounded:
  - GoPlus only checks universe tokens.
  - The universe is capped at 500 per chain.
  - The in-memory quote store is capped at 20k.
  - Redis keys carry a TTL.

## Findings

### 1. Medium — The app signs whatever router call the server returns

**Status: Fixed.** `apps/mobile/src/lib/dex.ts` pins KyberSwap's router per chain, requires exactly `approve(router, sellAmount)` + one `swap`, decodes the swap with viem (tokens, amount, `dstReceiver` = wallet, `minReturnAmount` ≥ `minBuyAmount`, no fees/permit, finding 5's flags/receivers/executor) and drops the AllowanceHolder exception; `checkSolanaSwap` mirrors the server's `check_swap` allowlist (no System, Token-2022, Memo or token transfers; ATA create only for and paid by the wallet) and decodes the Jupiter route. Bridged jar legs go through the same checks before auto-signing. Tests (`apps/mobile/tests/dex.test.ts`): "the device decodes the swap it signs (audit finding 1, 5)" (e.g. "refuses an approve and router call to a router that isn’t KyberSwap’s", "refuses calldata that pays someone else", "refuses calldata whose minimum is below the quote’s, though the JSON says fine"), "the device checks the Solana swap it signs (audit findings 1, 6)" (e.g. "refuses a token Transfer to an attacker appended to the swap", "refuses a System transfer, Token-2022, Memo or an unknown program"); `apps/mobile/tests/jar-dex.test.ts`: "never auto-signs a bridged leg’s requote that pays someone else (audit finding 1)".


`apps/mobile/src/lib/dex.ts:382-431` (EVM), `:458-492` (Solana); auto-signing in
`apps/mobile/src/lib/jar-dex.ts:74-81,199`.

The module says "the device doesn't take its word for it", but it does:

- **EVM: `evmCalls`.**
  - It accepts any `swap.to` that is neither the sell nor the buy token, and any selector
    except six ERC-20 ones.
  - It accepts an approve whose spender is that same arbitrary `swap.to`.
  - It never checks that `swap.to` is Kyber's router. It never decodes `dstReceiver` or
    `minReturnAmount`, so the "payout floor" it checks is the server's JSON field, not the
    calldata.
- **Solana: `checkSolanaSwap`.**
  - It allows System `Transfer` and every Token instruction except `SetAuthority`. That
    includes `Transfer`, `TransferChecked` and `Approve` to anyone.
  - It also allows Token-2022.

**Exploit.** Someone who controls the API or its responses (a compromised server, a
mis-issued certificate, or a bad deploy) returns `[approve(USDC, evil, amount),
evil.drain()]` for EVM, or appends `Token::Transfer(taker ATA → attacker)` for Solana.

- On Ethereum, and on Solana when the quote isn't sponsored, no server-side check sees the
  transaction. It is signed and broadcast from the device.
- For bridged jar legs, `advanceDexLegs` signs a fresh server quote with no user
  interaction for 30 minutes after the jar's confirmation.
- Loss per signature: up to the sold amount, which the user chose.

**Fix.**
- EVM: on device, require `swap.to` to be Kyber's router, decode `swap(...)` with viem,
  and require `srcToken`, `dstToken`, `amount`, `dstReceiver == taker` and
  `minReturnAmount ≥ minBuyAmount`, with no fee receivers and no permit. Drop the
  AllowanceHolder exception.
- Solana: refuse System and Token instructions other than ATA create, `SyncNative` and
  `CloseAccount` to the taker, as the server's `check_swap` already does.

### 2. Medium — No flag: DEX routing and sponsored swaps go live with the merge

**Status: Fixed.** `DEX_ENABLED` and `DEX_SPONSOR_ENABLED` (both off by default, documented in `apps/server/.env.example`; `dex/mod.rs` `DexConfig`). Off: `/dex/tokens`, `/dex/quote`, `/dex/route` answer 422 "DEX swaps aren't available right now" before any provider call; quotes are unsponsored; `/gas/evm/{prepare,submit}` and `/gas/solana/sponsor` refuse a `quoteId` with "Honey isn't paying gas for swaps right now". `/capabilities` reports `dex_swaps` and `dex_sponsored_swaps`, and the app hides DEX tokens unless `dex_swaps` is on (fails closed). Tests: `routes::dex::tests::every_dex_route_says_not_available_while_dex_is_off`, `dex::tests::nothing_is_listed_quoted_or_fetched_while_dex_is_off`, `dex::solana_sponsor_tests::quoted_swaps_are_refused_while_sponsoring_is_off_or_for_the_ineligible`, `evm_sponsor::tests::quoted_swaps_are_refused_while_dex_sponsoring_is_off_or_for_the_ineligible`, `routes::capabilities::tests::dex_swaps_are_reported_off_unless_enabled`, `tests/api.rs` `capabilities_never_advertise_unimplemented_trading`; mobile "hides every DEX token when the server says DEX swaps are off".


`apps/server/src/lib.rs:463` (`dex_service`), `:297` (`set_evm_sponsored`), `:331`;
`dex/mod.rs:253` (`DexConfig::from_env`).

`DexService` is built whenever its environment parses, and the defaults always parse.
There is no `DEX_ENABLED` variable. Wherever `EVM_SPONSOR_ENABLED=1` or
`SOLANA_RELAYER_ENABLED=1` is set, the merge immediately:

- opens `/dex/quote` and `/dex/route`;
- opens the public `/dex/tokens`, which starts CoinGecko, GeckoTerminal and GoPlus
  traffic;
- lets the relayers pay for swaps.

There is no way to turn swaps off without also turning off transfers.

**Fix.** Add `DEX_ENABLED` (off by default) to gate `dex_service`. Add
`DEX_SPONSOR_ENABLED` (off by default), checked in `check_calls` (`evm_sponsor.rs:996`)
and in `solana_sponsor`'s `quote_id` branch (`routes/gas.rs:222`). Document both in
`.env.example`.

### 3. Medium — A handful of sybils can stop quoting for everyone

**Status: Fixed.** `dex/pacer.rs`: every provider queue (KyberSwap, Jupiter, GoPlus, GeckoTerminal, DexScreener) reserves a slot and answers `Busy` at once when it is more than 5 s away; with Redis the slots are one schedule shared by all replicas (Lua on Redis time). `routes/dex.rs` `quotas`: 8 quotes per person per minute (was 12) inside the global 120, a 40/min slice for wallets without a linked Apple/Google sign-in, and per-provider ceilings (EVM 80, Solana 24). A failed universe build is remembered for 60 s and refreshes lock per chain. Tests: `dex::pacer::tests::a_full_queue_answers_busy_at_once_instead_of_waiting`, `tests/redis_application.rs` `dex_provider_pacing_is_one_schedule_across_replicas` (ignored; run against a local Redis), `routes::dex::tests::quote_budgets_leave_room_for_verified_people_and_each_provider`, `dex::tests::a_failed_universe_build_is_remembered_for_a_minute`.


`routes/dex.rs:85,95,105`; `dex/mod.rs:281-301` (`Pacer`), `:343-347,360`.

- `/dex/quote` allows 12 per person and 120 per minute in total. Ten sybil accounts use up
  the global 120, and every other user gets 429.
- Under the global limit, the per-process pacers still fall behind:
  - Each quote makes 2 Kyber calls at 350 ms each. A `/dex/route` makes up to 2 quotes,
    and its limit (6 per person, 120 in total) is separate.
  - Sustained traffic at the limits needs about 84–250 s of Kyber time per minute. The
    `tokio::Mutex` queue therefore grows without bound; queued waits have no timeout.
  - Keyless Jupiter (2.05 s per call) serves about 29 Solana quotes a minute in total.
    Three accounts at 12 a minute saturate it.
- With N replicas, each replica paces on its own, so the fleet sends N × 2.9 requests per
  second against Kyber's 3 per second for the shared client id. Kyber then answers 429,
  which surfaces as `Busy`.
- `universe()` holds one global `refreshing` mutex for all chains. A failed build is not
  cached, so each later call (including public `GET /dex/tokens`) rebuilds again, which
  takes 10–30 s.

**Fix.**
- Make the pacers fail fast: `tokio::time::timeout` around `wait()` of about 5 s,
  returning `Busy`.
- Lower the per-person quote limit (e.g. 4 a minute) and keep a separate small global
  bucket per provider, so Solana and EVM can't starve each other.
- Pace Kyber and Jupiter through Redis (a shared token bucket) across replicas.
- Cache a failed universe build for about 60 s, and use one refresh lock per chain.

### 4. Medium — Sybils can exhaust each chain's daily free-gas budget and push the relayers to their floors

**Status: Fixed.** Sponsored swaps need `DEX_SPONSOR_ENABLED` and pass `dex::PgGate`: a linked Apple or Google sign-in (`user_verified_identities`, the `SPONSOR_REQUIRE_VERIFIED_IDENTITY` signal, required here always) plus an account at least `DEX_SPONSOR_MIN_ACCOUNT_DAYS` (7) old or free gas settled more than a day ago. It is checked at quote time (else `unsponsoredReason: "verify"`) and again by both sponsors; an EVM quote issued unsponsored is never paid later. On Solana `check_swap` refuses any token account funded by the relayer; a sponsored order that would open one is re-quoted with the wallet paying (`unsponsoredReason: "new_token_account"`), and the app says so in plain words. Tests: `dex::tests::only_people_the_gate_lets_through_get_sponsored_swaps`, `dex::tests::honey_never_pays_a_new_token_accounts_rent_in_a_swap`, `dex::solana_sponsor_tests::honey_never_pays_rent_for_a_token_account_in_a_swap`, `tests/gas.rs` `dex_sponsorship_needs_a_verified_sign_in_and_an_older_account_or_history` (ignored; run against a local Postgres); mobile "says plainly why the wallet pays when Honey doesn’t".


`gas_allowance.rs:291-316`; defaults at `:39,53,59`; `evm_sponsor.rs:121,145`.

The ledger caps hold, but they are shared:

- Each EVM chain allows $0.50 a day in total and $0.10 per person per chain per day. Five
  sybils doing honest swaps, or swaps they make revert by moving the sell token away
  between simulation and inclusion, use up a chain's whole day.
- On Polygon, a full-gas revert at 1M gas can reserve the whole $0.05 per-transaction cap,
  so about 10 reverts end free gas there for everyone that day.
- On Solana, Honey pays rent (0.00204 SOL, about $0.16) for the taker's new output ATA
  (`solana_relayer.rs:860-869`). The taker owns that account and can sell, then
  `CloseAccount` it to themselves. The rent is a cash payout, not burned gas.
  - Each person gets one funded account per 30 days, and the Solana daily cap is $1. That
    allows about 6 cash-outs a day.
  - That is enough to take a relayer holding about 0.02 SOL to its 0.003 SOL floor in
    1–2 days.

None of this goes below the floor, so it is availability, not theft. But at today's
balances the attacker controls when free gas stops.

**Fix.**
- Before raising budgets, gate DEX sponsorship on an account signal that sybils can't get
  cheaply (wallet age or balance, or a first-swap-unsponsored rule).
- On Solana, don't fund output ATAs for swaps. Either quote with the taker as rent payer
  (`check_swap`: refuse funder index 0), or require that the ATA already exists.

### 5. Low — Kyber calldata check leaves `flags`, `srcReceivers` and `callTarget` open

**Status: Fixed.** `dex/evm.rs` `check_kyber_shape` (used by `kyber::check_build` and `check_quoted_calls`, mirrored on device): `flags` may only carry the observed 0x200; `srcReceivers`/`srcAmounts` same length, all receivers = `callTarget`, amounts sum to `amount`; `callTarget` on the executor allowlist (`chains::KYBER_EXECUTOR` 0x8f10…f996, seen on all four chains on 2026-11-13); no `approveTarget`, fees or permit. Tests: `dex::evm::tests::kyber_partial_fill_and_other_flags_are_refused`, `dex::evm::tests::kyber_source_receivers_must_be_the_allowlisted_executor`, `dex::kyber::tests::builds_with_partial_fill_or_a_stranger_executor_are_refused`; mobile "refuses the partial-fill flag and any flag outside the observed set".


`dex/evm.rs:91-112,214-224`; `dex/kyber.rs:149-160`.

The deployed router's `swap()` doesn't whitelist `callTarget`. Unlike `swapGeneric`, it
transfers `srcAmounts` to arbitrary `srcReceivers` (total ≤ `amount`).

With `_PARTIAL_FILL` (0x01) set, the router only checks
`returnAmount × amount ≥ minReturn × spent`. That is a ratio, not the absolute minimum the
sponsor's comment and the design doc promise.

The exact approve and the `minReturn` on `dstReceiver` still bound user loss to slippage
in the normal case. But a bad Kyber build, a compromised Kyber, or a future router
upgrade would not be caught by the "first principles" check. Today's live build uses
`flags = 0x200`, one receiver, and `srcReceivers == [callTarget]`.

**Fix.** In `decode_kyber_swap` and `check_quoted_calls`:
- refuse `flags & (0x01 | 0x02 | 0x04 | 0x100) != 0` (or pin `flags` to an observed
  allowlist);
- require `srcReceivers.len() == srcAmounts.len()`, `Σ srcAmounts == amount`, and every
  `srcReceiver == callTarget`;
- keep a small allowlist of Kyber executors per chain.

### 6. Low — Solana minimum is simulated, not read from the signed instruction

**Status: Fixed.** `dex/solana.rs` `decode_jupiter_route` / `check_jupiter_amounts` read `route`, `shared_accounts_route`, `route_v2` and `shared_accounts_route_v2` (the live one) and refuse every other Jupiter instruction: exactly one route, `in_amount` = the sell amount, `quoted_out × (1 − slippage_bps)` ≥ the quote's minimum, no platform or positive-slippage fee. Checked in `jupiter::check_order`, in `sponsor_swap` before simulating, and on the device. Tests: `dex::solana::tests::the_live_jupiter_route_instruction_decodes`, `dex::solana::tests::jupiter_routes_with_fees_or_looser_slippage_are_refused`, `dex::jupiter::tests::an_order_whose_instruction_takes_a_platform_fee_is_refused`, `dex::solana_sponsor_tests::the_signed_jupiter_amounts_must_match_the_quote`; mobile "refuses a Jupiter route with a platform or positive-slippage fee".


`dex/jupiter.rs:90-95`; `solana_relayer.rs:930-961`.

The server trusts Jupiter's JSON `otherAmountThreshold` and the simulation. The Jupiter
instruction's own `quoted_out_amount`, `slippage_bps` and `platform_fee_bps` (what the
program enforces) are never decoded. A price move between simulation and landing is
caught only by those instruction fields.

**Fix.** Decode the Jupiter v6 route instruction(s), then:
- require `in_amount == sellAmount`;
- require `quoted_out × (1 − slippage_bps) ≥ min_buy_amount`;
- require `platform_fee_bps == 0`.

Do the same on the device.

### 7. Low — Token safety inputs are stale or unverified

**Status: Fixed.** `upgradeable` now blocks unless the token is on `DEX_UPGRADEABLE_ALLOWLIST`; a quote re-asks GoPlus when its verdict is over an hour old (`Safety::check_fresh`); decimals are read on chain (`decimals()` / the SPL mint, cached) and must match the universe; Honey's own price-impact check always runs, against DexScreener prices at most a minute old (also used for the $ cap), and the worse of it and the provider's figure counts. Tests: `dex::tests::upgradeable_tokens_are_blocked_unless_allowlisted`, `dex::tests::goplus_verdicts_over_an_hour_old_are_asked_again_at_quote_time`, `dex::tests::decimals_are_read_on_chain_and_must_agree`, `dex::tests::honeys_own_impact_check_runs_on_fresh_prices_even_when_kyber_reports_usd`, `dex::safety::tests::scam_shapes_are_blocked`.


`dex/safety.rs:139-141,55`; `dex/universe.rs:169-178`; `dex/mod.rs:58,733-743,757-766`.

- Upgradeable proxies (`is_proxy`) pass. Verdicts are cached for 24 h per process. A token
  upgraded to a honeypot keeps passing for up to a day. The design's sell-back probe isn't
  implemented.
- Decimals come from GeckoTerminal and are never read on chain. Prices are up to 6 h old.
  Both feed:
  - the `$100` leg cap: a wrong `decimals` (18 instead of 6) shrinks the USD estimate
    10¹²×;
  - Honey's own price-impact check, used whenever Kyber gives no USD figures.
- Kyber's USD figures are trusted whenever they are present.

**Fix.**
- Block `upgradeable` unless the token is on a short reviewed allowlist.
- Re-check GoPlus at quote time when the verdict is older than about 1 h.
- Read `decimals()` on chain (or require Kyber's route summary to agree) when building
  the universe.
- Run Honey's impact check always, not only when Kyber's is missing.

### 8. Low — Failure paths: quote burnt early, reverts charged, and late landing

**Status: Fixed.** Both sponsors spend the quote only after the ledger reservation succeeds and release the reservation if the spend loses the race (`evm_sponsor.rs` `submit`, `solana_relayer.rs` `reserve_and_send`); the existing pre-submit failure paths already release. A quoted swap's batch deadline is at most the quote's expiry + 60 s (`batch_deadline`, enforced at prepare and submit). Sponsored quotes carry the warning "A failed swap still uses free gas", shown on the review. Tests: `evm_sponsor::tests::a_swap_over_the_allowance_keeps_its_quote`, `evm_sponsor::tests::a_quoted_swaps_batch_cant_outlive_its_quote`, `evm_sponsor::tests::a_quoted_swap_is_simulated_sent_and_spent_once` (replay releases its reservation), `dex::solana_sponsor_tests::a_swap_the_ledger_refuses_keeps_its_quote`; mobile "says a failed swap still uses free gas when Honey pays".


`evm_sponsor.rs:1434` (spend) before `:1442` (reserve), `:1300`, `:1604`;
`solana_relayer.rs:962`.

- The quote is spent before the ledger reservation. A user over their allowance burns the
  quote and gets 402. This is harmless, but confusing.
- An honest swap that reverts (the price moved past slippage) is charged to the user's
  allowance at its real cost. This is defensible, but should be stated in the app.
- Quote expiry (120 s) is enforced only at submit. Fee-bump rebids can land the signed
  batch up to the Calibur deadline (≤ 660 s). `minReturn` still holds, but "quote
  expiry" is not an execution bound.

**Fix.**
- Spend the quote after `reserve` succeeds, and release the reservation if the spend
  loses the race.
- Cap the batch deadline for quoted swaps at `quote.expires_at + 60`.
- Show "a failed swap still uses free gas" in the review.

## Not findings (checked and dropped)

- **The relayer key reached through an ALT, CPI, or a durable nonce.** The runtime
  rejects an account loaded twice. Without the relayer's account in the instruction
  there is no signer to CPI with. The System program is refused.
- **Simulation-detecting tokens or hooks** (basefee 0 in `eth_simulateV1`). These can
  only make the swap revert (bounded gas, charged) or underpay, which Kyber's `minReturn`
  catches on chain. Attacker tokens can't enter the universe (top-250 volume on
  CoinGecko, plus floors).
- **GoPlus exhaustion.** Calls are limited to universe tokens and cached for 24 h.
- **GoPlus poisoning.** One address per query, matched by key.
- **Unbounded quote store.** The pacers keep it below 200 live quotes per process.
- **`sponsored` flag ignored on EVM.** It only affects the gas hint. A quote's calls are
  the same either way.
