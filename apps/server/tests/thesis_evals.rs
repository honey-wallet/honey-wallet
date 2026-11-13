//! Thesis harness evals on a frozen registry + CoinGecko snapshot (tests/thesis_evals/).
//!
//! - `deterministic_code_stages`: every case through the real pipeline with a stub model
//!   that answers from the case and a mock quoter. Checks what code guarantees (closed
//!   candidate lists, sizing, caps, cash, duplicates, injected addresses, refusals).
//! - `live_scorecard` (ignored): every case against the real model (NEAR_AI_API_KEY),
//!   Linkup news (LINKUP_API_KEY, optional) and real dry 1Click quotes, on the same frozen
//!   snapshot. Prints a scorecard; THESIS_EVAL_OUT=<path> also writes it as Markdown.
//!   THESIS_EVAL_CASES=id,id limits the cases; THESIS_EVAL_RUNS sets the stability runs
//!   (default 3); THESIS_EVAL_CONCURRENCY sets runs at a time (default 4);
//!   THESIS_EVAL_LIVE_MARKETS=1 uses live CoinGecko instead of the snapshot.

use async_trait::async_trait;
use futures_util::StreamExt;
use honey_server::{
    market_data::{CoinMarket, MarketData, parse_coin_markets},
    thesis::{
        FixedMarkets, MarketSource, Params, Risk, RunView, Stage, StartThesis, ThesisService,
        banned_phrase, categories,
        intake::Intake,
        near_ai::NearAi,
        quote::{DryQuote, OneClickQuoter, Quoter},
        registry::{Registry, RegistryAsset, parse_tokens},
        research::Linkup,
        shortlist::coin_key,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    idea: String,
    risk: Risk,
    amount_usd: f64,
    /// proposal | proposal_or_empty | fail_or_empty | any
    outcome: String,
    categories: Vec<String>,
    on_theme: Vec<String>,
    forbidden: Vec<String>,
    #[serde(default)]
    min_picks: Option<usize>,
    #[serde(default)]
    max_picks: Option<usize>,
    #[serde(default)]
    stability: bool,
}

fn cases() -> Vec<Case> {
    let all: Vec<Case> = serde_json::from_str(include_str!("thesis_evals/cases.json")).unwrap();
    match std::env::var("THESIS_EVAL_CASES") {
        Ok(ids) if !ids.trim().is_empty() => {
            let ids: Vec<&str> = ids.split(',').map(str::trim).collect();
            all.into_iter()
                .filter(|c| ids.contains(&c.id.as_str()))
                .collect()
        }
        _ => all,
    }
}

fn registry_assets() -> Vec<RegistryAsset> {
    parse_tokens(&serde_json::from_str(include_str!("thesis_evals/registry.json")).unwrap())
}

fn market_rows() -> HashMap<String, CoinMarket> {
    parse_coin_markets(&serde_json::from_str(include_str!("thesis_evals/markets.json")).unwrap())
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect()
}

fn sym(s: &str) -> String {
    s.trim().trim_start_matches('$').to_ascii_uppercase()
}

/// A pick's names: its asset symbol and its coin's ticker (cbBTC is also BTC).
fn names(pick: &Value) -> Vec<String> {
    let mut out = vec![sym(pick["asset"]["symbol"].as_str().unwrap_or_default())];
    if let Some(id) = pick["asset"]["coingeckoId"].as_str() {
        let rows = market_rows();
        let coin = rows.get(coin_key(id)).or_else(|| rows.get(id));
        if let Some(c) = coin {
            out.push(sym(&c.symbol));
        }
    }
    out
}

fn named(pick: &Value, list: &[String]) -> bool {
    let n = names(pick);
    list.iter().any(|t| n.contains(&sym(t)))
}

fn caps(risk: Risk) -> (usize, u64) {
    match risk {
        Risk::Low => (2, 60),
        Risk::Medium => (3, 50),
        Risk::High => (5, 40),
    }
}

fn picks(view: &RunView) -> Vec<Value> {
    view.proposal
        .as_ref()
        .and_then(|p| p["picks"].as_array().cloned())
        .unwrap_or_default()
}

fn has_address(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("nep141:")
        || lower.contains("nep245:")
        || lower.match_indices("0x").any(|(i, _)| {
            lower[i + 2..]
                .chars()
                .take(8)
                .filter(|c| c.is_ascii_hexdigit())
                .count()
                == 8
        })
}

/// All model-written prose in a run.
fn prose(view: &RunView) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |v: &Value| {
        if let Some(s) = v.as_str() {
            out.push(s.to_string());
        }
    };
    if let Some(t) = &view.thesis {
        push(&t["theme"]);
        push(&t["rationale"]);
        for b in t["bearCase"].as_array().into_iter().flatten() {
            push(b);
        }
        for e in t["exposures"].as_array().into_iter().flatten() {
            push(&e["label"]);
            push(&e["wrongIf"]);
        }
    }
    if let Some(p) = &view.proposal {
        for b in p["bearCase"].as_array().into_iter().flatten() {
            push(b);
        }
        for n in p["critic"]["notes"].as_array().into_iter().flatten() {
            push(n);
        }
        for pick in p["picks"].as_array().into_iter().flatten() {
            push(&pick["reason"]);
        }
    }
    out
}

fn risk_name(risk: Risk) -> &'static str {
    match risk {
        Risk::Low => "low",
        Risk::Medium => "medium",
        Risk::High => "high",
    }
}

/// The gates one sized strategy must pass (the top level or a `byRisk` variant).
fn check_strategy(
    case: &Case,
    p: &Value,
    risk: Risk,
    registry: &[RegistryAsset],
    quotes: bool,
) -> Vec<String> {
    let mut fail = Vec::new();
    let tag = risk_name(risk);
    let picks = p["picks"].as_array().cloned().unwrap_or_default();
    let (max_assets, cap) = caps(risk);
    if picks.len() > max_assets {
        fail.push(format!("{tag}: {} picks > {max_assets}", picks.len()));
    }
    let mut coins = BTreeSet::new();
    let mut total = p["cashPct"].as_u64().unwrap_or(0);
    for pick in &picks {
        let s = sym(pick["asset"]["symbol"].as_str().unwrap_or_default());
        let w = pick["weightPct"].as_u64().unwrap_or(0);
        total += w;
        if w > cap || w == 0 {
            fail.push(format!("{tag}: {s} weight {w}% outside 1-{cap}%"));
        }
        if pick["amountUsd"].as_f64().unwrap_or(0.0) < 1.0 {
            fail.push(format!("{tag}: {s} order under $1"));
        }
        if pick["asset"]["instrumentType"] == "stablecoin" {
            fail.push(format!("{tag}: stablecoin {s} as a pick (should be cash)"));
        }
        let id = pick["asset"]["assetId"].as_str().unwrap_or_default();
        if !registry.iter().any(|a| a.asset_id == id) {
            fail.push(format!("{tag}: {s} not in the registry"));
        }
        let key = pick["asset"]["coingeckoId"]
            .as_str()
            .map(|id| coin_key(id).to_string())
            .unwrap_or_else(|| s.clone());
        if !coins.insert(key) {
            fail.push(format!("{tag}: {s} duplicates another pick"));
        }
        if named(pick, &case.forbidden) {
            fail.push(format!("forbidden pick {s} ({tag})"));
        }
        for field in ["reason", "conviction", "market"] {
            if pick.get(field).is_none() {
                fail.push(format!("{tag}: {s} has no {field}"));
            }
        }
        if quotes && pick["quote"]["ok"] != json!(true) {
            fail.push(format!("{tag}: {s} has no working quote"));
        }
    }
    if total != 100 {
        fail.push(format!("{tag}: weights + cash = {total}"));
    }
    if !picks.is_empty() && p["bearCase"].as_array().is_none_or(|b| b.is_empty()) {
        fail.push(format!("{tag}: no bear case"));
    }
    for u in p["unmatched"].as_array().into_iter().flatten() {
        let note = u["note"].as_str().unwrap_or_default();
        if note.is_empty() || note.chars().count() > 240 || !note.ends_with('.') {
            fail.push(format!("{tag}: unplain note \"{note}\""));
        }
    }
    fail
}

/// Gates that must hold on every run (REFERENCES.md §6 layer 1).
fn hard_checks(
    case: &Case,
    view: &RunView,
    registry: &[RegistryAsset],
    quotes: bool,
) -> Vec<String> {
    let mut fail = Vec::new();
    let picks = picks(view);
    if !matches!(view.stage, Stage::Done | Stage::Failed) {
        fail.push(format!("unfinished: {:?}", view.stage));
    }
    if case.outcome == "fail_or_empty" && !picks.is_empty() {
        fail.push("should have refused or proposed nothing".into());
    }
    // A refusal may quote the user's own words ("a guaranteed 10x"); it promises nothing.
    let refused = view.thesis.as_ref().is_some_and(|t| {
        matches!(
            t["direction"].as_str(),
            Some("rejected" | "unsupported_direction")
        )
    });
    for text in prose(view) {
        if let Some(p) = banned_phrase(&text).filter(|_| !refused) {
            fail.push(format!("banned phrase \"{p}\""));
        }
        if has_address(&text) {
            fail.push("an address in model output".into());
        }
    }
    if let Some(t) = &view.thesis {
        for e in t["exposures"].as_array().into_iter().flatten() {
            let label = e["label"].as_str().unwrap_or_default();
            if label.split_whitespace().count() > 6 {
                fail.push(format!("label over 6 words: {label}"));
            }
        }
    }
    let Some(p) = &view.proposal else {
        return fail;
    };
    if p["promptVersions"].as_object().is_none_or(|o| o.len() < 4) {
        fail.push("promptVersions missing".into());
    }
    if let Some(max) = case.max_picks
        && picks.len() > max
    {
        fail.push(format!("{} picks > case max {max}", picks.len()));
    }
    fail.extend(check_strategy(case, p, case.risk, registry, quotes));
    for risk in [Risk::Low, Risk::Medium, Risk::High] {
        let v = &p["byRisk"][risk_name(risk)];
        if !v.is_object() {
            fail.push(format!("byRisk.{} missing", risk_name(risk)));
            continue;
        }
        fail.extend(check_strategy(case, v, risk, registry, quotes));
    }
    if p["byRisk"][risk_name(case.risk)]["picks"] != p["picks"] {
        fail.push("top level differs from the requested risk level".into());
    }
    fail.sort();
    fail.dedup();
    fail
}

/// Low ⊆ medium ⊆ high (by symbol), the expected shape when no pick was left out of a
/// level for its own rules.
fn nested(p: &Value) -> bool {
    let set = |r: &str| -> BTreeSet<String> {
        p["byRisk"][r]["picks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|x| sym(x["asset"]["symbol"].as_str().unwrap_or_default()))
            .collect()
    };
    set("low").is_subset(&set("medium")) && set("medium").is_subset(&set("high"))
}

fn level_excluded(p: &Value) -> bool {
    ["low", "medium"].iter().any(|r| {
        p["byRisk"][r]["unmatched"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|u| {
                u["note"]
                    .as_str()
                    .is_some_and(|n| n.contains("left out at"))
            })
    })
}

/// Expected categories with at least one pick from them.
fn category_hits(case: &Case, picks: &[Value]) -> (usize, usize) {
    let hits = case
        .categories
        .iter()
        .filter(|c| {
            let Some(cat) = categories::find(c) else {
                return false;
            };
            picks.iter().any(|p| {
                names(p).iter().any(|s| cat.tickers.contains(&s.as_str()))
                    || (c.as_str() == "stablecoins" && p["asset"]["instrumentType"] == "stablecoin")
                    || (c.as_str() == "tokenized_stocks"
                        && p["asset"]["instrumentType"] == "tokenized_stock")
            })
        })
        .count();
    (hits, case.categories.len())
}

fn on_theme_share(case: &Case, picks: &[Value]) -> Option<f64> {
    if case.on_theme.is_empty() || picks.is_empty() {
        return None;
    }
    let total: f64 = picks
        .iter()
        .map(|p| p["weightPct"].as_f64().unwrap_or(0.0))
        .sum();
    let on: f64 = picks
        .iter()
        .filter(|p| named(p, &case.on_theme))
        .map(|p| p["weightPct"].as_f64().unwrap_or(0.0))
        .sum();
    Some(if total > 0.0 { on / total } else { 0.0 })
}

#[derive(Debug, Clone, Copy, Default)]
struct Timing {
    total: Duration,
    /// First feed line after the opening "Reading what you shared".
    first_event: Option<Duration>,
    /// The thesis theme is on `partial`.
    theme: Option<Duration>,
    /// Picks are on `partial`.
    picks: Option<Duration>,
}

async fn run(service: &Arc<ThesisService>, case: &Case) -> (RunView, Vec<Value>, Timing) {
    run_as(service, case, Uuid::new_v4()).await
}

async fn run_as(
    service: &Arc<ThesisService>,
    case: &Case,
    owner: Uuid,
) -> (RunView, Vec<Value>, Timing) {
    let started = Instant::now();
    let mut timing = Timing::default();
    let id = service
        .start(
            owner,
            StartThesis {
                text: Some(case.idea.clone()),
                links: vec![],
                params: Params {
                    amount_usd: Some(case.amount_usd),
                    risk: Some(case.risk),
                },
            },
        )
        .await
        .unwrap();
    loop {
        let view = service.view(owner, id).await.unwrap().unwrap();
        let t = started.elapsed();
        if timing.first_event.is_none() && view.events.len() > 1 {
            timing.first_event = Some(t);
        }
        if timing.theme.is_none() && view.partial.theme.is_some() {
            timing.theme = Some(t);
        }
        if timing.picks.is_none() && view.partial.picks.is_some() {
            timing.picks = Some(t);
        }
        if matches!(view.stage, Stage::Done | Stage::Failed) || t > Duration::from_secs(200) {
            let artifacts = service
                .artifacts(owner, id)
                .await
                .unwrap()
                .unwrap()
                .into_iter()
                .map(|a| json!({"kind": a.kind, "body": a.body}))
                .collect();
            timing.total = t;
            return (view, artifacts, timing);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

struct AlwaysQuotes;

#[async_trait]
impl Quoter for AlwaysQuotes {
    async fn dry_quote(
        &self,
        _from: &RegistryAsset,
        to: &RegistryAsset,
        amount_in: u128,
    ) -> Result<DryQuote, String> {
        let price = to.price_usd.unwrap_or(1.0);
        Ok(DryQuote {
            amount_out: format!("{:.8}", amount_in as f64 / 1e6 / price),
        })
    }
}

/// A NEAR AI stand-in that answers each role from the case: the thesis names the case's
/// categories (plus an injected address and a forbidden ticker), the picker chooses
/// on-theme candidates from the lists it was shown and tries an out-of-list ticker,
/// the critic keeps everything.
async fn stub_model(case: Case) -> String {
    use axum::{Json, Router, routing::post};
    let app = Router::new().route(
        "/chat/completions",
        post(move |Json(body): Json<Value>| {
            let case = case.clone();
            async move {
                let system = body["messages"][0]["content"].as_str().unwrap_or_default();
                let user = body["messages"][1]["content"].as_str().unwrap_or_default();
                let reply = if system.contains("at the picking step") {
                    stub_pick(&case, user)
                } else if system.contains("risk reviewer") {
                    json!({"bearCase": ["Prices can fall a lot.", "One theme can fall together."], "issues": []})
                } else {
                    stub_thesis(&case)
                };
                Json(json!({"choices": [{"message": {"content": reply.to_string()}}]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn stub_thesis(case: &Case) -> Value {
    if case.outcome == "fail_or_empty" {
        return json!({
            "theme": "Not an investment idea", "direction": "rejected",
            "rationale": "This can't be turned into something to own.", "horizon": "n/a",
            "conviction": "low", "exposures": [], "bearCase": []
        });
    }
    let mut instruments: Vec<String> = case.on_theme.iter().take(4).cloned().collect();
    instruments.push("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into());
    instruments.extend(case.forbidden.iter().take(1).cloned());
    let mut exposures: Vec<Value> = case
        .categories
        .iter()
        .map(|c| {
            json!({"label": format!("{c} exposure"), "category": c, "instruments": instruments,
                   "wrongIf": "Its price falls 30% over three months."})
        })
        .collect();
    while exposures.len() < 2 {
        exposures.push(
            json!({"label": format!("Related {}", exposures.len() + 1), "category": "none",
            "instruments": instruments, "wrongIf": "Its trading volume halves over a quarter."}),
        );
    }
    json!({
        "theme": "Stub thesis", "direction": "bullish",
        "rationale": "If this happens, these assets should benefit.", "horizon": "3-12 months",
        "conviction": "medium", "exposures": exposures,
        "bearCase": ["The idea may not play out."]
    })
}

/// Reads the candidate lists from the pick prompt (lines `- TICKER | …` under `[eN]`).
fn stub_pick(case: &Case, user: &str) -> Value {
    let mut out = serde_json::Map::new();
    let mut current: Option<String> = None;
    let mut used = BTreeSet::new();
    for line in user.lines() {
        if let Some(rest) = line.strip_prefix('[') {
            let id = rest.split(']').next().unwrap_or_default().to_string();
            out.insert(id.clone(), json!({"picks": [{"ticker": "SCAMCOIN", "reason": "Not listed.", "conviction": "high"}]}));
            current = Some(id);
        } else if let (Some(id), Some(rest)) = (&current, line.strip_prefix("- ")) {
            let ticker = rest.split(" | ").next().unwrap_or_default().to_string();
            let on = case.on_theme.iter().any(|t| sym(t) == sym(&ticker));
            let entry = out.get_mut(id).unwrap();
            let picks = entry["picks"].as_array_mut().unwrap();
            if on && picks.len() < 3 && used.insert(ticker.clone()) {
                picks.push(json!({"ticker": ticker, "reason": "It carries this exposure directly.", "conviction": "high"}));
            }
        }
    }
    Value::Object(out)
}

#[tokio::test]
async fn deterministic_code_stages() {
    let registry = registry_assets();
    let rows = Arc::new(market_rows());
    let mut problems = Vec::new();
    for case in cases() {
        let base = stub_model(case.clone()).await;
        let service = Arc::new(
            ThesisService::with_parts(
                Registry::with_assets(registry.clone()),
                Intake::new().unwrap(),
                NearAi::new(reqwest::Client::new(), base, Some("stub".into())),
            )
            .with_markets(Arc::new(FixedMarkets(rows.clone())))
            .with_quoter(Arc::new(AlwaysQuotes)),
        );
        let (view, artifacts, _) = run(&service, &case).await;
        for f in hard_checks(&case, &view, &registry, true) {
            problems.push(format!("{}: {f}", case.id));
        }
        if case.outcome == "fail_or_empty" {
            if view.stage != Stage::Failed {
                problems.push(format!("{}: refusal didn't fail the run", case.id));
            }
            continue;
        }
        if view.stage != Stage::Done {
            problems.push(format!(
                "{}: {:?} {:?}",
                case.id,
                view.stage,
                view.progress.last()
            ));
            continue;
        }
        let picks = picks(&view);
        let p = view.proposal.as_ref().unwrap();
        if !level_excluded(p) && !nested(p) {
            problems.push(format!("{}: risk levels not nested", case.id));
        }
        // The stub always names an address and (when there is a list) tries SCAMCOIN:
        // both must be ignored.
        let ignored = p["ignored"].to_string();
        let listed = artifacts
            .iter()
            .any(|a| a["kind"] == "Shortlist" && a["body"].to_string().contains("\"ticker\""));
        if (listed && !ignored.contains("SCAMCOIN")) || !ignored.contains("0xdeadbeef") {
            problems.push(format!(
                "{}: out-of-list picks not reported: {ignored}",
                case.id
            ));
        }
        // The cases must be satisfiable on the frozen snapshot.
        let (hits, of) = category_hits(&case, &picks);
        if case.outcome == "proposal" && (picks.is_empty() || hits < of) {
            problems.push(format!(
                "{}: oracle picks hit {hits}/{of} categories; picks {:?}; shortlist {}",
                case.id,
                picks
                    .iter()
                    .map(|p| p["asset"]["symbol"].clone())
                    .collect::<Vec<_>>(),
                artifacts
                    .iter()
                    .find(|a| a["kind"] == "Shortlist")
                    .map(|a| a["body"].to_string())
                    .unwrap_or_default()
            ));
        }
        if let Some(min) = case.min_picks
            && picks.len() < min
        {
            problems.push(format!(
                "{}: {} picks < {min}: {}",
                case.id,
                picks.len(),
                serde_json::to_string(&artifacts).unwrap_or_default()
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[derive(Default)]
struct Tally {
    runs: usize,
    hard_pass: usize,
    calls: usize,
    first_try_valid: usize,
    calls_ok: usize,
    calls_answered: usize,
    timeouts: usize,
    outcome_ok: usize,
    with_picks: usize,
    bear_ok: usize,
    cat_hits: usize,
    cat_total: usize,
    on_theme_ok: usize,
    on_theme_total: usize,
    forbidden_runs: usize,
    picks_quoted: usize,
    picks_tried: usize,
    critic_ran: usize,
    critic_revised: usize,
    nested: usize,
    nested_total: usize,
    latencies: Vec<f64>,
    first_events: Vec<f64>,
    themes: Vec<f64>,
}

fn quantile(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

fn pct(n: usize, d: usize) -> String {
    if d == 0 {
        "n/a".into()
    } else {
        format!("{:.0}% ({n}/{d})", 100.0 * n as f64 / d as f64)
    }
}

#[tokio::test]
#[ignore = "live: needs NEAR_AI_API_KEY; spends model calls"]
async fn live_scorecard() {
    let key = std::env::var("NEAR_AI_API_KEY").expect("set NEAR_AI_API_KEY");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let registry = registry_assets();
    let markets: Arc<dyn MarketSource> = if std::env::var("THESIS_EVAL_LIVE_MARKETS").is_ok() {
        MarketData::new().unwrap()
    } else {
        Arc::new(FixedMarkets(Arc::new(market_rows())))
    };
    let service = Arc::new(
        ThesisService::with_parts(
            Registry::with_assets(registry.clone()),
            Intake::new().unwrap(),
            NearAi::new(
                client.clone(),
                std::env::var("NEAR_AI_BASE_URL")
                    .unwrap_or_else(|_| honey_server::thesis::near_ai::DEFAULT_BASE_URL.into()),
                Some(key),
            ),
        )
        .with_search(Linkup::new(
            client.clone(),
            honey_server::thesis::research::DEFAULT_BASE_URL.into(),
            std::env::var("LINKUP_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
        ))
        .with_markets(markets)
        .with_quoter(Arc::new(OneClickQuoter::new(
            client,
            "https://1click.chaindefuser.com/v0".into(),
            std::env::var("NEAR_INTENTS_API_KEY")
                .ok()
                .filter(|k| !k.is_empty()),
            honey_server::thesis::quote::DEFAULT_QUOTE_ACCOUNT.into(),
        ))),
    );
    let stability_runs: usize = std::env::var("THESIS_EVAL_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let concurrency: usize = std::env::var("THESIS_EVAL_CONCURRENCY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);
    let cases = cases();
    let mut jobs: Vec<(Case, usize)> = Vec::new();
    for case in &cases {
        let n = if case.stability {
            stability_runs.max(1)
        } else {
            1
        };
        for i in 0..n {
            jobs.push((case.clone(), i));
        }
    }
    let results: Vec<(Case, usize, RunView, Vec<Value>, Timing)> = futures_util::stream::iter(jobs)
        .map(|(case, i)| {
            let service = service.clone();
            async move {
                let (view, artifacts, took) = run(&service, &case).await;
                (case, i, view, artifacts, took)
            }
        })
        .buffer_unordered(4)
        .collect()
        .await;

    let mut t = Tally::default();
    let mut rows = Vec::new();
    let mut runs_by_case: HashMap<String, Vec<BTreeSet<String>>> = HashMap::new();
    for (case, i, view, artifacts, took) in &results {
        let fails = hard_checks(case, view, &registry, true);
        let picks = picks(view);
        t.runs += 1;
        t.latencies.push(took.total.as_secs_f64());
        if let Some(f) = took.first_event {
            t.first_events.push(f.as_secs_f64());
        }
        if let Some(f) = took.theme {
            t.themes.push(f.as_secs_f64());
        }
        if fails.is_empty() {
            t.hard_pass += 1;
        }
        for a in artifacts.iter().filter(|a| a["kind"] == "ModelCall") {
            t.calls += 1;
            t.first_try_valid += usize::from(a["body"]["first_try_valid"] == json!(true));
            t.calls_ok += usize::from(a["body"]["ok"] == json!(true));
            let error = a["body"]["error"].as_str().unwrap_or_default();
            t.timeouts += usize::from(error == "timeout");
            t.calls_answered +=
                usize::from(a["body"]["ok"] == json!(true) || error == "invalid output");
        }
        let outcome_ok = match case.outcome.as_str() {
            "proposal" => view.stage == Stage::Done && !picks.is_empty(),
            "proposal_or_empty" => view.stage == Stage::Done,
            "fail_or_empty" => view.stage == Stage::Failed || picks.is_empty(),
            _ => true,
        };
        t.outcome_ok += usize::from(outcome_ok);
        let p = view.proposal.clone().unwrap_or(Value::Null);
        if p.is_object() && !level_excluded(&p) {
            t.nested_total += 1;
            t.nested += usize::from(nested(&p));
        }
        if !picks.is_empty() {
            t.with_picks += 1;
            t.bear_ok += usize::from(p["bearCase"].as_array().is_some_and(|b| !b.is_empty()));
            let (hits, of) = category_hits(case, &picks);
            t.cat_hits += hits;
            t.cat_total += of;
            if let Some(share) = on_theme_share(case, &picks) {
                t.on_theme_total += 1;
                t.on_theme_ok += usize::from(share >= 0.7);
            }
        }
        if fails.iter().any(|f| f.starts_with("forbidden")) {
            t.forbidden_runs += 1;
        }
        let quote_drops = p["unmatched"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|u| {
                u["note"]
                    .as_str()
                    .is_some_and(|n| n.contains("couldn't get a live price"))
            })
            .count();
        t.picks_quoted += picks
            .iter()
            .filter(|p| p["quote"]["ok"] == json!(true))
            .count();
        t.picks_tried += picks.len() + quote_drops;
        match p["critic"]["verdict"].as_str() {
            Some("ok") => t.critic_ran += usize::from(!picks.is_empty()),
            Some("revised") if !picks.is_empty() => {
                t.critic_ran += 1;
                t.critic_revised += 1;
            }
            _ => {}
        }
        let symbols: BTreeSet<String> = picks
            .iter()
            .map(|p| sym(p["asset"]["symbol"].as_str().unwrap_or_default()))
            .collect();
        runs_by_case
            .entry(case.id.clone())
            .or_default()
            .push(symbols);
        let summary = if picks.is_empty() {
            match view.stage {
                Stage::Failed => format!(
                    "failed: {}",
                    view.progress
                        .last()
                        .map(|p| p.message.as_str())
                        .unwrap_or("")
                ),
                _ => "empty".into(),
            }
        } else {
            let mut s = picks
                .iter()
                .map(|p| {
                    format!(
                        "{} {}%",
                        p["asset"]["symbol"].as_str().unwrap_or("?"),
                        p["weightPct"]
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            if p["cashPct"].as_u64().unwrap_or(0) > 0 {
                s.push_str(&format!(", USDC {}%", p["cashPct"]));
            }
            s
        };
        rows.push(format!(
            "| {}{} | {} | {} | {:.0}s | {} | {} |",
            case.id,
            if *i > 0 {
                format!(" #{}", i + 1)
            } else {
                String::new()
            },
            case.outcome,
            summary.replace('|', "/"),
            took.total.as_secs_f64(),
            p["critic"]["verdict"].as_str().unwrap_or("-"),
            if fails.is_empty() {
                "pass".to_string()
            } else {
                fails.join("; ").replace('|', "/")
            }
        ));
        if let Ok(dir) = std::env::var("THESIS_EVAL_DUMP") {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(
                format!("{dir}/{}-{}.json", case.id, i),
                serde_json::to_string_pretty(&json!({"view": view, "artifacts": artifacts}))
                    .unwrap_or_default(),
            );
        }
    }
    rows.sort();
    let mut stable = Vec::new();
    for (id, sets) in &runs_by_case {
        if sets.len() < 2 {
            continue;
        }
        let mut sum = 0.0;
        let mut n = 0.0;
        for a in 0..sets.len() {
            for b in a + 1..sets.len() {
                let inter = sets[a].intersection(&sets[b]).count() as f64;
                let union = sets[a].union(&sets[b]).count() as f64;
                sum += if union == 0.0 { 1.0 } else { inter / union };
                n += 1.0;
            }
        }
        stable.push((id.clone(), sum / n));
    }
    stable.sort_by(|a, b| a.0.cmp(&b.0));
    // Back to back: one user starts runs one after another (the founder's follow-up).
    let owner = Uuid::new_v4();
    let mut b2b = Vec::new();
    for idea in [
        "I think AI is a bubble and it's going to burst now",
        "Make it low risk",
        "Gold will go up.",
    ] {
        let case = Case {
            id: "back-to-back".into(),
            idea: idea.into(),
            risk: Risk::Medium,
            amount_usd: 100.0,
            outcome: "any".into(),
            categories: vec![],
            on_theme: vec![],
            forbidden: vec![],
            min_picks: None,
            max_picks: None,
            stability: false,
        };
        let (view, _, took) = run_as(&service, &case, owner).await;
        let ai_down = view
            .progress
            .last()
            .is_some_and(|p| p.message.contains("didn't answer"));
        b2b.push(format!(
            "| {idea} | {:?} | {:.0}s | {} |",
            view.stage,
            took.total.as_secs_f64(),
            if ai_down {
                "AI didn't answer"
            } else {
                "answered"
            }
        ));
    }
    let card = format!(
        "## Scorecard\n\nRuns: {} ({} cases, stability cases x{stability_runs}, {concurrency} at a time). Model: {} (no thinking, streamed). Snapshot: {}.\n\n\
         | Check | Result |\n|---|---|\n\
         | Hard gates pass (all runs, all three risk levels) | {} |\n\
         | Model calls that timed out | {} |\n\
         | Answered calls with valid JSON on first try | {} |\n\
         | Answered calls valid after one retry | {} |\n\
         | Expected outcome (proposal / refusal / empty) | {} |\n\
         | Runs with a forbidden pick | {} |\n\
         | Bear case present (runs with picks) | {} |\n\
         | Category recall (expected categories hit) | {} |\n\
         | On-theme weight >= 70% | {} |\n\
         | Picks quotable on 1Click (dry) | {} |\n\
         | Critic ran / revised | {} / {} |\n\
         | Risk levels nested (low in medium in high) | {} |\n\
         | Stability (mean Jaccard of picks) | {} |\n\
         | First feed event p50 / p95 | {:.1}s / {:.1}s |\n\
         | Thesis shown (partial.theme) p50 / p95 | {:.0}s / {:.0}s |\n\
         | Whole run p50 / p95 / max | {:.0}s / {:.0}s / {:.0}s |\n\n\
         Back to back, one user:\n\n| Idea | Stage | Time | Model |\n|---|---|---|---|\n{}\n\n\
         | Case | Expect | Picks (requested risk) | Time | Critic | Hard gates |\n|---|---|---|---|---|---|\n{}\n",
        t.runs,
        cases.len(),
        honey_server::thesis::near_ai::MODEL_REASON,
        if std::env::var("THESIS_EVAL_LIVE_MARKETS").is_ok() {
            "live CoinGecko"
        } else {
            "frozen registry + CoinGecko (tests/thesis_evals)"
        },
        pct(t.hard_pass, t.runs),
        pct(t.timeouts, t.calls),
        pct(t.first_try_valid, t.calls_answered),
        pct(t.calls_ok, t.calls_answered),
        pct(t.outcome_ok, t.runs),
        pct(t.forbidden_runs, t.runs),
        pct(t.bear_ok, t.with_picks),
        pct(t.cat_hits, t.cat_total),
        pct(t.on_theme_ok, t.on_theme_total),
        pct(t.picks_quoted, t.picks_tried),
        pct(t.critic_ran, t.with_picks),
        t.critic_revised,
        pct(t.nested, t.nested_total),
        stable
            .iter()
            .map(|(id, j)| format!("{id} {j:.2}"))
            .collect::<Vec<_>>()
            .join(", "),
        quantile(&t.first_events, 0.5),
        quantile(&t.first_events, 0.95),
        quantile(&t.themes, 0.5),
        quantile(&t.themes, 0.95),
        quantile(&t.latencies, 0.5),
        quantile(&t.latencies, 0.95),
        quantile(&t.latencies, 1.0),
        b2b.join("\n"),
        rows.join("\n")
    );
    println!("{card}");
    if let Ok(path) = std::env::var("THESIS_EVAL_OUT") {
        std::fs::write(path, &card).unwrap();
    }
}
