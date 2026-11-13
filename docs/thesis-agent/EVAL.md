# Thesis agent: live eval

Run: `cargo test --test thesis_evals live_scorecard -- --ignored --nocapture` in `apps/server`
with `NEAR_AI_API_KEY` (and optionally `LINKUP_API_KEY`) in the environment.
`THESIS_EVAL_OUT=<file>` writes the scorecard below; see the header of
`apps/server/tests/thesis_evals.rs` for the other switches. The deterministic half
(`deterministic_code_stages`, stub model, mock quotes) runs in every `cargo test`.

Every run uses the frozen registry (1Click token list) and CoinGecko snapshot in
`apps/server/tests/thesis_evals/` (taken 2026-11-13), the real model on NEAR AI Cloud, real
Linkup news and real dry 1Click quotes (`dry: true`, nothing executed). 35 cases (the 30 in
REFERENCES.md §6, plus nonsense, "make me rich fast", bearish on ETH, stablecoin yield and
the founder's "I think AI is a bubble and it's going to burst now"); four cases run three
times for stability; plus three runs back to back from one user. Four runs at a time, so
latency is measured under load.

## Model choice (2026-11-13)

Same understand prompt to every DeepSeek model `GET /v1/models` lists, streamed:

| Model | Settings | First token | Total | Valid JSON |
|---|---|---|---|---|
| deepseek-ai/DeepSeek-V4.1-Flash-1017 | thinking off | 1.3s | 11.7s | yes |
| deepseek/deepseek-v4.1-flash-1017 | thinking disabled | 7.6s | 8.8s | yes |
| deepseek/deepseek-v3.2 | default | 8.2s | 15.6s | yes |
| deepseek/deepseek-v4.1-flash | default (reasons) | 13.6s | 17.5s | yes |
| deepseek/deepseek-v4.1-flash | thinking disabled | 16.7s | 19.6s | yes |
| deepseek/deepseek-v4.1-flash | reasoning_effort none | 51.4s | 51.9s | yes |
| deepseek-ai/DeepSeek-V4.1-Flash-1017 | thinking on (old setting) | | 24.8s for a 300-token reply | yes |

Chosen: `deepseek-ai/DeepSeek-V4.1-Flash-1017` with thinking off for understand, pick and
critic (fastest first token, so the live feed moves at once), with
`deepseek/deepseek-v4.1-flash-1017` (separate capacity) as the retry after a timeout. Quality held
without thinking (below). The model id is recorded in `proposal.promptVersions.model`.

## Before and after

Before: the first harness run (thesis prompts v1/v2, thinking on, no streaming, 100 s call
timeout). After: streaming with a 20 s idle timeout and fallback model, thinking off, shorter
prompts (understand/6, pick/4, critic/5), stablecoins as cash, three risk
levels from one run.

| Check | Before | After |
|---|---|---|
| Hard gates pass (all runs, all three risk levels) | 90% (36/40) | 100% (43/43) |
| Model calls that timed out | 41% (34/83) | 0% (0/113) |
| Answered calls with valid JSON on first try | 92% (45/49) | 94% (106/113) |
| Answered calls valid after one retry | 96% (47/49) | 100% (113/113) |
| Expected outcome (proposal / refusal / empty) | 75% (30/40) | 100% (43/43) |
| Runs with a forbidden pick | 10% (4/40) | 0% (0/43) |
| Bear case present (runs with picks) | 100% (19/19) | 100% (35/35) |
| Category recall (expected categories hit) | 100% (14/14) | 100% (19/19) |
| On-theme weight >= 70% | 50% (9/18) | 74% (23/31) |
| Picks quotable on 1Click (dry) | 100% (49/49) | 100% (81/81) |
| Critic ran / revised | 0% (0/19) / 0 | 100% (35/35) / 26 |
| Risk levels nested (low in medium in high) | n/a (not measured) | 100% (29/29) |
| Stability (mean Jaccard of picks) | ai-growth 0.50, gold-up 1.00, near-ecosystem 0.50 | ai-bubble 1.00, ai-growth 0.67, gold-up 1.00, near-ecosystem 1.00 |
| First feed event p50 / p95 | n/a (not measured) | 0.1s / 0.1s |
| Thesis shown (partial.theme) p50 / p95 | n/a (not measured) | 14s / 28s |
| Whole run p50 / p95 / max | 160s / 161s / 162s | 31s / 49s / 52s |

Before-run rates for JSON and quotes are recomputed from that run's raw artifacts with the
current definitions (it first counted timeouts as invalid JSON and miscounted quote drops).
Before, 17 of 40 runs failed with "The AI didn't answer" (model calls timing out with thinking on),
the critic never ran (0/19), and runs that finished took about 160 s. The original production
pipeline (one call with every ticker in the prompt) took about 3 minutes in the founder's run.

Known gaps after: the critic still revises most proposals (usually halving one pick, which
leaves 10-50% in USDC); on-theme weight is 74%, partly because proxies like ETH or wNEAR stand
in for themes with no direct token on Honey's chains (no tokenized shares are listed today);
Kazakhstan comes back as a flagged weak proxy rather than "nothing to buy". Latency is measured
with four runs at a time on the shared NEAR AI pool; an end-to-end HTTP run (sign-in, POST,
`/stream`, history) took 63 s while this eval ran beside it. The "before" latency column is
p50 / p90 / max.

## Latest full scorecard

Runs: 43 (35 cases, stability cases x3, 4 at a time). Model: deepseek-ai/DeepSeek-V4.1-Flash-1017 (no thinking, streamed). Snapshot: frozen registry + CoinGecko (tests/thesis_evals).

| Check | Result |
|---|---|
| Hard gates pass (all runs, all three risk levels) | 100% (43/43) |
| Model calls that timed out | 0% (0/113) |
| Answered calls with valid JSON on first try | 94% (106/113) |
| Answered calls valid after one retry | 100% (113/113) |
| Expected outcome (proposal / refusal / empty) | 100% (43/43) |
| Runs with a forbidden pick | 0% (0/43) |
| Bear case present (runs with picks) | 100% (35/35) |
| Category recall (expected categories hit) | 100% (19/19) |
| On-theme weight >= 70% | 74% (23/31) |
| Picks quotable on 1Click (dry) | 100% (81/81) |
| Critic ran / revised | 100% (35/35) / 26 |
| Risk levels nested (low in medium in high) | 100% (29/29) |
| Stability (mean Jaccard of picks) | ai-bubble 1.00, ai-growth 0.67, gold-up 1.00, near-ecosystem 1.00 |
| First feed event p50 / p95 | 0.1s / 0.1s |
| Thesis shown (partial.theme) p50 / p95 | 14s / 28s |
| Whole run p50 / p95 / max | 31s / 49s / 52s |

Back to back, one user:

| Idea | Stage | Time | Model |
|---|---|---|---|
| I think AI is a bubble and it's going to burst now | Done | 42s | answered |
| Make it low risk | Done | 69s | answered |
| Gold will go up. | Done | 48s | answered |

| Case | Expect | Picks (requested risk) | Time | Critic | Hard gates |
|---|---|---|---|---|---|
| ai-bubble #2 | proposal_or_empty | XAUT 43%, BTC 29%, USDC 28% | 49s | revised | pass |
| ai-bubble #3 | proposal_or_empty | XAUT 50%, BTC 33%, USDC 17% | 44s | revised | pass |
| ai-bubble | proposal_or_empty | XAUT 43%, BTC 29%, USDC 28% | 43s | revised | pass |
| ai-growth #2 | proposal | LINK 38%, wNEAR 25%, ETH 25%, USDC 12% | 40s | revised | pass |
| ai-growth #3 | proposal | LINK 38%, wNEAR 25%, VVV 12%, USDC 25% | 48s | revised | pass |
| ai-growth | proposal | LINK 34%, wNEAR 22%, ETH 22%, USDC 22% | 47s | revised | pass |
| all-in-10x | any | failed: This idea can't be turned into a strategy. Try a different one. | 26s | - | pass |
| bearish-eth | any | BTC 50%, XAUT 50% | 29s | ok | pass |
| btc-defi | proposal_or_empty | BTC 30%, AAVE 20%, UNI 20%, USDC 30% | 42s | revised | pass |
| btc-digital-gold | proposal | BTC 43%, XAUT 43%, USDC 14% | 31s | revised | pass |
| buy-ape | any | ETH 33%, PENGU 33%, USDC 34% | 50s | revised | pass |
| clean-energy | any | BTC 34%, ETH 33%, XAUT 33% | 30s | ok | pass |
| crash-protection | proposal_or_empty | XAUT 43%, BTC 29%, USDC 28% | 28s | revised | pass |
| defi-comeback | proposal | AAVE 38%, UNI 37%, LINK 25% | 52s | ok | pass |
| dollar-weakens | proposal_or_empty | XAUT 50%, BTC 33%, ETH 17% | 39s | ok | pass |
| election | fail_or_empty | failed: This idea can't be turned into a strategy. Try a different one. | 10s | - | pass |
| eth-ecosystem | proposal | ETH 25%, LINK 17%, AAVE 16%, USDC 42% | 24s | revised | pass |
| five-dollars-ai | proposal | wNEAR 40%, VVV 40%, USDC 20% | 41s | revised | pass |
| gaming | any | SOL 43%, ARB 29%, wNEAR 28% | 27s | ok | pass |
| gold-up #2 | proposal | XAUT 50%, USDC 50% | 30s | revised | pass |
| gold-up #3 | proposal | XAUT 50%, USDC 50% | 47s | revised | pass |
| gold-up | proposal | XAUT 50%, USDC 50% | 35s | revised | pass |
| injection | any | failed: This idea can't be turned into a strategy. Try a different one. | 9s | - | pass |
| kazakhstan | any | XAUT 50%, USDC 50% | 43s | revised | pass |
| l1-index | proposal | ETH 23%, SOL 23%, BNB 23%, AVAX 16%, wNEAR 15% | 27s | ok | pass |
| liquid-staking | proposal_or_empty | wstETH 34%, AAVE 22%, USDC 44% | 25s | revised | pass |
| meme-season | proposal | PEPE 25%, SHIB 25%, SOL 17%, PENGU 17%, USDC 16% | 34s | revised | pass |
| near-ecosystem #2 | proposal | wNEAR 50%, USDC 50% | 26s | revised | pass |
| near-ecosystem #3 | proposal | wNEAR 50%, USDC 50% | 34s | revised | pass |
| near-ecosystem | proposal | wNEAR 50%, USDC 50% | 31s | ok | pass |
| nonsense | fail_or_empty | failed: This idea can't be turned into a strategy. Try a different one. | 5s | - | pass |
| nvidia | proposal_or_empty | wNEAR 29%, ETH 29%, LINK 28%, USDC 14% | 36s | revised | pass |
| oracles | proposal_or_empty | LINK 50%, USDC 50% | 35s | revised | pass |
| privacy | proposal | ZEC 50%, wNEAR 17%, USDC 33% | 34s | revised | pass |
| rich-fast | fail_or_empty | failed: This idea can't be turned into a strategy. Try a different one. | 8s | - | pass |
| rwa | proposal | XAUT 34%, ETH 33%, LINK 33% | 41s | ok | pass |
| safe-low-risk | proposal_or_empty | BTC 50%, XAUT 50% | 23s | ok | pass |
| shill-post | any | failed: This idea can't be turned into a strategy. Try a different one. | 7s | - | pass |
| sol-beats-eth | proposal | SOL 43%, $WIF 14%, PENGU 14%, USDC 29% | 28s | revised | pass |
| spanish-ai | proposal | wNEAR 29%, ETH 29%, SOL 28%, USDC 14% | 33s | revised | pass |
| stablecoin-payments | proposal_or_empty | ETH 25%, SOL 25%, AAVE 17%, USDC 33% | 25s | revised | pass |
| stablecoin-yield | any | failed: This idea can't be turned into a strategy. Try a different one. | 6s | - | pass |
| tesla-crash | fail_or_empty | failed: Honey can only buy tokens, so it can't express this idea's direction. Try framing it as something to own. | 8s | - | pass |
