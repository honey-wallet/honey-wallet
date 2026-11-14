//! Exposure categories the understand prompt may tag an exposure with, and the tickers
//! code treats as members of each. Curated and checked into the repo (like the registry's
//! instrument types), never inferred by a model: the shortlist joins these with the live
//! registry, so a listed ticker that NEAR Intents can't deliver simply doesn't appear.
//! Since 2026-11-14 the registry also holds Honey's DEX list, so these name the tokens
//! KyberSwap and Jupiter can buy on Honey's chains too (AERO, PENDLE, JTO …).

use super::registry::InstrumentType;

pub struct Category {
    pub id: &'static str,
    /// What the understand prompt reads next to the id.
    pub about: &'static str,
    pub tickers: &'static [&'static str],
    /// Instrument types that belong here whatever their ticker (all tokenized stocks).
    pub kinds: &'static [InstrumentType],
}

pub const CATEGORIES: &[Category] = &[
    Category {
        id: "ai",
        about: "AI and decentralized compute tokens",
        // tickers: &[
        //     "TAO", "RENDER", "FET", "VIRTUAL", "AKT", "WLD", "GRT", "ARKM", "IO", "AIOZ", "VVV",
        //     "KAITO", "AI16Z", "NEAR",
        // ],
        tickers: &[
            "TAO", "RENDER", "FET", "VIRTUAL", "AKT", "WLD", "GRT", "ARKM", "IO", "AIOZ", "VVV",
            "KAITO", "AI16Z", "NEAR", "WTAO", "OLAS", "AIXBT", "GRASS", "NMR", "PRIME", "ATH",
            "COOKIE", "ZEREBRO", "GRIFFAIN", "ARC", "SWARMS", "NOS", "GOAT",
        ],
        kinds: &[],
    },
    Category {
        id: "bitcoin",
        about: "Bitcoin and wrapped bitcoin",
        tickers: &["BTC", "WBTC", "CBBTC", "XBTC", "TBTC"],
        kinds: &[],
    },
    Category {
        id: "ethereum",
        about: "Ether and staked ether",
        tickers: &["ETH", "WETH", "WSTETH", "STETH", "RETH"],
        kinds: &[],
    },
    Category {
        id: "solana_ecosystem",
        about: "Solana and tokens native to Solana",
        // tickers: &[
        //     "SOL", "JUP", "JTO", "PYTH", "RAY", "ORCA", "BONK", "WIF", "BOME", "PENGU", "RENDER",
        //     "TRUMP", "SPX",
        // ],
        tickers: &[
            "SOL", "JUP", "JTO", "PYTH", "RAY", "ORCA", "BONK", "WIF", "BOME", "PENGU", "RENDER",
            "TRUMP", "SPX", "KMNO", "DRIFT", "MET", "CLOUD", "TNSR", "W", "HNT", "MEW", "POPCAT",
            "FARTCOIN", "JLP", "JUPSOL", "MSOL", "JITOSOL",
        ],
        kinds: &[],
    },
    Category {
        id: "near_ecosystem",
        about: "NEAR and tokens native to NEAR",
        tickers: &[
            "NEAR", "WNEAR", "STNEAR", "RHEA", "AURORA", "SWEAT", "MPDAO", "NPRO", "HAPI",
        ],
        kinds: &[],
    },
    Category {
        id: "smart_contract_l1",
        about: "Large layer-1 blockchains",
        tickers: &[
            "ETH", "SOL", "BNB", "AVAX", "ADA", "SUI", "APT", "NEAR", "TRX", "TON", "GRAM", "MON",
            "BERA", "XPL",
        ],
        kinds: &[],
    },
    Category {
        id: "ethereum_l2",
        about: "Ethereum scaling networks",
        // tickers: &["ARB", "OP", "STRK", "POL", "MATIC", "MNT", "MOVE"],
        tickers: &[
            "ARB", "OP", "STRK", "POL", "MATIC", "MNT", "MOVE", "ZK", "IMX", "METIS", "MANTA",
            "TAIKO", "SCR", "ZRO",
        ],
        kinds: &[],
    },
    Category {
        id: "defi",
        about: "Lending, exchange and oracle protocols",
        // tickers: &[
        //     "AAVE", "UNI", "LINK", "GMX", "COW", "KNC", "CRV", "MKR", "SKY", "LDO", "PENDLE",
        //     "JUP", "ASTER", "HYPE", "RHEA", "SAFE",
        // ],
        tickers: &[
            "AAVE", "UNI", "LINK", "GMX", "COW", "KNC", "CRV", "MKR", "SKY", "LDO", "PENDLE",
            "JUP", "ASTER", "HYPE", "RHEA", "SAFE", "MORPHO", "AERO", "VELO", "CVX", "SNX", "COMP",
            "BAL", "1INCH", "SUSHI", "YFI", "ENA", "ETHFI", "EIGEN", "RAY", "ORCA", "JTO", "KMNO",
            "DRIFT", "PYTH", "GRAIL", "RPL", "FXS", "SYRUP", "EUL", "SPK", "RSR",
        ],
        kinds: &[],
    },
    Category {
        id: "exchange_tokens",
        about: "Tokens of large crypto exchanges",
        tickers: &["BNB", "OKB", "CRO", "ASTER", "HYPE"],
        kinds: &[],
    },
    Category {
        id: "payments",
        about: "Coins built mainly for payments and transfers",
        tickers: &["XRP", "XLM", "LTC", "BCH", "DOGE", "TRX", "DASH"],
        kinds: &[],
    },
    Category {
        id: "privacy",
        about: "Privacy coins and private-payment networks",
        tickers: &["ZEC", "XMR", "DASH", "ALEO", "SCRT"],
        kinds: &[],
    },
    Category {
        id: "memecoins",
        about: "Meme coins (very high risk)",
        // tickers: &[
        //     "DOGE", "SHIB", "PEPE", "WIF", "BONK", "BOME", "BRETT", "MOG", "TURBO", "SPX", "PENGU",
        //     "TRUMP", "MELANIA", "FLOKI", "CASHCAT",
        // ],
        tickers: &[
            "DOGE", "SHIB", "PEPE", "WIF", "BONK", "BOME", "BRETT", "MOG", "TURBO", "SPX", "PENGU",
            "TRUMP", "MELANIA", "FLOKI", "CASHCAT", "POPCAT", "MEW", "FARTCOIN", "PNUT", "GOAT",
            "MOODENG", "CHILLGUY", "GIGA", "TOSHI", "DEGEN", "KEYCAT", "NEIRO", "PONKE", "MICHI",
            "USELESS", "TROLL", "PIPPIN", "BIRB", "LMAO", "HAROLD", "NEET", "STONK", "ANTFUN",
            "BAN", "ACT", "WOJAK", "ANDY", "LADYS", "BABYDOGE", "DOG", "SNEK", "PUMP", "BITCOIN",
            "ZEREBRO", "GRIFFAIN", "SWARMS",
        ],
        kinds: &[],
    },
    Category {
        id: "gold",
        about: "Tokenized gold",
        // tickers: &["XAUT", "PAXG"],
        tickers: &["XAUT", "PAXG", "XAUT0", "KAU", "CGO"],
        kinds: &[],
    },
    Category {
        id: "stablecoins",
        about: "Holding dollars (never a pick: Honey keeps uninvested money in USDC)",
        tickers: &[
            "USDC", "USDT", "DAI", "USDE", "USD1", "USDG", "PYUSD", "FRAX", "USDS",
        ],
        kinds: &[InstrumentType::Stablecoin],
    },
    Category {
        id: "non_usd_stablecoins",
        about: "Stablecoins tied to other currencies",
        tickers: &["EURC", "EURE", "GBPE", "KZTE"],
        kinds: &[],
    },
    Category {
        id: "tokenized_stocks",
        about: "Tokenized shares of listed companies and ETFs (Ondo, xStocks)",
        tickers: &[],
        kinds: &[InstrumentType::TokenizedStock],
    },
    Category {
        id: "real_world_assets",
        about: "Tokenized real-world assets and the platforms that issue them",
        // tickers: &["ONDO", "XAUT", "PAXG", "LINK", "PLUME"],
        tickers: &[
            "ONDO", "XAUT", "PAXG", "LINK", "PLUME", "SYRUP", "CFG", "OM", "POLYX",
        ],
        kinds: &[],
    },
];

pub fn find(id: &str) -> Option<&'static Category> {
    CATEGORIES.iter().find(|c| c.id == id)
}

pub fn ids() -> Vec<&'static str> {
    CATEGORIES.iter().map(|c| c.id).collect()
}

/// The list the understand prompt reads: `id: about` per line.
pub fn menu() -> String {
    CATEGORIES
        .iter()
        .map(|c| format!("- {}: {}", c.id, c.about))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_tickers_upper_case() {
        let mut ids = ids();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CATEGORIES.len());
        for c in CATEGORIES {
            assert!(
                c.tickers.iter().all(|t| t
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())),
                "{}",
                c.id
            );
        }
        assert!(find("gold").is_some());
        assert!(menu().contains("- ai:"));
    }
}
