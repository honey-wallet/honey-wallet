//! The curated map of canonical wrapped majors per chain: what a jar buys "where the
//! money is" when NEAR Intents can't carry a small leg (docs/routing/BEST-ROUTE.md).
//!
//! Never guessed: each address is the token's well-known canonical deployment, and each
//! was read on chain on 2026-11-13 (`symbol()` and `decimals()` through the default
//! public RPCs: the values below). They are bridged or proxied tokens, so GoPlus calls
//! them upgradeable; being reviewed here, they are on the upgradeable allowlist by
//! default (`DexConfig::default`). Every other safety check still applies at quote time.
//! There is no canonical SOL on the EVM chains, so SOL is never bought wrapped.

use super::DexChain;

/// A major asset family a jar pick can belong to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Btc,
    Eth,
    /// Tether Gold: XAUT on Ethereum, XAUt0 (its official LayerZero version) elsewhere.
    Xaut,
}

impl Family {
    /// The family of a 1Click symbol (BTC, WBTC, cbBTC; ETH, WETH).
    pub fn of_symbol(symbol: &str) -> Option<Self> {
        match symbol.trim().to_ascii_uppercase().as_str() {
            "BTC" | "WBTC" | "CBBTC" => Some(Self::Btc),
            "ETH" | "WETH" => Some(Self::Eth),
            "XAUT" | "XAUT0" => Some(Self::Xaut),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Btc => "BTC",
            Self::Eth => "ETH",
            Self::Xaut => "XAUT",
        }
    }
}

/// One canonical version: family, chain, address (lowercase), symbol, decimals.
pub struct Canonical {
    pub family: Family,
    pub chain: DexChain,
    pub address: &'static str,
    pub symbol: &'static str,
    pub decimals: u8,
}

pub const CANONICAL: &[Canonical] = &[
    Canonical {
        family: Family::Btc,
        chain: DexChain::Base,
        address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
        symbol: "cbBTC",
        decimals: 8,
    },
    Canonical {
        family: Family::Btc,
        chain: DexChain::Arbitrum,
        address: "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f",
        symbol: "WBTC",
        decimals: 8,
    },
    // Optimism's two were read on chain on 2026-11-14 (mainnet.optimism.io).
    Canonical {
        family: Family::Btc,
        chain: DexChain::Optimism,
        address: "0x68f180fcce6836688e9084f035309e29bf0a2095",
        symbol: "WBTC",
        decimals: 8,
    },
    Canonical {
        family: Family::Btc,
        chain: DexChain::Ethereum,
        address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
        symbol: "WBTC",
        decimals: 8,
    },
    Canonical {
        family: Family::Btc,
        chain: DexChain::Polygon,
        address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
        symbol: "WBTC",
        decimals: 8,
    },
    Canonical {
        family: Family::Eth,
        chain: DexChain::Base,
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        decimals: 18,
    },
    Canonical {
        family: Family::Eth,
        chain: DexChain::Arbitrum,
        address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        symbol: "WETH",
        decimals: 18,
    },
    Canonical {
        family: Family::Eth,
        chain: DexChain::Optimism,
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        decimals: 18,
    },
    Canonical {
        family: Family::Eth,
        chain: DexChain::Ethereum,
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        symbol: "WETH",
        decimals: 18,
    },
    Canonical {
        family: Family::Eth,
        chain: DexChain::Polygon,
        address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
        symbol: "WETH",
        decimals: 18,
    },
    // Tether Gold's XAUt0 on Arbitrum, read on chain on 2026-11-14 (arb1.arbitrum.io:
    // symbol XAUt0, 6 decimals). NEAR Intents lists XAUT only on Ethereum, whose payout
    // fee sinks small buys; a jar leg can hold this instead.
    Canonical {
        family: Family::Xaut,
        chain: DexChain::Arbitrum,
        address: "0x40461291347e1ecbb09499f3371d3f17f10d7159",
        symbol: "XAUt0",
        decimals: 6,
    },
];

/// The family's canonical version on `chain`, if Honey has one.
pub fn on(family: Family, chain: DexChain) -> Option<&'static Canonical> {
    CANONICAL
        .iter()
        .find(|c| c.family == family && c.chain == chain)
}

/// Whether (chain, address) is one of the curated versions.
pub fn is_canonical(chain: DexChain, address: &str) -> bool {
    CANONICAL
        .iter()
        .any(|c| c.chain == chain && c.address.eq_ignore_ascii_case(address))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_a_normalized_address_and_one_per_family_and_chain() {
        for c in CANONICAL {
            assert_eq!(c.chain.normalize(c.address).as_deref(), Some(c.address));
            assert_eq!(
                CANONICAL
                    .iter()
                    .filter(|o| o.family == c.family && o.chain == c.chain)
                    .count(),
                1
            );
            assert!(!c.chain.is_usdc(c.address));
        }
        assert_eq!(Family::of_symbol("cbBTC"), Some(Family::Btc));
        assert_eq!(Family::of_symbol("weth"), Some(Family::Eth));
        // SOL has no canonical EVM version: never bought wrapped.
        assert_eq!(Family::of_symbol("SOL"), None);
        assert_eq!(on(Family::Btc, DexChain::Arbitrum).unwrap().symbol, "WBTC");
        assert!(on(Family::Eth, DexChain::Solana).is_none());
        assert_eq!(Family::of_symbol("XAUt0"), Some(Family::Xaut));
        assert_eq!(on(Family::Xaut, DexChain::Arbitrum).unwrap().decimals, 6);
    }
}
