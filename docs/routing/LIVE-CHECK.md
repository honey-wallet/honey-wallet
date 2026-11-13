# DEX routing: live check, 2026-11-13

Read-only calls against the real providers: no key, no signature, nothing sent. The
server's own code produced the quotes below (`cargo test -p honey-server --lib
dex::tests::live_quotes -- --ignored --nocapture`); the EVM simulation was run by hand with
`cast` and `curl`. Taker on Base: `0x2c7536E3605D9C16a7a3D7b1898e529396a65c23` (the
keyring's unfunded test key). Taker on Solana: `9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM`.

## Provider terms (checked today)

| Provider | Key | Free terms | Status today |
|---|---|---|---|
| KyberSwap Aggregator API | none (`x-client-id: honey`) | 3 requests/s public; keys only via business@kyber.network | works on Base, Arbitrum, Polygon, Ethereum |
| Jupiter Swap V2 (`api.jup.ag/swap/v2/order`) | none; optional free portal key `JUPITER_API_KEY` | keyless 0.5 req/s, free key 1 req/s (developers.jup.ag/docs/portal/rate-limits) | works keyless, with `payer` |
| Jupiter Tokens V2 (`/tokens/v2/tag?query=verified`) | none | same limits | 4,077 verified tokens |
| GoPlus token security | none | free plan 150 CU/min, 30k CU/day, no batch calls (gopluslabs.io/security-api) | works; answered `code 4029 too many requests` after 3 quick calls, so calls are paced at 2.5 s and cached for 24 h |
| CoinGecko, GeckoTerminal, DexScreener | none (`COINGECKO_API_KEY` optional, already supported) | GeckoTerminal 30/min, DexScreener 300/min | work |
| Odos | none | n/a | **shut down on 2026-07-30** (api.odos.xyz answers Cloudflare 1033, docs 530). Not wired. |
| Uniswap Trading API | free key | free, 6 RPS | not wired: no key in the repo, and its calldata needs Permit2 or `x-permit2-disabled`; Kyber already routes Uniswap pools |
| 0x | key | free tier unclear (see MORE-TOKENS.md) | not used |

## Router and program addresses seen

- KyberSwap `routerAddress` was `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` on all four EVM
  chains (Base, Arbitrum, Polygon, Ethereum). The same address is in Kyber's docs (Aggregator
  Contract Addresses). It is the only EVM router on the allowlist.
- Every Jupiter Metis transaction calls `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
  (Jupiter v6), with Compute Budget at the top level and nothing else.

## Quotes

| Swap | Aggregator | Sell | Buy (quoted) | Min buy (1%) | Impact | Calls / tx |
|---|---|---|---|---|---|---|
| Buy: 10 USDC → AERO, Base | kyberswap | 10.000000 USDC ($10.00) | 21.1485 AERO | 20.9370 AERO | 0.07% | approve (68 B) + `swap` 0xe21fd0e9 (2,820 B) |
| Sell: 10 AERO → USDC, Base | kyberswap | 10 AERO ($4.78) | 4.728665 USDC | 4.681378 USDC | 0% | approve (68 B) + `swap` (3,780 B) |
| Buy: 10 USDC → JUP, Solana | jupiter | 10.000000 USDC ($10.00) | 38.196951 JUP | 37.814981 JUP | 0.0065% | v0 tx, fee payer = stand-in payer, `sponsored: true` |
| Sell: 20 JUP → USDC, Solana | jupiter | 20 JUP ($5.23) | 5.231536 USDC | 5.179220 USDC | 0% | v0 tx, `sponsored: true` |

- KyberSwap's `amountInUsd`/`amountOutUsd` were `"0"` on most calls today, so the server
  measures price impact against its own prices (GeckoTerminal/CoinGecko, USDC = $1) when
  the provider gives none.
- The Kyber calldata decoded to exactly the request: srcToken, dstToken, `dstReceiver` = the
  taker, `amount` = the sell amount, `minReturnAmount` = amountOut × 0.99, no fee receivers,
  no permit.
- A Solana quote built with `payer` passed the relayer's swap policy
  (`dex::solana::check_swap`): two signers (payer, taker), Compute Budget + Jupiter only, the
  payer in no instruction. Network fee 10,432 and 11,386 lamports, no rent.
- Quote latency: 1.3–6 s on EVM (two Kyber calls, plus the token list and one GoPlus check
  the first time), 2–5 s on Solana.

## EVM simulation (eth_simulateV1, Base public RPC)

The 10 USDC → AERO batch, run from the taker with its USDC balance overridden to 50 USDC:

| Call | Status | Gas | Result |
|---|---|---|---|
| USDC.balanceOf | ok | 31,182 | 50,000,000 |
| AERO.balanceOf | ok | 23,995 | 0 |
| USDC.approve(router, 10,000,000) | ok | 55,437 | true |
| Kyber `swap` | ok | 242,168 | |
| USDC.balanceOf | ok | | 40,000,000 (exactly 10 USDC spent) |
| AERO.balanceOf | ok | | 21.1388 AERO (≥ minimum) |

`eth_simulateV1` with state overrides answered on all default RPCs: mainnet.base.org,
arb1.arbitrum.io, polygon-bor-rpc.publicnode.com and ethereum-rpc.publicnode.com.

## Token universe (first build)

- Base: 49 candidates from CoinGecko's top 250 by volume with a Base contract. 2 were `ok`
  at first, because GoPlus verdicts fill in at one every 2.5 s in the background. Flags seen:
  `owner_can_mint` (VVV), `owner_can_change_balance` and `hidden_owner` (VIRTUAL), `too_new`
  (MORPHO on Base), `low_volume`. Two tokens use the symbol AERO (`0x940181…` and
  `0x3f5bf3…`), so callers must key on the address, never the symbol.
- Solana: 500 kept of Jupiter's 4,077 verified (liquidity ≥ $10k, capped by liquidity).
  Liquid-staking tokens (JitoSOL, mSOL, …) carry `owner_can_mint` because their mint
  authority is the stake pool. That is strict but deliberate for now.
