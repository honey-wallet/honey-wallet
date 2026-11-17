# Honey at NEAR HACKATHON

Honey is a mobile wallet for investing with friends. You build a jar (a basket of tokens),
post it, let friends copy it and earn a cut of their profit, or buy one together from a
shared treasury held by a Sputnik DAO on NEAR. Every swap goes through NEAR Intents first.

This file is the submission write-up. Product overview and setup: [README.md](README.md).
The organizers' rules live at [nearhackathon.com/HACKATHON.md](https://nearhackathon.com/HACKATHON.md).

| | |
| --- | --- |
| Event | [NEAR HACKATHON](https://nearhackathon.com), 1 to 14 Nov 2026 (code from the 19 Oct announcement counts, rule Q-001) |
| Team | Beekeepers (3 people), led by Abhishek Yadav |
| Tracks | Social Money (`social`), Unstoppable DeFi (`defi`) |
| Repository | [github.com/honey-wallet/honey-wallet](https://github.com/honey-wallet/honey-wallet) |
| App | iPhone and Android coming soon (the TestFlight beta is waiting for Apple's review); waitlist at [honeywallet.org](https://honeywallet.org). Run it locally: [README](README.md#run-it-locally). |
| Website and deck | [honeywallet.org](https://honeywallet.org), [honeywallet.org/deck](https://honeywallet.org/deck) |
| API | [api.honeywallet.org](https://api.honeywallet.org/health) |
| Demo post on X | [x.com/0xabhii/status/2121714135209820197](https://x.com/0xabhii/status/2121714135209820197) |
| Demo video | [youtu.be/T4bECnY5kW0](https://youtu.be/T4bECnY5kW0) (also on the X post). Screen recording on a phone: [YouTube Shorts](https://www.youtube.com/shorts/gY5JyJx0dT4) |
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
| Trading through NEAR Intents | Every swap, jar buy and jar sell is quoted on 1Click first. A DEX is used only when 1Click doesn't list a token, refuses the amount, fails after a retry, or keeps under 90% of the value while a DEX nets at least 2% more. "Private routes only" turns DEX routes off. | [route_planner.rs](apps/server/src/route_planner.rs), [BEST-ROUTE.md](docs/routing/BEST-ROUTE.md) |
| Cross-chain baskets | A jar's picks can sit on different chains; one approval pays every 1Click deposit. | [jar_buys.rs](apps/server/src/jar_buys.rs), [jar-buy.ts](apps/mobile/src/lib/jar-buy.ts) |
| No custodian | Keys stay on the phone. Deposits go from the wallet to 1Click; unfilled swaps refund to the user's address. | [packages/keyring](packages/keyring), [intents-swap.ts](apps/mobile/src/lib/intents-swap.ts) |
| Trading agent | The thesis agent on NEAR AI Cloud turns an idea into a jar and dry-quotes every pick on 1Click before proposing it. | [thesis/](apps/server/src/thesis), [EVAL.md](docs/thesis-agent/EVAL.md) |
| The same coin on a cheaper chain | When 1Click would keep under 90% of a small leg (for example a payout on Ethereum), a jar leg can be bought as the same coin on Arbitrum, Base, Optimism or Polygon: 1Click carries the USDC there, then a DEX buys it. The coin must be the same CoinGecko coin, in a pool of at least $100k, priced within 2% of 1Click's price; the phone checks CoinGecko itself and values the leg at the lower price. | [route_planner.rs](apps/server/src/route_planner.rs), [same-coin.ts](apps/mobile/src/lib/same-coin.ts), [app-price.ts](apps/mobile/src/lib/app-price.ts) |

Not used: Chain Signatures.

## What was built during the hackathon

- The NEAR HACKATHON announcement was posted on 19 Oct 2026. Rule Q-001 counts code from
  then; earlier work is baseline.
- This repository's first commit, [`f20e914`](https://github.com/honey-wallet/honey-wallet/commit/f20e914)
  (20 Oct 2026), imports Honey's existing EVM wallet: keyring, server, savings and sign-in.
  We treat it as the baseline (rules Q-002, Q-004). It contains no NEAR Intents, Sputnik
  DAO or NEAR AI code: `git grep -il '1click\|sputnik\|near ai' f20e914` finds nothing.
- After it (UTC): 5 commits from 20 to 22 Oct, 2 on 7 Nov, then 396 from 8 to 14 Nov; the last at 21:48 on 14 Nov.
- Full diff: [f20e914...hackathon-submission](https://github.com/honey-wallet/honey-wallet/compare/f20e914...hackathon-submission) (rule Q-003). An earlier version linked a `pre-hackathon` tag; that tag was wrong and has been removed.

| Date | Commit | What landed |
| --- | --- | --- |
| 20 Oct | [`cbaecaa`](https://github.com/honey-wallet/honey-wallet/commit/cbaecaa) | Native NEAR accounts in the keyring; test mode |
| 8 Nov | [`a88b684`](https://github.com/honey-wallet/honey-wallet/commit/a88b684) | Thesis jars: the agent on NEAR AI Cloud |
| 8 Nov | [`af04547`](https://github.com/honey-wallet/honey-wallet/commit/af04547) | Real jar buys through NEAR Intents 1Click |
| 9 Nov | [`eb0350e`](https://github.com/honey-wallet/honey-wallet/commit/eb0350e) | Shared jars on NEAR as Sputnik DAOs |
| 10 Nov | [`c5007d1`](https://github.com/honey-wallet/honey-wallet/commit/c5007d1) | Swaps through 1Click: quote, verify, pay, follow |
| 13 Nov | [`675f97c`](https://github.com/honey-wallet/honey-wallet/commit/675f97c) | Group jars v1 and the NEP-366 relayer |
| 13 Nov | [`b7ec79e`](https://github.com/honey-wallet/honey-wallet/commit/b7ec79e) | Gas sponsorship for Base, Arbitrum, Polygon, Solana and NEAR (all on in production) |
| 13 Nov | [`a214349`](https://github.com/honey-wallet/honey-wallet/commit/a214349) | Social: one jar flow, profile privacy |
| 14 Nov | [`50496b0`](https://github.com/honey-wallet/honey-wallet/commit/50496b0) | Route planner: NEAR Intents first, DEX fallback |
| 14 Nov | [`a88e310`](https://github.com/honey-wallet/honey-wallet/commit/a88e310) | Creator copy fees through 1Click `appFees` |

## Demo script (about 3 minutes)

Record on an internal build with small amounts, or on a local test-mode build. Say
which on screen: test-mode balances and receipts are samples.

| Time | Screen | Say |
| --- | --- | --- |
| 0:00 | Feed, Everyone | "Friends already trade ideas in group chats. Honey makes that a wallet." |
| 0:15 | Tap **Copy** on a jar → review → approve | "Copying a jar buys the same tokens. The creator earns a cut of my profit, never of a loss." |
| 0:40 | Jar button → **Create a jar → Describe an idea** → type "AI data-centre spending keeps growing" | "The agent runs on NEAR AI Cloud." Show the stages as they appear. |
| 1:05 | The proposal: picks, weights, the caution | "Models only choose from lists the code builds. Weights and amounts come from code. A critic writes the case against." |
| 1:20 | **Launch your jar** → one approval → the jar page | "One approval pays every pick through NEAR Intents." |
| 1:35 | Swap on Base → the review's network cost line → confirm | "Honey paid the gas. No ETH needed." |
| 1:55 | Settings → **Your cut on copies** | "Creators set their cut here." |
| 2:05 | Group jar: invite friends → a friend accepts → **Your share is in** | "Up to five friends, equal shares. The money sits in a Sputnik DAO on NEAR." |
| 2:30 | Group jar page: **Changes need 2 of 3** | "Selling is a DAO proposal. It runs when the majority approves on their own phones." |

## On mainnet

Accounts Honey runs in production, with what each has done so far (checked 14 Nov, 22:30 UTC):

| What | Account | Activity |
| --- | --- | --- |
| NEAR relayer (DAO creation, NEP-366 relays) | [`e86c4a09…094c`](https://nearblocks.io/address/e86c4a09d2498bbe573160b44c0c1002854f19d5439928ca766be8b135bc094c) | Created a group jar's DAO: [tx `3YPvsoiH…ZLv`](https://nearblocks.io/txns/3YPvsoiHBFuNd4vbZyuE51QMZYE8XzdQZxRkj8Gv1ZLv) (14 Nov) |
| A group jar (Sputnik DAO v2) | [`privacy-is-normal-6c4a2d7b.sputnik-dao.near`](https://nearblocks.io/address/privacy-is-normal-6c4a2d7b.sputnik-dao.near) | Created by the relayer above; no proposals yet |
| EVM gas relayer (Base, Arbitrum, Optimism, Polygon) | [`0xc5e286D4…8C8e92eBf`](https://arbiscan.io/address/0xc5e286D4F3eBf6F02A49dD706e99bdC8C8e92eBf) | Sent 9 sponsored transactions for the wallet below on Arbitrum and Optimism, two of them EIP-7702 delegations |

A team member's Honey wallet, used through the app on mainnet ([`0x1e832F20…8bcc9a`](https://arbiscan.io/address/0x1e832F20BC939C1eB38c2D48CDA40B5c558bcc9a)).
Every transaction the app's activity list shows, oldest first, times in UTC. Honey's relayer
sent all 9 of the wallet's outgoing transactions, so Honey paid their gas (two spam
look-alike "USDC" transfers to the wallet are left out):

| When | Chain | What | Gas paid by | Transaction |
| --- | --- | --- | --- | --- |
| 13 Nov 16:55 | Arbitrum | Received 0.01 USDC from `0x6e19…cf4e` | Sender | [`0xd7ec31a6…`](https://arbiscan.io/tx/0xd7ec31a6792dcec0abaedd1c6fc589254af77f05fdc0c2308ac7c51e01ecc84f) |
| 13 Nov 17:14 | Arbitrum | Received 0.01 USDC from `0x6e19…cf4e` | Sender | [`0xbd1e48d6…`](https://arbiscan.io/tx/0xbd1e48d6887c4024943f74eb6b5f2d62003d3e351359b4a3f5945385084199dc) |
| 13 Nov 18:35 | Arbitrum | Sent 0.010004 USDC to `0x6e19…cf4e` | Honey's relayer (EIP-7702 delegation) | [`0xa852ee8d…`](https://arbiscan.io/tx/0xa852ee8df983d18007ff74367cd4cfa2a2ce0c506b73a63b4ac76e7ee31db157) |
| 13 Nov 18:36 | Arbitrum | Received 0.01 USDC from `0x6e19…cf4e` | Sender | [`0x34e647d0…`](https://arbiscan.io/tx/0x34e647d04339a19c53bfed3df55c11a3668c3378cdc09f8ac3e885e621a1bd4d) |
| 13 Nov 18:38 | Arbitrum | Received 1 USDC from `0xacdf…4e93` | Sender | [`0x91161d69…`](https://arbiscan.io/tx/0x91161d694017bef123c53aba08088334fc3177a98c19405a7e36542df3a8641c) |
| 13 Nov 18:53 | Arbitrum | Sent 1.02 USDC to `0x6e19…cf4e` | Honey's relayer | [`0x4d75422b…`](https://arbiscan.io/tx/0x4d75422b5cd3c0f46381f1e4cc7ec0ee66ed7321451a940404c01bf15f350d27) |
| 13 Nov 20:16 | Arbitrum | Received 1 USDC from `0x6e19…cf4e` | Sender | [`0x7322e6ea…`](https://arbiscan.io/tx/0x7322e6eac22ded4d7da56aa2c4f405736321b62a9751f04ff60d1f04257c22c8) |
| 13 Nov 20:30 | Arbitrum | Sent 1 USDC to `0xdbde…9824` | Honey's relayer | [`0x3c77be43…`](https://arbiscan.io/tx/0x3c77be437e60acb9a76af7f1028ff894be28c8aa1048afa36a54f9b137f27cdf) |
| 13 Nov 20:31 | Arbitrum | Received 0.995013 USDT0 from `0x2cff…2680` | Sender | [`0x44183cdb…`](https://arbiscan.io/tx/0x44183cdb69e2415c084a2ea1544bbc2971d3975ecef97b8a2af7d82bc43394f4) |
| 14 Nov 08:00 | Arbitrum | Sent 0.995013 USDT0 to `0x6459…863b` | Honey's relayer | [`0x51791983…`](https://arbiscan.io/tx/0x517919831c7d510514039a74c24c39362998918a304d2facade4f6749776cbae) |
| 14 Nov 08:01 | Arbitrum | Received 0.988546 USDC from `0x2cff…2680` | Sender | [`0x6638057a…`](https://arbiscan.io/tx/0x6638057a73e36fbb6199cac912d92f2c18eed5be2fa3e785ad43e36f18a0b7ad) |
| 14 Nov 08:08 | Arbitrum | Received 0.696085 USDC from `0xacdf…4e93` | Sender | [`0x09f1014e…`](https://arbiscan.io/tx/0x09f1014e124810079eac25d49f24b5e7d3e2f270cdd3a20a2c235cbb04208475) |
| 14 Nov 08:44 | Arbitrum | Sent 0.6 USDC to `0x5691…d37f` | Honey's relayer | [`0x97e4248f…`](https://arbiscan.io/tx/0x97e4248fc5c9300777ca548b3649764f6c1cc8ae3ea326e9b26ad475f48f094e) |
| 14 Nov 08:45 | Ethereum | Received 9.3e-05 XAUT from `0x2cff…2680` | Sender | [`0x690ce3f9…`](https://etherscan.io/tx/0x690ce3f9cda6c32f8486294c7325af7e08a0beddfe7957438e967e10cad45f0a) |
| 14 Nov 11:55 | Arbitrum | Sent 0.27 USDC to `0x564b…0cb9` | Honey's relayer | [`0x1fad3f41…`](https://arbiscan.io/tx/0x1fad3f41ee6133f6c2b3765cfd4f818ea32ab8b959fd23ecbe34945341aa2645) |
| 14 Nov 11:55 | Arbitrum | Sent 0.23 USDC to `0x2ae7…70a0` | Honey's relayer | [`0x57d295b8…`](https://arbiscan.io/tx/0x57d295b86173f8edd00bf25afff2045a6946552ae51f0ffc81affe044f95e275) |
| 14 Nov 11:55 | Arbitrum | Received 1.89162 ARB from `0x2cff…2680` | Sender | [`0xdfd37995…`](https://arbiscan.io/tx/0xdfd37995ba7d6cdc2e43371aa9cb5415efe8c21a5af0784c9c7e7facad42196e) |
| 14 Nov 11:55 | Optimism | Received 2.58207 OP from `0x233c…b4cd` | Sender | [`0xdabac33f…`](https://optimistic.etherscan.io/tx/0xdabac33f0f7afb40e4d968caa2099b0eefc1ce7ecea39c73e1b596eadd5c9a8a) |
| 14 Nov 16:15 | Arbitrum | Sent 1.89162 ARB to `0x542b…49da` | Honey's relayer | [`0xaa4fb3a5…`](https://arbiscan.io/tx/0xaa4fb3a5a3b2a2fde090ea2139aad0fff43c7fa813f2d71d8aafb4e1e314ec39) |
| 14 Nov 16:16 | Base | Received 0.251552 USDC from `0x2cff…2680` | Sender | [`0xc705de71…`](https://basescan.org/tx/0xc705de719b850e1258a44d40bc7edbe8903a36d13c642f7c621231b72b54a870) |
| 14 Nov 17:16 | Optimism | Sent 2.58207 OP to `0x51c3…c51d` | Honey's relayer (EIP-7702 delegation) | [`0x301d4583…`](https://optimistic.etherscan.io/tx/0x301d458327a499b95be1d320c150a6ea1b0954e02f39215070ae78f9a574cb41) |
| 14 Nov 17:17 | Base | Received 0.212621 USDC from `0x2cff…2680` | Sender | [`0xe31e38c3…`](https://basescan.org/tx/0xe31e38c31b4dea216b05019dcf170cfa55cf0126a60c0456c81734aa88bd9331) |

The wallet's swaps went through NEAR Intents 1Click: each deposit (gas paid by Honey) settled
on `intents.near` and was delivered on the target chain. 1Click's status API reports every one
as `SUCCESS`, with these transactions:

| Paid | Received | Deposit | NEAR settlement | Delivery |
| --- | --- | --- | --- | --- |
| 1 USDC on Arbitrum | 0.995013 USDT0 on Arbitrum | [`0x3c77be43…`](https://arbiscan.io/tx/0x3c77be437e60acb9a76af7f1028ff894be28c8aa1048afa36a54f9b137f27cdf) | [1](https://nearblocks.io/txns/HAHnxdymPHQ4HJo8S38px4RjzWkVDi2anVisJa4sP9oJ) [2](https://nearblocks.io/txns/DH7gNTfCdHa8VYFADLnpLLuHQxxKuMLyBH92y3aMD38g) [3](https://nearblocks.io/txns/HrUdZdjCPgzmWJ5oZVydD5aZ16HSmzMkmoqBYwTp4xuM) [4](https://nearblocks.io/txns/EQWPqNNjrbJ4w37qX37dNDpNwXEFM3XPjWAbghm7a1zR) | [`0x44183cdb…`](https://arbiscan.io/tx/0x44183cdb69e2415c084a2ea1544bbc2971d3975ecef97b8a2af7d82bc43394f4) |
| 0.995013 USDT0 on Arbitrum | 0.988546 USDC on Arbitrum | [`0x51791983…`](https://arbiscan.io/tx/0x517919831c7d510514039a74c24c39362998918a304d2facade4f6749776cbae) | [1](https://nearblocks.io/txns/9EJSQaoBaYNpLj6gg76zs6JVZe2keXUyiMCvz6S8KuXV) [2](https://nearblocks.io/txns/FAHeDqytgssdyXFCAbj6t5zmhiu8WpxnpvSez5hQegJA) [3](https://nearblocks.io/txns/6uXWG921CAobsu1HNsmindu8pME8tUQbQzSv6WYvGKMw) [4](https://nearblocks.io/txns/Gf5MN2oeNrzCfzKqbxUtL1uS7sg5hgsimHctV67wngbf) | [`0x6638057a…`](https://arbiscan.io/tx/0x6638057a73e36fbb6199cac912d92f2c18eed5be2fa3e785ad43e36f18a0b7ad) |
| 0.6 USDC on Arbitrum | 0.000093 XAUt on Ethereum | [`0x97e4248f…`](https://arbiscan.io/tx/0x97e4248fc5c9300777ca548b3649764f6c1cc8ae3ea326e9b26ad475f48f094e) | [1](https://nearblocks.io/txns/7A6pq7fGozuCtNx2jRsn1tA2CmKszGemQo77wbAGiwnY) [2](https://nearblocks.io/txns/EzSCJc1T8QbjhE8PF1mHBWs2ysGrLAXanCveyjWBetd5) [3](https://nearblocks.io/txns/2LB7pwbNJunjXhj4qNQNXBtRPmVUQwn2QZVWoybF4Wie) [4](https://nearblocks.io/txns/G2aLMRAY3RgXUTWXZ5W38jodsbbQXidKUtGSypKxm2CM) | [`0x690ce3f9…`](https://etherscan.io/tx/0x690ce3f9cda6c32f8486294c7325af7e08a0beddfe7957438e967e10cad45f0a) |
| 0.27 USDC on Arbitrum | 1.89162 ARB on Arbitrum | [`0x1fad3f41…`](https://arbiscan.io/tx/0x1fad3f41ee6133f6c2b3765cfd4f818ea32ab8b959fd23ecbe34945341aa2645) | [1](https://nearblocks.io/txns/GPsswXBK1NAx6VtSXnf6n1xTs4CKtGRJRCdS3eLkWiov) [2](https://nearblocks.io/txns/7gry9VJq2q8vQ6ynSBBnWLt2rqMERVApkEBeutbAsUHF) [3](https://nearblocks.io/txns/4Tkr4fJSbwUGBCuHogqZZYBRqRoDzVK4yv1cG2nRCZf1) [4](https://nearblocks.io/txns/9dYV7EXe4C1qFgpJwaz8dZ8BVFUgd1FesCF1kpARpHfz) | [`0xdfd37995…`](https://arbiscan.io/tx/0xdfd37995ba7d6cdc2e43371aa9cb5415efe8c21a5af0784c9c7e7facad42196e) |
| 0.23 USDC on Arbitrum | 2.58207 OP on Optimism | [`0x57d295b8…`](https://arbiscan.io/tx/0x57d295b86173f8edd00bf25afff2045a6946552ae51f0ffc81affe044f95e275) | [1](https://nearblocks.io/txns/3UphxqXZERQjSmtYn8xC9EKjJCYxGrqygVv9VxE5L8YC) [2](https://nearblocks.io/txns/2JKhQyk1PeeLiFs7eLbRWyhPci3xfeSzxRDv3YQmDKtt) [3](https://nearblocks.io/txns/5ZNh4UvDCxN2dnprLPZyAWZ8DqoLM98AtyEBmNqkPQpX) [4](https://nearblocks.io/txns/4SPPKp5AD9drzKp9eSqm6XCapA8d1aPWvpktTkHa29tP) | [`0xdabac33f…`](https://optimistic.etherscan.io/tx/0xdabac33f0f7afb40e4d968caa2099b0eefc1ce7ecea39c73e1b596eadd5c9a8a) |
| 1.89162 ARB on Arbitrum | 0.251552 USDC on Base | [`0xaa4fb3a5…`](https://arbiscan.io/tx/0xaa4fb3a5a3b2a2fde090ea2139aad0fff43c7fa813f2d71d8aafb4e1e314ec39) | [1](https://nearblocks.io/txns/3TLWu8URFmNFE7nT2uHiktg98bq8QgD3QT7e2Qv85zVR) [2](https://nearblocks.io/txns/5Qj8X5gm8uTJdnWDupaUTis3xYAHRnXFP1QJD85eLHVe) [3](https://nearblocks.io/txns/4tWRkN6jVfdRyScrDM1hYuh6K5senFycdbx9hu2kpEDU) [4](https://nearblocks.io/txns/DdefVQCTy633pe6wWiUkkm9eKCYuMjDtKqBUv9PYRzW) | [`0xc705de71…`](https://basescan.org/tx/0xc705de719b850e1258a44d40bc7edbe8903a36d13c642f7c621231b72b54a870) |
| 2.58207 OP on Optimism | 0.212621 USDC on Base | [`0x301d4583…`](https://optimistic.etherscan.io/tx/0x301d458327a499b95be1d320c150a6ea1b0954e02f39215070ae78f9a574cb41) | [1](https://nearblocks.io/txns/35f16dEZKd9NegSaWm59iob9embv5wjwsy76Mz7Mjq3s) [2](https://nearblocks.io/txns/CXgCxxkBUgC9HLgTJgE6EzQaR5fUWVarjijGk7BttX2L) [3](https://nearblocks.io/txns/8qnwRSR7aQWfUD9GwtMJuRbo68CybjWguiMeUDpkiQ1E) [4](https://nearblocks.io/txns/5QrRvN8MBzz4tdTf2gZzkPwWvpdbCCKnTuRssF4KBnWF) | [`0xe31e38c3…`](https://basescan.org/tx/0xe31e38c31b4dea216b05019dcf170cfa55cf0126a60c0456c81734aa88bd9331) |

## Judging notes

### Technical depth

- **Route planner.** 1Click is quoted first. Only when it keeps under 90% (or fails, or
  hasn't answered in 1.5 s) are the DEX candidates quoted, in parallel under a timeout, so a
  normal trade costs one provider call. At 90% or above, 1Click is kept even when a DEX is cheaper ([route_planner.rs](apps/server/src/route_planner.rs)).
- **The phone's own checks.** Every DEX trade is valued at a price the phone reads itself
  (1Click or DexScreener, decimals read on chain), never the server's
  ([app-price.ts](apps/mobile/src/lib/app-price.ts)).
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
so members pay no gas; NEAR AI Cloud for every model call; NEAR Confidential Intents for private jars (a FROST
threshold key over a NEAR account; Create a jar → Private jar); NEAR
implicit accounts in the keyring. Table with file links: [README, How Honey uses NEAR](README.md#how-honey-uses-near).

### User experience

- One approval buys a whole jar across chains.
- Face ID confirms; the phone checks each quote, at its own prices, before it signs.
- Honey pays the gas on Base, Arbitrum, Polygon, Optimism, Solana and NEAR, within a per-person allowance.
- When a trade can't go through NEAR Intents, the review says why in one line and that
  the swap is public.
- Nothing is public until you claim a handle. Sharing trades is off by default.

### Impact

Honey is for people who already invest with friends. It turns "what are you buying?"
into a jar you can copy, and a group bet into a treasury no single friend controls.
Creators get paid when their picks make money for others.

## Known limitations

- NEAR Intents has no testnet, so live flows spend mainnet funds.
- Not on a store yet: the iPhone beta is waiting for Apple's TestFlight review; Android is coming soon.
- No card on-ramp or cash off-ramp. Earn shows rates only.

## What's next

These are marked "coming soon" or switched off in the code today.

- Android release.
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
