//! Pick, critic, size and quote. The model chooses only from code-built closed candidate
//! lists (one enum per exposure) and the critic may only shrink or drop picks; weights,
//! amounts and every asset come from code. Risk checks only shrink a position, and what
//! they trim stays in USDC (`cash_pct`), never moves to the other picks.

use super::{
    Risk, banned_phrase,
    quote::Quoter,
    registry::{InstrumentType, RegistryAsset},
    shortlist::{Coin, ExposureCandidates, Market},
    suspicious,
};
use crate::market_data::normalize_symbol;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const MAX_PER_EXPOSURE: usize = 2;
pub const MAX_REASON: usize = 300;
const MAX_BEAR: usize = 4;
const MAX_NOTES: usize = 6;
const MAX_ISSUES: usize = 12;
const MAX_DOWNWEIGHTS: usize = 2;
/// Minimum order so fees stay a small share of each order (R-RK-2).
/// Small enough that a $5 test run can still split into a few picks.
pub const MIN_ORDER_USD: f64 = 1.0;
/// Quote rounds: a pick that can't be quoted is dropped and the rest re-sized and re-quoted.
const QUOTE_ROUNDS: usize = 3;
pub const ISSUE_TYPES: &[&str] = &[
    "duplicate",
    "concentration",
    "off_theme",
    "illiquid",
    "meme",
];
pub const ISSUE_ACTIONS: &[&str] = &["drop", "downweight", "keep"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Conviction {
    High,
    Medium,
    Low,
}

impl Conviction {
    pub fn weight(self) -> u32 {
        match self {
            Conviction::High => 3,
            Conviction::Medium => 2,
            Conviction::Low => 1,
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "high" => Some(Self::High),
            "medium" => Some(Self::Medium),
            "low" => Some(Self::Low),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickQuote {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_out: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyPick {
    pub asset: RegistryAsset,
    pub exposure: String,
    pub weight_pct: u32,
    pub amount_usd: f64,
    /// direct: the registry asset is the named instrument; proxy: a stand-in (stablecoins).
    pub r#match: &'static str,
    pub reason: String,
    pub conviction: Conviction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market: Option<Market>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<PickQuote>,
    /// For dedupe, trims and re-sizing; not part of the API.
    #[serde(skip)]
    pub coin_key: String,
    #[serde(skip)]
    pub ticker: String,
    /// Share of its sized weight a risk check keeps (1.0, 0.5 after a downweight).
    #[serde(skip)]
    pub keep: f64,
    /// Whether the coin passes the low, medium and high risk rules.
    #[serde(skip)]
    pub allowed: [bool; 3],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unmatched {
    pub idea: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticReport {
    /// ok, revised or skipped.
    pub verdict: &'static str,
    pub notes: Vec<String>,
}

/// Strategy/1 (the proposal). Fields after `quoted` were added with the harness and are
/// optional for older readers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Strategy {
    pub version: &'static str,
    pub picks: Vec<StrategyPick>,
    pub unmatched: Vec<Unmatched>,
    /// Strings in model output that looked like addresses or instructions, or tickers
    /// outside the candidate lists, ignored.
    pub ignored: Vec<String>,
    /// Every pick has a successful dry quote.
    pub quoted: bool,
    pub bear_case: Vec<String>,
    pub critic: Option<CriticReport>,
    pub prompt_versions: BTreeMap<String, String>,
    /// Percent of the amount kept in USDC because a risk check trimmed a position.
    pub cash_pct: u32,
    /// Plain sentence for the user when the proposal is empty or holds cash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The same run sized for every risk level (the top level is the one asked for), so
    /// the app can switch levels without a new run. Absent inside the variants.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_risk: Option<Box<ByRisk>>,
    /// The pages the run read, numbered as the `[n]` markers in the thesis rationale and
    /// bear case cite them. On the top level only.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<super::citations::Source>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ByRisk {
    pub low: Strategy,
    pub medium: Strategy,
    pub high: Strategy,
}

pub const RISKS: [Risk; 3] = [Risk::Low, Risk::Medium, Risk::High];

fn risk_index(risk: Risk) -> usize {
    match risk {
        Risk::Low => 0,
        Risk::Medium => 1,
        Risk::High => 2,
    }
}

pub fn risk_name(risk: Risk) -> &'static str {
    match risk {
        Risk::Low => "low",
        Risk::Medium => "medium",
        Risk::High => "high",
    }
}

/// A candidate the pick step chose.
#[derive(Debug, Clone)]
pub struct Chosen {
    pub coin: Coin,
    pub exposure: String,
    pub reason: String,
    pub conviction: Conviction,
}

/// One property per exposure id; each pick's ticker is an enum of that exposure's own
/// candidates, so the closed set is in the schema the model reads.
pub fn pick_schema(lists: &[ExposureCandidates]) -> Value {
    let mut properties = Map::new();
    for l in lists {
        let tickers: Vec<&str> = l.candidates.iter().map(|c| c.ticker.as_str()).collect();
        properties.insert(
            l.id.clone(),
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["picks"],
                "properties": {
                    "picks": {
                        "type": "array",
                        "maxItems": if tickers.is_empty() { 0 } else { MAX_PER_EXPOSURE },
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["ticker", "reason", "conviction"],
                            "properties": {
                                "ticker": {"type": "string", "enum": tickers},
                                "reason": {"type": "string", "maxLength": MAX_REASON},
                                "conviction": {"type": "string", "enum": ["high", "medium", "low"]}
                            }
                        }
                    },
                    "none": {"type": "string", "maxLength": MAX_REASON, "description": "why nothing fits, when picks is empty"}
                }
            }),
        );
    }
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": lists.iter().map(|l| l.id.clone()).collect::<Vec<_>>(),
        "properties": properties,
    })
}

fn str_field<'a>(v: &'a Value, field: &str, max: usize) -> Result<&'a str, String> {
    let s = v
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {field}"))?;
    if s.chars().count() > max {
        return Err(format!("{field} is longer than {max} characters"));
    }
    Ok(s)
}

fn no_promises(text: &str) -> Result<(), String> {
    match banned_phrase(text) {
        Some(p) => Err(format!(
            "\"{p}\" promises an outcome; describe it without promises"
        )),
        None => Ok(()),
    }
}

/// Structure only: tickers outside a list are dropped by `apply_picks`, not retried.
pub fn validate_pick(value: &Value) -> Result<(), String> {
    let exposures = value
        .as_object()
        .ok_or("expected an object keyed by exposure id")?;
    for (id, entry) in exposures {
        if id.len() > 4 || !id.starts_with('e') {
            return Err(format!("unknown key {id}; use the exposure ids"));
        }
        let picks = entry
            .get("picks")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{id} needs a picks array"))?;
        for p in picks {
            str_field(p, "ticker", 32)?;
            let reason = str_field(p, "reason", MAX_REASON)?;
            if reason.trim().is_empty() {
                return Err("empty reason".into());
            }
            no_promises(reason)?;
            Conviction::parse(str_field(p, "conviction", 8)?)
                .ok_or("conviction must be high, medium or low")?;
        }
    }
    Ok(())
}

/// The model's picks, checked against each exposure's own candidate list. Anything else
/// (another list's ticker, an invented one, an address) goes to `ignored`. Also returns
/// each exposure's "nothing fits" reason.
pub fn apply_picks(
    lists: &[ExposureCandidates],
    value: &Value,
) -> (Vec<Chosen>, Vec<String>, BTreeMap<String, String>) {
    let mut chosen: Vec<Chosen> = Vec::new();
    let mut ignored = Vec::new();
    let mut abstained = BTreeMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    for list in lists {
        let entry = &value[&list.id];
        if let Some(why) = entry["none"].as_str().filter(|s| !s.trim().is_empty()) {
            abstained.insert(list.id.clone(), clip(why, MAX_REASON));
        }
        let mut count = 0;
        for p in entry["picks"].as_array().into_iter().flatten() {
            let ticker = p["ticker"].as_str().unwrap_or_default();
            if suspicious(ticker) {
                ignored.push(ticker.chars().take(80).collect());
                continue;
            }
            let Some(coin) = list.find(ticker) else {
                ignored.push(format!("{ticker} (not on the list for {})", list.label));
                continue;
            };
            // Duplicates of a coin already chosen (any exposure) are skipped in code.
            if count >= MAX_PER_EXPOSURE || !seen.insert(coin.key.clone()) {
                continue;
            }
            count += 1;
            chosen.push(Chosen {
                coin: coin.clone(),
                exposure: list.label.clone(),
                reason: clip(p["reason"].as_str().unwrap_or_default(), MAX_REASON),
                conviction: Conviction::parse(p["conviction"].as_str().unwrap_or_default())
                    .unwrap_or(Conviction::Low),
            });
        }
    }
    for key in value.as_object().into_iter().flat_map(|o| o.keys()) {
        if !lists.iter().any(|l| &l.id == key) {
            ignored.push(format!(
                "{} (unknown exposure)",
                key.chars().take(8).collect::<String>()
            ));
        }
    }
    (chosen, ignored, abstained)
}

/// DRY_RUN picks: the first candidate of each exposure, medium conviction.
pub fn fixture_picks(lists: &[ExposureCandidates]) -> Value {
    let mut out = Map::new();
    for l in lists {
        let picks: Vec<Value> = l
            .candidates
            .first()
            .map(|c| {
                json!({
                    "ticker": c.ticker,
                    "reason": "Sample pick (DRY_RUN): the first buyable match for this part of the idea.",
                    "conviction": "medium",
                })
            })
            .into_iter()
            .collect();
        out.insert(l.id.clone(), json!({ "picks": picks }));
    }
    Value::Object(out)
}

pub fn critic_schema(tickers: &[String]) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["bearCase", "issues"],
        "properties": {
            "bearCase": {"type": "array", "minItems": 2, "maxItems": MAX_BEAR, "items": {"type": "string", "maxLength": MAX_REASON}},
            "issues": {
                "type": "array",
                "maxItems": MAX_ISSUES,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "ticker", "action", "note"],
                    "properties": {
                        "type": {"type": "string", "enum": ISSUE_TYPES},
                        "ticker": {"type": "string", "enum": tickers},
                        "action": {"type": "string", "enum": ISSUE_ACTIONS},
                        "note": {"type": "string", "maxLength": MAX_REASON}
                    }
                }
            },
            "notes": {"type": "array", "maxItems": MAX_NOTES, "items": {"type": "string", "maxLength": MAX_REASON}}
        }
    })
}

fn strings(v: &Value, field: &str, min: usize, max: usize) -> Result<Vec<String>, String> {
    let Some(items) = v.get(field).and_then(Value::as_array) else {
        return if min == 0 {
            Ok(Vec::new())
        } else {
            Err(format!("missing {field} array"))
        };
    };
    if items.len() < min || items.len() > max {
        return Err(format!("{field} needs {min}-{max} items"));
    }
    items
        .iter()
        .map(|i| {
            let s = i
                .as_str()
                .ok_or_else(|| format!("{field} items must be strings"))?;
            if s.trim().is_empty() || s.chars().count() > MAX_REASON {
                return Err(format!("{field} items must be 1-{MAX_REASON} characters"));
            }
            no_promises(s)?;
            Ok(s.trim().to_string())
        })
        .collect()
}

pub fn validate_critic(value: &Value) -> Result<(), String> {
    strings(value, "bearCase", 2, MAX_BEAR)?;
    strings(value, "notes", 0, MAX_NOTES)?;
    let issues = value
        .get("issues")
        .and_then(Value::as_array)
        .ok_or("missing issues array")?;
    if issues.len() > MAX_ISSUES {
        return Err(format!("at most {MAX_ISSUES} issues"));
    }
    for i in issues {
        if !ISSUE_TYPES.contains(&str_field(i, "type", 16)?) {
            return Err(format!(
                "issue type must be one of {}",
                ISSUE_TYPES.join(", ")
            ));
        }
        if !ISSUE_ACTIONS.contains(&str_field(i, "action", 16)?) {
            return Err(format!(
                "issue action must be one of {}",
                ISSUE_ACTIONS.join(", ")
            ));
        }
        str_field(i, "ticker", 32)?;
        no_promises(str_field(i, "note", MAX_REASON)?)?;
    }
    Ok(())
}

/// What the critic decided, applied by code: drops leave the basket (their share stays in
/// USDC), downweights halve a position (the other half stays in USDC). It can never add.
pub struct CriticOutcome {
    pub kept: Vec<Chosen>,
    pub dropped: Vec<Unmatched>,
    /// Coin keys and the share of their sized weight to keep (0.0 dropped, 0.5 halved).
    pub trims: Vec<(String, f64)>,
    pub report: CriticReport,
    pub bear_case: Vec<String>,
}

pub fn apply_critic(chosen: Vec<Chosen>, value: &Value) -> CriticOutcome {
    let bear_case = strings(value, "bearCase", 0, MAX_BEAR).unwrap_or_default();
    let mut notes = Vec::new();
    let mut trims: Vec<(String, f64)> = Vec::new();
    let mut drop_why: BTreeMap<String, String> = BTreeMap::new();
    for issue in value["issues"].as_array().into_iter().flatten() {
        let ticker = normalize_symbol(issue["ticker"].as_str().unwrap_or_default());
        let Some(pick) = chosen
            .iter()
            .find(|c| c.coin.ticker.eq_ignore_ascii_case(ticker))
        else {
            continue; // Not one of the picks: the critic can't touch anything else.
        };
        let kind = issue["type"].as_str().unwrap_or_default();
        let note = clip(issue["note"].as_str().unwrap_or_default(), MAX_REASON);
        match issue["action"].as_str().unwrap_or_default() {
            "drop" => {
                drop_why
                    .entry(pick.coin.key.clone())
                    .or_insert(note.clone());
                trims.retain(|(k, _)| k != &pick.coin.key);
                trims.push((pick.coin.key.clone(), 0.0));
            }
            // At most two downweights: the risk caps already bound every position.
            "downweight"
                if !drop_why.contains_key(&pick.coin.key)
                    && trims.iter().filter(|(_, k)| *k > 0.0).count() < MAX_DOWNWEIGHTS =>
            {
                if !trims.iter().any(|(k, _)| k == &pick.coin.key) {
                    trims.push((pick.coin.key.clone(), 0.5));
                }
                notes.push(format!(
                    "{} kept at half size ({}): {note}",
                    pick.coin.ticker,
                    kind.replace('_', " ")
                ));
                continue;
            }
            _ => {}
        }
        if !note.is_empty() && !drop_why.contains_key(&pick.coin.key) {
            notes.push(format!("{}: {note}", pick.coin.ticker));
        }
    }
    notes.extend(strings(value, "notes", 0, MAX_NOTES).unwrap_or_default());
    let mut kept = Vec::new();
    let mut dropped = Vec::new();
    for c in chosen {
        match drop_why.get(&c.coin.key) {
            Some(why) => dropped.push(Unmatched {
                idea: c.exposure.clone(),
                note: format!(
                    "{} was dropped by the second-opinion check: {why}",
                    c.coin.ticker
                ),
            }),
            None => kept.push(c),
        }
    }
    let verdict = if trims.is_empty() { "ok" } else { "revised" };
    CriticOutcome {
        kept,
        dropped,
        trims,
        report: CriticReport { verdict, notes },
        bear_case,
    }
}

pub struct RiskRules {
    pub max_assets: usize,
    pub max_weight: u32,
}

pub fn rules(risk: Risk) -> RiskRules {
    match risk {
        Risk::Low => RiskRules {
            max_assets: 2,
            max_weight: 60,
        },
        Risk::Medium => RiskRules {
            max_assets: 3,
            max_weight: 50,
        },
        Risk::High => RiskRules {
            max_assets: 5,
            max_weight: 40,
        },
    }
}

/// A chosen candidate as a pick. `checked`: market data was there, so each risk level's
/// rules apply; without it (DRY_RUN) every level may hold it.
pub fn to_pick(c: Chosen, checked: bool) -> StrategyPick {
    let allowed = if checked {
        RISKS.map(|r| c.coin.allowed_at(r))
    } else {
        [true; 3]
    };
    StrategyPick {
        allowed,
        r#match: if c.coin.kind() == InstrumentType::Stablecoin {
            "proxy"
        } else {
            "direct"
        },
        market: Some(c.coin.market.clone()),
        coin_key: c.coin.key.clone(),
        ticker: c.coin.ticker.clone(),
        asset: c.coin.asset,
        exposure: c.exposure,
        weight_pct: 0,
        amount_usd: 0.0,
        reason: c.reason,
        conviction: c.conviction,
        quote: None,
        keep: 1.0,
    }
}

/// Integer weights from conviction: proportional, then each scaled by its `keep` share and
/// clamped to `cap`. Nothing trimmed is redistributed; the rest of 100 is cash.
pub fn weights(raw: &[u32], keep: &[f64], cap: u32) -> Vec<u32> {
    let total: u32 = raw.iter().sum();
    if total == 0 {
        return vec![0; raw.len()];
    }
    let base: Vec<f64> = raw
        .iter()
        .map(|r| 100.0 * *r as f64 / total as f64)
        .collect();
    // Largest-remainder rounding of the untrimmed split (sums to 100), then shrink only.
    let mut out: Vec<u32> = base.iter().map(|v| (v + 1e-9).floor() as u32).collect();
    let mut rest = 100 - out.iter().sum::<u32>();
    let mut order: Vec<usize> = (0..raw.len()).collect();
    order.sort_by(|&a, &b| {
        (base[b] - base[b].floor())
            .total_cmp(&(base[a] - base[a].floor()))
            .then(a.cmp(&b))
    });
    for i in order {
        if rest == 0 {
            break;
        }
        out[i] += 1;
        rest -= 1;
    }
    out.iter()
        .zip(keep)
        .map(|(w, k)| ((*w as f64 * k).floor() as u32).min(cap))
        .collect()
}

/// Conviction weights (3/2/1) within the risk caps. Too many picks or orders under the
/// minimum drop the lowest-conviction picks into `unmatched` (fewer assets, re-split).
/// Caps and critic trims (`keep` < 1; 0 for a dropped pick, which still counts in the
/// split) only shrink, and what they trim is returned as cash.
pub fn size(
    mut picks: Vec<StrategyPick>,
    amount_usd: f64,
    risk: Risk,
) -> (Vec<StrategyPick>, Vec<Unmatched>, u32) {
    let rules = rules(risk);
    let mut unmatched = Vec::new();
    // Highest conviction first; ties keep the exposure order.
    picks.sort_by_key(|p| std::cmp::Reverse(p.conviction.weight()));
    let live = |picks: &[StrategyPick]| picks.iter().filter(|p| p.keep > 0.0).count();
    while live(&picks) > rules.max_assets {
        let i = picks.iter().rposition(|p| p.keep > 0.0).expect("non-empty");
        let p = picks.remove(i);
        unmatched.push(Unmatched {
            idea: p.exposure,
            note: format!(
                "{} was left out to stay within this risk level's {} picks.",
                p.ticker, rules.max_assets
            ),
        });
    }
    loop {
        let raw: Vec<u32> = picks.iter().map(|p| p.conviction.weight()).collect();
        let keep: Vec<f64> = picks.iter().map(|p| p.keep).collect();
        let w = weights(&raw, &keep, rules.max_weight);
        for (p, w) in picks.iter_mut().zip(&w) {
            p.weight_pct = *w;
            p.amount_usd = (amount_usd * *w as f64 / 100.0 * 100.0).round() / 100.0;
        }
        let small = picks
            .iter()
            .enumerate()
            .filter(|(_, p)| p.keep > 0.0)
            .min_by(|a, b| a.1.weight_pct.cmp(&b.1.weight_pct).then(b.0.cmp(&a.0)));
        if let Some((i, p)) = small
            && live(&picks) > 1
            && p.amount_usd < MIN_ORDER_USD
        {
            let p = picks.remove(i);
            unmatched.push(Unmatched {
                idea: p.exposure,
                note: format!(
                    "{} was left out: ${amount_usd:.0} is too small to split this many ways (each order needs at least ${MIN_ORDER_USD:.0}).",
                    p.ticker
                ),
            });
            continue;
        }
        break;
    }
    picks.retain(|p| p.weight_pct > 0 && p.keep > 0.0);
    let cash = if picks.is_empty() {
        0
    } else {
        100 - picks.iter().map(|p| p.weight_pct).sum::<u32>()
    };
    (picks, unmatched, cash)
}

/// Atomic units of `asset` for `usd` (the origin is a dollar stablecoin).
fn atomic_usd(usd: f64, decimals: u8) -> u128 {
    (usd * 10f64.powi(decimals as i32)).round().max(0.0) as u128
}

fn cents(usd: f64) -> u64 {
    (usd * 100.0).round().max(0.0) as u64
}

/// One risk level's sizing of the shared, ranked picks.
#[derive(Debug, Clone)]
pub struct Variant {
    pub risk: Risk,
    pub picks: Vec<StrategyPick>,
    pub unmatched: Vec<Unmatched>,
    pub cash_pct: u32,
}

#[derive(Debug, Default)]
pub struct QuoteLog {
    /// Distinct tokens quoted.
    pub tokens: usize,
    /// Tickers that couldn't be quoted, with why.
    pub failed: Vec<(String, String)>,
}

fn build(
    base: &[StrategyPick],
    failed: &BTreeMap<String, (String, String)>,
    amount_usd: f64,
    risk: Risk,
) -> Variant {
    let mut unmatched = Vec::new();
    let picks: Vec<StrategyPick> = base
        .iter()
        .filter(|p| {
            if let Some((_, why)) = failed.get(&p.coin_key) {
                if p.keep > 0.0 {
                    unmatched.push(Unmatched {
                        idea: p.exposure.clone(),
                        note: format!(
                            "{} was left out: Honey couldn't get a live price to buy it ({why}).",
                            p.ticker
                        ),
                    });
                }
                return false;
            }
            if !p.allowed[risk_index(risk)] {
                if p.keep > 0.0 {
                    unmatched.push(Unmatched {
                        idea: p.exposure.clone(),
                        note: format!(
                            "{} is left out at {} risk: it is smaller or riskier than this level allows.",
                            p.ticker,
                            risk_name(risk)
                        ),
                    });
                }
                return false;
            }
            true
        })
        .cloned()
        .collect();
    let (picks, more, cash_pct) = size(picks, amount_usd, risk);
    unmatched.extend(more);
    Variant {
        risk,
        picks,
        unmatched,
        cash_pct,
    }
}

/// Sizes the shared ranked picks for low, medium and high risk (code only), then dry-quotes
/// the union once, in parallel: one quote per distinct token and amount. A token that can't
/// be quoted leaves every level and the levels are re-sized and the new amounts quoted.
/// Without a quoter (DRY_RUN) picks carry no quote.
pub async fn variants(
    base: &[StrategyPick],
    amount_usd: f64,
    origin: Option<&RegistryAsset>,
    quoter: Option<&dyn Quoter>,
) -> (Vec<Variant>, QuoteLog) {
    let mut failed: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut quotes: HashMap<(String, u64), Result<super::quote::DryQuote, String>> = HashMap::new();
    let mut log = QuoteLog::default();
    let mut tokens: HashSet<String> = HashSet::new();
    for _ in 0..QUOTE_ROUNDS {
        let out: Vec<Variant> = RISKS
            .iter()
            .map(|r| build(base, &failed, amount_usd, *r))
            .collect();
        let (Some(quoter), Some(origin)) = (quoter, origin) else {
            break;
        };
        let mut needed: Vec<&StrategyPick> = Vec::new();
        let mut seen = HashSet::new();
        for p in out.iter().flat_map(|v| &v.picks) {
            let key = (p.asset.asset_id.clone(), cents(p.amount_usd));
            if !quotes.contains_key(&key) && seen.insert(key) {
                needed.push(p);
            }
        }
        if needed.is_empty() {
            break;
        }
        tokens.extend(needed.iter().map(|p| p.asset.asset_id.clone()));
        let results = futures_util::future::join_all(needed.iter().map(|p| async move {
            if p.asset.asset_id == origin.asset_id {
                return Ok(super::quote::DryQuote {
                    amount_out: format!("{:.2}", p.amount_usd),
                });
            }
            quoter
                .dry_quote(origin, &p.asset, atomic_usd(p.amount_usd, origin.decimals))
                .await
        }))
        .await;
        let mut new_failure = false;
        for (p, result) in needed.iter().zip(results) {
            if let Err(why) = &result
                && !failed.contains_key(&p.coin_key)
            {
                failed.insert(p.coin_key.clone(), (p.ticker.clone(), why.clone()));
                log.failed.push((p.ticker.clone(), why.clone()));
                new_failure = true;
            }
            quotes.insert((p.asset.asset_id.clone(), cents(p.amount_usd)), result);
        }
        if !new_failure {
            break;
        }
    }
    log.tokens = tokens.len();
    let mut out: Vec<Variant> = RISKS
        .iter()
        .map(|r| build(base, &failed, amount_usd, *r))
        .collect();
    if quoter.is_some() {
        for p in out.iter_mut().flat_map(|v| v.picks.iter_mut()) {
            let key = (p.asset.asset_id.clone(), cents(p.amount_usd));
            p.quote = Some(match quotes.get(&key) {
                Some(Ok(q)) => PickQuote {
                    ok: true,
                    amount_out: Some(q.amount_out.clone()),
                    note: None,
                },
                Some(Err(why)) => PickQuote {
                    ok: false,
                    amount_out: None,
                    note: Some(why.clone()),
                },
                None => PickQuote {
                    ok: false,
                    amount_out: None,
                    note: Some(if origin.is_none() {
                        "USDC isn't available to quote from right now.".into()
                    } else {
                        "No live price yet; re-quote before buying.".into()
                    }),
                },
            });
        }
    }
    (out, log)
}

fn clip(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}
