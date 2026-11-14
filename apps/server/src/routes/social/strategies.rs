//! Honey strategies (2026-11-14, the owner's decision): five accounts Honey runs, each
//! with one real jar, so the Feed, the Following suggestions and the Leaderboard aren't
//! empty while people's own jars are few. Honest by construction:
//!
//! - each account is marked `official` (the app's Honey badge) and its handle starts
//!   with `honey_`, which nobody else can claim (`reserved`); it has a `users` row and
//!   nothing else, no wallet and no sign-in identity, so nobody can sign in as it;
//! - its jar is published exactly as a person's is (`publish_with`): every pick must be
//!   buyable through Honey today (checked against the live 1Click list; anything that
//!   isn't is skipped and logged), its start prices are 1Click's prices at seed time
//!   (never backdated), and its return, marks, milestones and copy count are computed
//!   like any jar's; there are no stored numbers to fake;
//! - copies go through the same copy path as any jar's (`copy_fees`): free while
//!   `HONEY_COPY_FEE_ACCOUNT` is unset (users pay no fees, 2026-11-14), and otherwise
//!   paying Honey's fee exactly as any jar's copies would.
//!
//! Only `honey-server seed-honey-strategies` creates or changes them; re-running it is
//! safe, and with changed picks it rebalances each jar the way republishing does (the
//! record continues from the value reached). The API can't set `official`.
//!
//! While boosted (`HoneyStrategies::boosted`: on, and fewer than `min_organic` live
//! public jars by people) they're suggested on Following's empty state and rank on the
//! leaderboard; after that they're ordinary accounts (leaving the leaderboard once it
//! has `min_organic` jars of people's own). `HONEY_STRATEGIES_ENABLED=0` hides them
//! everywhere: feed, Explore, leaderboard, suggestions, profiles, search, jars and
//! share pages.

use std::sync::Arc;

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use super::{Pick, PublishRequest, buyable_picks, publish_with, validate_picks};
use crate::{
    error::AppError,
    identity::unavailable,
    market_data::{MarketData, MarketListToken, market_list},
};

/// Every Honey strategy handle starts with this; people can't claim it (`reserved`).
pub const HANDLE_PREFIX: &str = "honey_";
/// Each strategy account's one jar (its id "on the phone", as people's jars have).
pub const JAR_CLIENT_ID: &str = "honey-strategy";
/// Live public jars by people at which Honey's step back, when the env doesn't say.
pub const DEFAULT_MIN_ORGANIC: i64 = 10;
/// The copy fee recorded on the jars (the jar column's default). It charges nothing by
/// itself: only `HONEY_COPY_FEE_ACCOUNT` turns copy fees on (`copy_fees`), and it's unset.
const COPY_FEE: i16 = 10;
/// Serialises seeding runs (two Cloud Run executions at once can't race on a handle).
const SEED_LOCK: i64 = 0x484f_4e45_5953_5452;

/// Whether Honey's strategy accounts are shown, and until when they're boosted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HoneyStrategies {
    /// `HONEY_STRATEGIES_ENABLED` (default on). Off hides them everywhere.
    pub enabled: bool,
    /// `HONEY_STRATEGIES_MIN_ORGANIC` (default 10): live public jars by people at which
    /// Honey's stop being suggested, and jars of people's own on the leaderboard at
    /// which Honey's leave it.
    pub min_organic: i64,
}

impl Default for HoneyStrategies {
    fn default() -> Self {
        Self {
            enabled: true,
            min_organic: DEFAULT_MIN_ORGANIC,
        }
    }
}

impl HoneyStrategies {
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).ok();
        Self::parse(
            var("HONEY_STRATEGIES_ENABLED").as_deref(),
            var("HONEY_STRATEGIES_MIN_ORGANIC").as_deref(),
        )
    }

    /// Unset or empty: on, and `DEFAULT_MIN_ORGANIC`. The switch takes 1/true/on/yes or
    /// 0/false/off/no; anything else is logged and read as off (a kill switch that was
    /// meant to be used fails closed). A count that isn't a whole number is logged and
    /// the default used.
    pub fn parse(enabled: Option<&str>, min_organic: Option<&str>) -> Self {
        let enabled = match enabled.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            None | Some("") | Some("1" | "true" | "on" | "yes") => true,
            Some("0" | "false" | "off" | "no") => false,
            Some(_) => {
                tracing::warn!(
                    "HONEY_STRATEGIES_ENABLED is not 1/0/true/false; Honey strategies are off"
                );
                false
            }
        };
        let min_organic = match min_organic.map(str::trim).filter(|v| !v.is_empty()) {
            None => DEFAULT_MIN_ORGANIC,
            Some(v) => match v.parse::<i64>() {
                Ok(n) => n.clamp(0, 1_000_000),
                Err(_) => {
                    tracing::warn!(
                        "HONEY_STRATEGIES_MIN_ORGANIC is not a whole number; using {DEFAULT_MIN_ORGANIC}"
                    );
                    DEFAULT_MIN_ORGANIC
                }
            },
        };
        Self {
            enabled,
            min_organic,
        }
    }

    /// Whether Honey's jars are still suggested, given people's live public jars.
    pub fn boosted(&self, organic_jars: i64) -> bool {
        self.enabled && organic_jars < self.min_organic
    }
}

/// One pick as the seed wants it: weights are relative; whatever is buyable at seed time
/// is rescaled to 100 (`seeded_picks`).
#[derive(Debug)]
pub struct StrategyPick {
    pub symbol: &'static str,
    /// Honey's chain name, as people's jars name it ("Ethereum", "Base", "Solana"…).
    pub chain: &'static str,
    pub weight: u32,
}

/// One Honey strategy account and its jar.
#[derive(Debug)]
pub struct Strategy {
    pub handle: &'static str,
    pub display_name: &'static str,
    /// The phone draws the avatar from this.
    pub avatar_seed: &'static str,
    /// One line, plainly: that Honey runs it and what it holds.
    pub bio: &'static str,
    pub jar_name: &'static str,
    /// One sentence; true whichever of the picks are buyable.
    pub thesis: &'static str,
    pub picks: &'static [StrategyPick],
}

const fn pick(symbol: &'static str, chain: &'static str, weight: u32) -> StrategyPick {
    StrategyPick {
        symbol,
        chain,
        weight,
    }
}

/// The five strategies. Picks not buyable through Honey when the seed runs (on
/// 2026-11-14: TAO, RENDER, FET, JUP, JTO and PYTH) are skipped and logged, and join the
/// jar on a later run once 1Click lists them on one of Honey's chains.
pub const STRATEGIES: &[Strategy] = &[
    Strategy {
        handle: "honey_gold",
        display_name: "Honey Gold",
        avatar_seed: "honey-gold",
        bio: "Run by Honey. One jar of tokenized gold and bitcoin.",
        jar_name: "Gold & Bitcoin",
        thesis: "Tokenized gold and bitcoin, two scarce assets held side by side.",
        picks: &[pick("XAUT", "Ethereum", 50), pick("WBTC", "Ethereum", 50)],
    },
    Strategy {
        handle: "honey_ai",
        display_name: "Honey AI",
        avatar_seed: "honey-ai",
        bio: "Run by Honey. One jar of AI-related tokens Honey can buy.",
        jar_name: "AI tokens",
        thesis: "Tokens tied to AI networks and apps, led by NEAR.",
        picks: &[
            pick("NEAR", "NEAR", 30),
            pick("TAO", "Ethereum", 20),
            pick("RENDER", "Solana", 15),
            pick("FET", "Ethereum", 10),
            pick("VVV", "Base", 15),
            pick("KAITO", "Base", 10),
        ],
    },
    Strategy {
        handle: "honey_solana",
        display_name: "Honey Solana",
        avatar_seed: "honey-solana",
        bio: "Run by Honey. One jar of SOL and Solana ecosystem tokens.",
        jar_name: "Solana",
        thesis: "Mostly SOL, plus Solana ecosystem tokens once Honey can buy them.",
        picks: &[
            pick("SOL", "Solana", 60),
            pick("JUP", "Solana", 20),
            pick("JTO", "Solana", 10),
            pick("PYTH", "Solana", 10),
        ],
    },
    Strategy {
        handle: "honey_bluechip",
        display_name: "Honey Blue Chips",
        avatar_seed: "honey-bluechip",
        bio: "Run by Honey. One jar of bitcoin, ether and SOL.",
        jar_name: "Blue chips",
        thesis: "The three largest crypto networks, weighted toward bitcoin.",
        picks: &[
            pick("cbBTC", "Base", 40),
            pick("ETH", "Base", 35),
            pick("SOL", "Solana", 25),
        ],
    },
    Strategy {
        handle: "honey_l2",
        display_name: "Honey L2s",
        avatar_seed: "honey-l2",
        bio: "Run by Honey. One jar of Ethereum layer-2 network tokens.",
        jar_name: "Ethereum L2s",
        thesis: "The tokens of Ethereum's main scaling networks: Arbitrum, Optimism and Polygon.",
        picks: &[
            pick("ARB", "Arbitrum", 40),
            pick("OP", "Optimism", 35),
            pick("POL", "Polygon", 25),
        ],
    },
];

/// A strategy's picks that are buyable on `list`, rescaled to whole weights summing to
/// 100 (the largest takes the rounding), and the ones skipped ("TAO on Ethereum").
pub fn seeded_picks(strategy: &Strategy, list: &[MarketListToken]) -> (Vec<Pick>, Vec<String>) {
    let mut kept = Vec::new();
    let mut skipped = Vec::new();
    for p in strategy.picks {
        let pick = Pick {
            symbol: p.symbol.to_string(),
            chain: p.chain.to_string(),
            weight: f64::from(p.weight),
            // Honey's strategies hold NEAR Intents tokens only, never a DEX contract.
            address: None,
        };
        if buyable_picks(std::slice::from_ref(&pick), list, &[]).is_ok() {
            kept.push((pick, p.weight));
        } else {
            skipped.push(format!("{} on {}", p.symbol, p.chain));
        }
    }
    let total: u32 = kept.iter().map(|(_, w)| w).sum();
    if total == 0 {
        return (Vec::new(), skipped);
    }
    let mut picks: Vec<Pick> = kept
        .into_iter()
        .map(|(mut pick, w)| {
            pick.weight = (f64::from(w) * 100.0 / f64::from(total)).round();
            pick
        })
        .collect();
    let sum: f64 = picks.iter().map(|p| p.weight).sum();
    if let Some(largest) = picks
        .iter_mut()
        .max_by(|a, b| a.weight.total_cmp(&b.weight))
    {
        largest.weight += 100.0 - sum;
    }
    (picks, skipped)
}

/// What the seed did for one account.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeededAccount {
    pub handle: String,
    pub user_id: Option<Uuid>,
    /// Created by this run (false: it existed and was updated).
    pub created: bool,
    pub jar_id: Option<Uuid>,
    /// The picks published (or, on a dry run, that would be).
    pub picks: Vec<Pick>,
    /// Picks left out because Honey can't buy them today.
    pub skipped: Vec<String>,
    /// Why this account or its jar wasn't (re)seeded; the rest of the run goes on.
    pub error: Option<String>,
}

/// What one run of `honey-server seed-honey-strategies` did.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeedReport {
    pub dry_run: bool,
    pub accounts: Vec<SeededAccount>,
}

/// Creates or updates the Honey strategy accounts (`STRATEGIES`) and publishes each
/// one's jar at 1Click's prices now. Idempotent: a second run with nothing changed
/// changes nothing but the accounts' text. A handle someone else already holds is
/// never taken over: that account is reported and skipped. A dry run only reads the
/// 1Click list and reports what it would publish.
pub async fn seed(
    pool: &PgPool,
    market: &Arc<MarketData>,
    dry_run: bool,
) -> Result<SeedReport, AppError> {
    let tokens = market.tokens().await.map_err(|_| AppError::Busy)?;
    let list = market_list(&tokens);
    let mut report = SeedReport {
        dry_run,
        accounts: Vec::with_capacity(STRATEGIES.len()),
    };
    for strategy in STRATEGIES {
        let (picks, skipped) = seeded_picks(strategy, &list);
        for missing in &skipped {
            tracing::warn!(
                handle = strategy.handle,
                pick = %missing,
                "Honey strategy pick isn't buyable through Honey; skipped"
            );
        }
        let mut account = SeededAccount {
            handle: strategy.handle.to_string(),
            picks: picks.clone(),
            skipped,
            ..SeededAccount::default()
        };
        if picks.is_empty() {
            account.error = Some("none of its picks are buyable; jar left as it was".into());
        } else if let Err(error) = validate_picks(&picks) {
            account.error = Some(format!("invalid picks: {error:?}"));
        }
        if dry_run {
            report.accounts.push(account);
            continue;
        }
        match upsert_account(pool, strategy).await {
            Ok(Some((user, created))) => {
                account.user_id = Some(user);
                account.created = created;
            }
            Ok(None) => {
                account.error = Some("the handle belongs to someone else; not taken over".into());
                report.accounts.push(account);
                continue;
            }
            Err(error) => return Err(error),
        }
        if account.error.is_none() {
            let body = PublishRequest {
                client_id: JAR_CLIENT_ID.to_string(),
                name: strategy.jar_name.to_string(),
                thesis: strategy.thesis.to_string(),
                picks,
                copy_fee: COPY_FEE,
                hide_picks: false,
            };
            let user = account.user_id.unwrap_or_default();
            match publish_with(pool, Some(market), None, user, &body, None).await {
                Ok((id, _)) => account.jar_id = Some(id),
                Err(error) => account.error = Some(format!("jar not published: {error:?}")),
            }
        }
        report.accounts.push(account);
    }
    Ok(report)
}

/// The strategy's account: created (with a bare `users` row: no wallet, no identity)
/// or its text brought up to date and everything shown. None when a person already
/// holds the handle.
async fn upsert_account(
    pool: &PgPool,
    strategy: &Strategy,
) -> Result<Option<(Uuid, bool)>, AppError> {
    let mut tx = pool.begin().await.map_err(unavailable)?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(SEED_LOCK)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
    let existing: Option<(Uuid, bool)> =
        sqlx::query_as("SELECT user_id, official FROM social_profiles WHERE handle = $1")
            .bind(strategy.handle)
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?;
    let out = match existing {
        Some((_, false)) => None,
        Some((user, true)) => {
            sqlx::query(
                "UPDATE social_profiles SET display_name = $2, bio = $3, avatar_seed = $4,
                   share_trades = false, public_profile = true, show_holdings = true,
                   show_returns = true, allow_copy = true, updated_at = clock_timestamp()
                 WHERE user_id = $1",
            )
            .bind(user)
            .bind(strategy.display_name)
            .bind(strategy.bio)
            .bind(strategy.avatar_seed)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
            Some((user, false))
        }
        None => {
            let user = Uuid::new_v4();
            sqlx::query("INSERT INTO users (id) VALUES ($1)")
                .bind(user)
                .execute(&mut *tx)
                .await
                .map_err(unavailable)?;
            sqlx::query(
                "INSERT INTO social_profiles
                   (user_id, handle, display_name, bio, avatar_seed, official)
                 VALUES ($1, $2, $3, $4, $5, true)",
            )
            .bind(user)
            .bind(strategy.handle)
            .bind(strategy.display_name)
            .bind(strategy.bio)
            .bind(strategy.avatar_seed)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
            Some((user, true))
        }
    };
    tx.commit().await.map_err(unavailable)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::social::{normalize_handle, plain_text, reserved};

    fn listed(symbol: &str, chains: Vec<&'static str>) -> MarketListToken {
        MarketListToken {
            symbol: symbol.into(),
            price_usd: 1.0,
            chains,
        }
    }

    #[test]
    fn every_strategy_is_a_valid_plainly_described_honey_account() {
        assert_eq!(STRATEGIES.len(), 5);
        let mut handles = std::collections::HashSet::new();
        for s in STRATEGIES {
            assert_eq!(normalize_handle(s.handle).as_deref(), Some(s.handle));
            assert!(s.handle.starts_with(HANDLE_PREFIX), "{}", s.handle);
            assert!(handles.insert(s.handle));
            // People can't claim it, so nobody can pose as one.
            assert!(reserved(s.handle), "{}", s.handle);
            assert!(s.display_name.starts_with("Honey "), "{}", s.display_name);
            assert!(s.display_name.chars().count() <= 40 && plain_text(s.display_name, false));
            // One line that says Honey runs it.
            assert!(s.bio.starts_with("Run by Honey."), "{}", s.bio);
            assert!(s.bio.chars().count() <= 160 && plain_text(s.bio, false));
            assert!(s.avatar_seed.len() <= 64 && !s.avatar_seed.is_empty());
            assert!(!s.jar_name.is_empty() && s.jar_name.chars().count() <= 60);
            // One sentence, no hype.
            assert!(s.thesis.chars().count() <= 280 && plain_text(s.thesis, false));
            assert_eq!(s.thesis.matches(". ").count(), 0, "{}", s.thesis);
            for word in ["guaranteed", "moon", "100x", "risk-free", "!"] {
                assert!(!s.thesis.to_lowercase().contains(word), "{}", s.thesis);
                assert!(!s.bio.to_lowercase().contains(word), "{}", s.bio);
            }
            let all: Vec<Pick> = s
                .picks
                .iter()
                .map(|p| Pick {
                    symbol: p.symbol.into(),
                    chain: p.chain.into(),
                    weight: f64::from(p.weight),
                    address: None,
                })
                .collect();
            assert_eq!(s.picks.iter().map(|p| p.weight).sum::<u32>(), 100);
            validate_picks(&all).unwrap();
        }
    }

    #[test]
    fn unbuyable_picks_are_skipped_and_the_rest_rescaled_to_100() {
        let ai = STRATEGIES.iter().find(|s| s.handle == "honey_ai").unwrap();
        // As 1Click listed it on 2026-11-14: no TAO, RENDER or FET on Honey's chains.
        let list = vec![
            listed("NEAR", vec!["BSC", "NEAR"]),
            listed("VVV", vec!["Base"]),
            listed("KAITO", vec!["Base"]),
        ];
        let (picks, skipped) = seeded_picks(ai, &list);
        assert_eq!(
            skipped,
            vec!["TAO on Ethereum", "RENDER on Solana", "FET on Ethereum"]
        );
        let weights: Vec<(&str, f64)> = picks
            .iter()
            .map(|p| (p.symbol.as_str(), p.weight))
            .collect();
        assert_eq!(
            weights,
            vec![("NEAR", 55.0), ("VVV", 27.0), ("KAITO", 18.0)]
        );
        validate_picks(&picks).unwrap();

        // Everything buyable: the weights as written.
        let l2 = STRATEGIES.iter().find(|s| s.handle == "honey_l2").unwrap();
        let list = vec![
            listed("ARB", vec!["Arbitrum"]),
            listed("OP", vec!["Optimism"]),
            listed("POL", vec!["Polygon"]),
        ];
        let (picks, skipped) = seeded_picks(l2, &list);
        assert!(skipped.is_empty());
        assert_eq!(
            picks.iter().map(|p| p.weight).collect::<Vec<_>>(),
            vec![40.0, 35.0, 25.0]
        );
        // A token on the wrong chain isn't buyable there.
        let list = vec![listed("ARB", vec!["Ethereum"])];
        let (picks, skipped) = seeded_picks(l2, &list);
        assert!(picks.is_empty());
        assert_eq!(skipped.len(), 3);

        // Rounding always lands on exactly 100.
        let sol = STRATEGIES
            .iter()
            .find(|s| s.handle == "honey_solana")
            .unwrap();
        let list = vec![
            listed("SOL", vec!["Solana"]),
            listed("JTO", vec!["Solana"]),
            listed("PYTH", vec!["Solana"]),
        ];
        let (picks, _) = seeded_picks(sol, &list);
        assert_eq!(picks.iter().map(|p| p.weight).sum::<f64>(), 100.0);
        validate_picks(&picks).unwrap();
    }

    #[test]
    fn the_switch_defaults_on_and_fails_closed() {
        assert_eq!(
            HoneyStrategies::parse(None, None),
            HoneyStrategies::default()
        );
        let d = HoneyStrategies::default();
        assert!(d.enabled && d.min_organic == 10);
        for off in ["0", "false", "OFF", " no "] {
            assert!(!HoneyStrategies::parse(Some(off), None).enabled, "{off}");
        }
        for on in ["1", "true", "On", "yes", ""] {
            assert!(HoneyStrategies::parse(Some(on), None).enabled, "{on}");
        }
        // A typo in a kill switch hides them rather than leaving them up.
        assert!(!HoneyStrategies::parse(Some("disabled"), None).enabled);
        assert_eq!(HoneyStrategies::parse(None, Some("3")).min_organic, 3);
        assert_eq!(HoneyStrategies::parse(None, Some("lots")).min_organic, 10);
        assert_eq!(HoneyStrategies::parse(None, Some("-4")).min_organic, 0);
    }

    #[test]
    fn honeys_jars_are_boosted_until_people_have_enough_of_their_own() {
        let on = HoneyStrategies::parse(None, Some("10"));
        assert!(on.boosted(0) && on.boosted(9));
        assert!(!on.boosted(10) && !on.boosted(50));
        let off = HoneyStrategies::parse(Some("0"), Some("10"));
        assert!(!off.boosted(0));
    }
}
