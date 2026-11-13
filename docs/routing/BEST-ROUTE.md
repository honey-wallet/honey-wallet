# Route planner: NEAR Intents first, a DEX only when it can't

Status: built in the `feat/dex-routing` worktree, 2026-11-14 (uncommitted). Server:
`apps/server/src/route_planner.rs`, `routes/best_route.rs`, `dex/canonical.rs`. App:
`apps/mobile/src/lib/best-route.ts`, the Swap screen (`components/trade/IntentsSwap.tsx`),
jar buys (`lib/jar-buy.ts`, `app/(jars)/thesis-new.tsx`), Settings → Swaps
(`app/(trade)/swap-settings.tsx`). Types: `packages/api-client` (`BestRoute*`).

## The rule (founder, 2026-11-13): privacy first

NEAR Intents 1Click is the route for every swap and jar leg, because it pays through
one-time deposit addresses. A DEX route (KyberSwap or Jupiter on one chain, or 1Click
plus a DEX) is used **only when 1Click can't do the trade**:

| | Reason (`fallback`) | When |
|---|---|---|
| (a) | `not_listed` | 1Click doesn't list one of the tokens |
| (b) | `amount` | 1Click refuses the amount ("Amount is too low…", a minimum) |
| (c) | `fees` | 1Click's guaranteed output is worth less than half the input (the app's `MIN_VALUE_KEPT`, Swap's "too small" floor) |
| (d) | `failed` | 1Click's quote fails or times out, after one retry |

A DEX that is merely cheaper is **not** used. Every candidate is still quoted and
returned (`alternatives`, `dropped`) and logged (`best route` log line with each
candidate's net value), so the price gap is visible: see the live results below.

**Private routes only** (Settings → Swaps, off by default; `privateOnly` on the request):
never fall back; 1Click's own error is shown.

**`DEX_ENABLED` off**: only 1Click is quoted.

## Endpoint

`POST /api/v1/routes/best` (signed in; 20 per person per minute inside 240 shared, 80
shared by wallets with no linked Apple or Google sign-in).

```
{ fromChain, fromToken, amount, toChain?, toToken, taker,
  fromAddress?, slippageBps?, privateOnly?, wrapped? }
```

- Tokens: an address (mint on Solana), `native`, or a 1Click asset id (then `toChain`
  can be omitted: BTC on Bitcoin).
- `wrapped` (jars): may buy the pick's canonical wrapped version on the paying chain.
- Answer: `best` (kind, label, legs each with `kind: intents | dex`, min out, `minOutUsd`,
  `gasUsd`, `sponsored`, `netUsd`, `seconds`, `holdAs`, and `dexQuote`: the stored,
  executable quote of a one-swap DEX route), `fallback` + `fallbackText` when a DEX is
  used, `alternatives` (every other route that quoted, best first), `dropped` (with
  reasons), `amountInUsd`.

## Candidates

1. `intents`: 1Click direct, a **dry** quote (no deposit address).
2. `dex`: one swap, both tokens on one chain and DEX-safe.
3. `wrapped` (jars): one swap on the paying chain into the pick's canonical version
   there, from a curated map (`dex/canonical.rs`, mirrored in `lib/best-route.ts`):
   cbBTC on Base, WBTC on Arbitrum/Ethereum/Polygon, WETH on all four. Each address was
   read on chain (`symbol()`, `decimals()`) on 2026-11-13. Never guessed; no canonical
   SOL exists on the EVM chains, so SOL is never bought wrapped. Valued at the family's
   price (1 WBTC = 1 BTC). The Review says "BTC (as WBTC on Arbitrum)".
4. `intents_dex`: 1Click to USDC on the target chain, then the DEX (a token 1Click
   doesn't list, across chains).
5. `dex_intents`: the DEX into USDC on the paying chain, then 1Click (selling a DEX-only
   token across chains).

Every provider call has a 2.5 s budget (`LEG_TIMEOUT`); a slow provider drops out with
"timed out". DEX tokens are warmed in the background (universe, GoPlus, decimals,
price), so a dropped cold candidate is warm next time. A token 1Click lists on a DEX
chain can now be traded on the DEX too (it still passes GoPlus, on-chain decimals and a
fresh price); before, only the volume-ranked universe could.

## Ranking (among fallbacks)

- **Net USD** = minimum received (worst case within slippage) × the output's price, less
  the gas the person pays: none where Honey sponsors it for them (the DEX quote's
  `sponsored`; for a 1Click deposit, free gas on that chain with allowance left), else an
  estimate in native gas: deposit 65k gas (21k native), swap 300k gas, at `eth_gasPrice`
  (cached 60 s); Solana 10k lamports per signature plus 0.00204 SOL rent for a new token
  account (an SPL deposit into a fresh 1Click address, or a swap into a token not held).
- 1Click's fees (withdrawal fee, spread, app fee) are already inside its `minAmountOut`.
- Within 1 bp (at least $0.0005) of the top: **fewer legs**, then **faster**.

## App

- **Swap**: same-chain pairs on a DEX chain, and DEX tokens, ask the planner. NEAR Intents
  → the existing 1Click pay flow. A DEX → its quote is checked on device
  (`checkDexQuote`; a wrapped token must be on the device's own curated map) and runs the
  existing DEX → sponsored batch flow. The Review shows the route plus one line why, e.g.
  "NEAR Intents can't do this amount, so this uses KyberSwap on Arbitrum. Swaps here are
  public on-chain." There is no "Best of N routes" line under this policy.
- **Jars**: each NEAR Intents leg asks the planner (`wrapped: true`). A leg 1Click can't
  do is bought where the money is (a same-chain DEX swap on the paying chain, its USDC
  already set aside), labelled "BTC (as WBTC on Arbitrum)" with the why line. USDC on
  Arbitrum and Polygon now pays 1Click legs too (`PAY_CHAINS`; Polygon's 1Click USDC is
  `nep141:pol-0x3c49…omdep.near`, from `/v0/tokens`). Two-leg DEX picks keep the existing
  Finish / Move back recovery (lib/jar-dex).
- **Visible errors**: every leg that can't be quoted or paid shows one plain line on the
  jar screen (`JarBuyError.legs`: the planner's refusal, the 1Click group quote, the DEX
  quote, the value floor, the swap or the deposit). Each quoting step has a 20 s limit,
  and the button says what is happening ("Getting quotes…", "Confirm to pay…", "Paying 2
  of 3…"), so a buy can't stop silently after "Paying…".

## Live check, 2026-11-14 (read-only)

Dry 1Click quotes and DEX quotes only; nothing signed or sent. No partner key
(`NEAR_INTENTS_API_KEY` unset: 1Click adds 0.2%), no Postgres (no free gas), so every
route pays its own gas. Command:
`cargo test -p honey-server --lib route_planner::tests::live_best_routes -- --ignored --nocapture`
(a warm-up pass with a 60 s budget, then the measured pass at 2.5 s per call). Taker
`0x2c75…5c23` / `9WzD…AWWM`.

| Trade | Candidate | Min out | Min out $ | Gas $ | Net $ | ~s | |
|---|---|---|---|---|---|---|---|
| 10 USDC → USDT, Arbitrum | NEAR Intents | 9.8997 USDT | 9.8911 | 0.0025 | **9.8885** | 24 | **chosen** |
| | KyberSwap on Arbitrum | — | | | | | dropped: USDT0 is `upgradeable` (GoPlus); allow it with `DEX_UPGRADEABLE_ALLOWLIST` |
| 10 USDC → AERO, Base | KyberSwap on Base | 20.5072 AERO | 9.9645 | 0.0035 | **9.9609** | 5 | **chosen**, (a) not listed |
| 10 USDC (Arbitrum) → USDT (Ethereum) | NEAR Intents | 9.6070 USDT | 9.6003 | 0.0025 | **9.5977** | 34 | **chosen** (only candidate: both listed, cross-chain) |
| 10 USDC → JUP, Solana | Jupiter on Solana | 37.5971 JUP | 9.9105 | 0.0016 | **9.9089** | 5 | **chosen**, (a) not listed |

Planner time on the measured pass: 0.2–1.5 s.

### The founder's jar: $0.50 of USDC on Arbitrum, BTC / ETH / SOL

| Leg | Candidate | Min out | Min out $ | Gas $ | Net $ | |
|---|---|---|---|---|---|---|
| BTC $0.1667 | NEAR Intents | — | | | | refused: "Amount is too low for bridge, try at least 6.22 USDC" (b) |
| | KyberSwap on Arbitrum (as WBTC) | — | | | | dropped: refused by Honey's Kyber check (below) |
| | | | | | | **no route**: the jar shows "BTC: NEAR Intents needs at least 6.22 USDC for this, and no DEX route could take it." |
| ETH $0.1667 | NEAR Intents | 0.0000497 ETH | 0.0969 | 0.0025 | **0.0944** | **chosen**: keeps 58% (≥ 50%), so no fallback |
| | KyberSwap on Arbitrum (as WETH) | 0.0000854 WETH | 0.1664 | 0.0117 | 0.1547 | alternative (64% more, not taken: privacy first) |
| SOL $0.1666 | NEAR Intents | 0.00193 SOL | 0.1547 | 0.0025 | **0.1521** | **chosen** (no canonical SOL on Arbitrum) |

**The minimum, as a number.** That no-route 400 keeps the usual
`{ "error": { "code": "bad_request", "message": … } }` and adds `minAmountIn`: 1Click's least,
in atomic units of the token paid (`"6220000"`), whenever 1Click named one
(`route_planner::minimum_refusal`). The launch screen asks each leg at its share before
Buy and shows "Add at least $X" from it (apps/mobile `lib/jar-minimum.ts`), never reading
the sentence.

**Why the WBTC leg is refused.** For $0.17 KyberSwap routes USDC→WBTC through one pool
and builds `srcReceivers = [pool 0x599b…4c55]` (decoded with `cast`), not its executor
`0x8f10…f996`. Audit finding 5's fix (`dex/evm.rs` `check_kyber_shape`, mirrored on
device) requires every `srcReceiver` to be the allowlisted executor and fails closed, so
the quote is refused (`Busy`). User funds would still be bounded on chain by
`minReturnAmount` on the taker's balance, but loosening an audit fix needs its own
review: either allow a `srcReceiver` that is the first pool of the executor's decoded
route, or add a second quote source (Uniswap Trading API) for single-pool routes. Until
then a BTC leg below 1Click's ~$6 minimum can't be bought on Arbitrum; Base's cbBTC may
route differently (not checked live).

**What the founder saw.** With this worktree before today, Arbitrum USDC wasn't a jar
paying chain and 1Click errors surfaced only as a toast that the sheet could hide. Now:
Arbitrum pays, each leg's reason stays on the jar screen, and a $0.17 BTC leg says it
needs $6.22 on NEAR Intents.

## Tests

- Server (`route_planner::tests`, 13 + 1 live, ignored): NEAR Intents chosen when the DEX
  is cheaper; fallback on (a) not listed, (b) amount, (c) fees, (d) failure and timeout
  with one retry (and a retry that answers keeps NEAR Intents); private routes only
  blocks the fallback and returns 1Click's error; DEX flag off quotes only 1Click; a slow
  candidate drops out without being waited for; a cheaper stable→stable DEX is logged
  but only used once 1Click fails; ranking by min out less paid gas, sponsored vs not;
  ties to fewer legs then faster; 1Click's minimum in plain units. Plus
  `routes::best_route` (sign-in, budgets), `dex::canonical`, and `jar_buys`'s dry quote
  against the live fixture.
- App: `tests/best-route.test.ts` (7: intents as is; WBTC on Arbitrum with its line and
  checked quote; a non-curated wrapped token refused; a swap paying someone else refused;
  a token 1Click doesn't list; the toggle; 1Click's refusal shown) and
  `tests/jar-best-route.test.ts` (5: Arbitrum/Polygon pay; wrapped legs bought where the
  money is; a leg nothing can buy says why; a failed 1Click quote names each leg; an
  unreachable planner leaves legs on 1Click). api-client: the request's fields.

## Open

1. The Kyber single-pool `srcReceiver` (above): decide before small BTC legs can work.
2. USDT0 on Arbitrum is a proxy; add it to `DEX_UPGRADEABLE_ALLOWLIST` if stable→stable
   fallbacks there are wanted.
3. Set `NEAR_INTENTS_API_KEY` in production (0.2% less on every 1Click leg), and with
   `DEX_SPONSOR_ENABLED` the DEX gas above is $0 for eligible people.
4. An unsponsored DEX fallback on an EVM chain needs ETH for gas; a wallet holding only
   USDC there gets the swap's own "not enough ETH" error on that leg.
