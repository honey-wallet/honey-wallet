//! The chains DEX routing covers, their USDC, and the hardcoded router allowlist.
//!
//! Every router or program here is one Honey's relayer may pay to call. An address is
//! added only after it is checked against the provider's own documentation and its live
//! API answer; a router the provider names that is not here makes the quote fail.

use alloy_primitives::{Address, address};
use serde::{Deserialize, Serialize};

/// KyberSwap `MetaAggregationRouterV2`, the same CREATE2 address on Ethereum, Base,
/// Arbitrum and Polygon. Source: KyberSwap docs, "Contracts" / "Aggregator Contract
/// Addresses" (docs.kyberswap.com/developer-guide/aggregator-api/contracts; verified
/// `MetaAggregationRouterV2` on Etherscan),
/// and the `routerAddress` the Aggregator API returned for all four chains on 2026-11-13
/// (docs/routing/LIVE-CHECK.md). Sell tokens are approved to it for the exact amount.
pub const KYBER_ROUTER: Address = address!("6131B5fae19EA4f9D964eAc0408E4408b66337b5");

/// KyberSwap's executor (the `callTarget` its router hands the sell token to), the same
/// address on Ethereum, Base, Arbitrum and Polygon. Seen as `callTarget` and
/// `srcReceivers[0]` in every `route/build` answer on all four chains on 2026-11-13
/// (docs/routing/AUDIT.md finding 5). Kyber's router doesn't allowlist `callTarget`, so
/// Honey does: a build naming another executor is refused.
pub const KYBER_EXECUTOR: Address = address!("8f10b468b06c6fd214b65f87778827f7d113f996");

/// Jupiter Aggregator v6 (`JUP6Lkb...`), the program every Metis route of Jupiter Swap
/// V2 `/order` calls. Source: Jupiter developer docs (developers.jup.ag, Swap API) and
/// the live `/swap/v2/order` transaction of 2026-11-13 (docs/routing/LIVE-CHECK.md).
pub const JUPITER_V6: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/// USDC (Circle) on Solana.
pub const USDC_SOLANA: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/// Wrapped SOL.
pub const WRAPPED_SOL: &str = "So11111111111111111111111111111111111111112";

/// A chain DEX routing quotes on. The wire names match the API contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DexChain {
    Base,
    Arbitrum,
    Polygon,
    Ethereum,
    Solana,
}

pub const ALL: [DexChain; 5] = [
    DexChain::Base,
    DexChain::Arbitrum,
    DexChain::Polygon,
    DexChain::Ethereum,
    DexChain::Solana,
];

impl DexChain {
    pub fn parse(name: &str) -> Option<Self> {
        ALL.into_iter().find(|c| c.name() == name.trim())
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Arbitrum => "arbitrum",
            Self::Polygon => "polygon",
            Self::Ethereum => "ethereum",
            Self::Solana => "solana",
        }
    }

    pub fn is_evm(self) -> bool {
        self != Self::Solana
    }

    /// EVM chain id (None on Solana).
    pub fn chain_id(self) -> Option<u64> {
        match self {
            Self::Base => Some(8453),
            Self::Arbitrum => Some(42161),
            Self::Polygon => Some(137),
            Self::Ethereum => Some(1),
            Self::Solana => None,
        }
    }

    pub fn from_chain_id(id: u64) -> Option<Self> {
        ALL.into_iter().find(|c| c.chain_id() == Some(id))
    }

    /// KyberSwap's path segment for the chain.
    pub fn kyber(self) -> Option<&'static str> {
        match self {
            Self::Base => Some("base"),
            Self::Arbitrum => Some("arbitrum"),
            Self::Polygon => Some("polygon"),
            Self::Ethereum => Some("ethereum"),
            Self::Solana => None,
        }
    }

    /// GoPlus's chain id.
    pub fn goplus(self) -> &'static str {
        match self {
            Self::Base => "8453",
            Self::Arbitrum => "42161",
            Self::Polygon => "137",
            Self::Ethereum => "1",
            Self::Solana => "solana",
        }
    }

    /// CoinGecko's asset platform id.
    pub fn coingecko_platform(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Arbitrum => "arbitrum-one",
            Self::Polygon => "polygon-pos",
            Self::Ethereum => "ethereum",
            Self::Solana => "solana",
        }
    }

    /// GeckoTerminal's network id (DexScreener uses the same names on these chains,
    /// except Polygon).
    pub fn geckoterminal(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Arbitrum => "arbitrum",
            Self::Polygon => "polygon_pos",
            Self::Ethereum => "eth",
            Self::Solana => "solana",
        }
    }

    pub fn dexscreener(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Arbitrum => "arbitrum",
            Self::Polygon => "polygon",
            Self::Ethereum => "ethereum",
            Self::Solana => "solana",
        }
    }

    /// 1Click's blockchain id.
    pub fn oneclick(self) -> &'static str {
        match self {
            Self::Base => "base",
            Self::Arbitrum => "arb",
            Self::Polygon => "pol",
            Self::Ethereum => "eth",
            Self::Solana => "sol",
        }
    }

    /// Circle's native USDC on the chain, lowercase hex or base58.
    pub fn usdc(self) -> &'static str {
        match self {
            Self::Base => "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            Self::Arbitrum => "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
            Self::Polygon => "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
            Self::Ethereum => "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            Self::Solana => USDC_SOLANA,
        }
    }

    /// The EVM routers Honey may approve and call on this chain.
    pub fn routers(self) -> &'static [Address] {
        match self {
            Self::Solana => &[],
            _ => &[KYBER_ROUTER],
        }
    }

    pub fn router_allowed(self, router: Address) -> bool {
        self.routers().contains(&router)
    }

    /// The Kyber executors Honey lets its router hand the sell token to on this chain.
    pub fn executors(self) -> &'static [Address] {
        match self {
            Self::Solana => &[],
            _ => &[KYBER_EXECUTOR],
        }
    }

    pub fn executor_allowed(self, executor: Address) -> bool {
        self.executors().contains(&executor)
    }

    /// A token address in its canonical form (EVM: lowercase 0x hex; Solana: base58 as
    /// given, 32 bytes). None when malformed.
    pub fn normalize(self, token: &str) -> Option<String> {
        let token = token.trim();
        if self.is_evm() {
            let address: Address = (token.len() == 42).then(|| token.parse().ok())??;
            (!address.is_zero()).then(|| format!("{address:#x}"))
        } else {
            let bytes = bs58::decode(token).into_vec().ok()?;
            (bytes.len() == 32).then(|| token.to_string())
        }
    }

    pub fn is_usdc(self, token: &str) -> bool {
        self.normalize(token).as_deref() == Some(self.usdc())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_ids_and_usdc() {
        for chain in ALL {
            assert_eq!(DexChain::parse(chain.name()), Some(chain));
            assert!(chain.normalize(chain.usdc()).is_some(), "{chain:?}");
            assert!(
                chain.is_usdc(&chain.usdc().to_uppercase().replace("0X", "0x")) || !chain.is_evm()
            );
        }
        assert_eq!(DexChain::from_chain_id(8453), Some(DexChain::Base));
        assert_eq!(DexChain::parse("bsc"), None);
        assert!(DexChain::Base.router_allowed(KYBER_ROUTER));
        assert!(!DexChain::Base.router_allowed(Address::ZERO));
        assert!(DexChain::Solana.routers().is_empty());
        assert!(DexChain::Polygon.executor_allowed(KYBER_EXECUTOR));
        assert!(!DexChain::Polygon.executor_allowed(KYBER_ROUTER));
        assert_eq!(
            DexChain::Base.normalize("0x0000000000000000000000000000000000000000"),
            None
        );
        assert_eq!(DexChain::Solana.normalize("not-base58!"), None);
        assert_eq!(
            DexChain::Solana.normalize(JUPITER_V6).as_deref(),
            Some(JUPITER_V6)
        );
    }

    #[test]
    fn usdc_matches_the_sponsor_table() {
        for spec in crate::evm_sponsor::CHAINS.iter() {
            let chain = DexChain::from_chain_id(spec.id).unwrap();
            assert_eq!(chain.usdc(), format!("{:#x}", spec.usdc));
        }
    }
}
