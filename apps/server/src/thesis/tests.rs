use super::*;
use quote::DryQuote;
use registry::parse_tokens;
use shortlist::{shortlist, universe};
use strategy::{Conviction, apply_critic, apply_picks, size, to_pick, weights};

fn assets() -> Vec<RegistryAsset> {
    parse_tokens(&json!([
        {"assetId":"nep141:usdc","blockchain":"near","symbol":"USDC","decimals":6,"price":1.0,"coingeckoId":"usd-coin"},
        {"assetId":"nep245:nvda","blockchain":"near","symbol":"NVDAon","decimals":18,"price":180.0},
        {"assetId":"nep245:msft","blockchain":"near","symbol":"MSFTon","decimals":18,"price":420.0},
        {"assetId":"nep141:render","blockchain":"sol","symbol":"RENDER","decimals":8,"price":7.0,"coingeckoId":"render-token"},
        {"assetId":"nep141:dead","blockchain":"eth","symbol":"DEAD","decimals":18,"price":1.0},
        {"assetId":"nep141:btc","blockchain":"btc","symbol":"BTC","decimals":8,"price":68000.0,"coingeckoId":"bitcoin"},
        {"assetId":"nep141:wbtc","blockchain":"eth","symbol":"WBTC","decimals":8,"price":68000.0,"coingeckoId":"wrapped-bitcoin"},
        {"assetId":"nep141:cbbtc","blockchain":"base","symbol":"cbBTC","decimals":8,"price":68000.0,"coingeckoId":"coinbase-wrapped-btc"},
        {"assetId":"nep141:tiny","blockchain":"sol","symbol":"TINY","decimals":6,"price":0.01,"coingeckoId":"tiny"},
        {"assetId":"nep141:doge","blockchain":"bsc","symbol":"DOGE","decimals":8,"price":0.1,"coingeckoId":"dogecoin"},
        {"assetId":"nep141:xaut","blockchain":"eth","symbol":"XAUT","decimals":6,"price":3900.0,"coingeckoId":"tether-gold"},
        {"assetId":"nep141:old","blockchain":"eth","symbol":"USDC(DEPRECATED)","decimals":6,"price":1.0,"coingeckoId":"usd-coin"}
    ]))
}

fn coins() -> HashMap<String, CoinMarket> {
    let row = |id: &str, sym: &str, name: &str, price: f64, cap: f64, vol: f64| json!({"id": id, "symbol": sym, "name": name, "current_price": price, "market_cap": cap, "total_volume": vol, "price_change_percentage_24h": 1.0});
    crate::market_data::parse_coin_markets(&json!([
        row("usd-coin", "usdc", "USDC", 1.0, 7e10, 1e10),
        row("render-token", "render", "Render", 7.0, 3.6e9, 1e8),
        row("bitcoin", "btc", "Bitcoin", 68000.0, 1.3e12, 3e10),
        row("tiny", "tiny", "Tiny AI", 0.01, 5e6, 2e4),
        row("dogecoin", "doge", "Dogecoin", 0.1, 1e10, 1e9),
        row("tether-gold", "xaut", "Tether Gold", 3900.0, 3e9, 5e7),
    ]))
    .into_iter()
    .map(|c| (c.id.clone(), c))
    .collect()
}

fn exposure(label: &str, category: &str, names: &[&str]) -> Exposure {
    Exposure {
        label: label.into(),
        instruments: names.iter().map(|s| s.to_string()).collect(),
        category: Some(category.into()),
        wrong_if: Some("It falls for two quarters.".into()),
    }
}

#[test]
fn universe_folds_wrappers_and_drops_junk() {
    let coins = coins();
    let u = universe(&assets(), Some(&coins));
    let btc: Vec<_> = u.iter().filter(|c| c.key == "bitcoin").collect();
    assert_eq!(btc.len(), 1, "BTC, WBTC and cbBTC are one coin");
    assert_eq!(btc[0].ticker, "BTC");
    assert_eq!(
        btc[0].asset.chain, "base",
        "Honey's chains only, gas-free ones first"
    );
    assert!(u.iter().all(|c| shortlist::honey_chain(&c.asset.chain)));
    assert!(u.iter().all(|c| !c.ticker.contains("DEPRECATED")));
    let tiny = u.iter().find(|c| c.ticker == "TINY").unwrap();
    assert!(!tiny.liquid(), "under $20M market cap");
    let usdc = u.iter().find(|c| c.ticker == "USDC").unwrap();
    assert!(usdc.liquid());
    let nvda = u.iter().find(|c| c.ticker == "NVDAON").unwrap();
    assert!(nvda.liquid(), "tokenized stocks pass without market cap");
}

#[test]
fn shortlist_respects_risk_and_named_first() {
    let coins = coins();
    let u = universe(&assets(), Some(&coins));
    let exposures = vec![
        exposure(
            "AI compute",
            "ai",
            &["TINY", "RENDER", "0xdeadbeefdeadbeef"],
        ),
        exposure("Meme coins", "memecoins", &["DOGE"]),
        exposure("Bitcoin", "bitcoin", &["WBTC"]),
    ];
    let (lists, ignored) = shortlist(&exposures, &u, Some(Risk::High));
    assert_eq!(ignored.len(), 1);
    assert_eq!(lists[0].candidates[0].ticker, "RENDER");
    assert_eq!(lists[0].illiquid, vec!["TINY".to_string()]);
    assert_eq!(lists[1].candidates[0].ticker, "DOGE");
    assert_eq!(lists[2].candidates.len(), 1);
    assert_eq!(
        lists[2].candidates[0].ticker, "BTC",
        "a wrapper names the coin"
    );
    // Low risk: no meme coins, $1B+ only.
    let (low, _) = shortlist(&exposures, &u, Some(Risk::Low));
    assert!(low[1].candidates.is_empty());
    assert!(low[0].candidates.iter().all(|c| c.ticker != "TINY"));
    // No market data (DRY_RUN): nothing is filtered for liquidity.
    let u = universe(&assets(), None);
    let (dry, _) = shortlist(&exposures, &u, None);
    assert!(dry[0].candidates.iter().any(|c| c.ticker == "TINY"));
}

#[test]
fn picks_are_checked_against_each_exposures_own_list() {
    let coins = coins();
    let u = universe(&assets(), Some(&coins));
    let exposures = vec![
        exposure("AI compute", "ai", &["RENDER"]),
        exposure("Gold", "gold", &["XAUT"]),
    ];
    let (lists, _) = shortlist(&exposures, &u, Some(Risk::High));
    let schema = strategy::pick_schema(&lists);
    assert_eq!(
        schema["properties"]["e2"]["properties"]["picks"]["items"]["properties"]["ticker"]["enum"],
        json!(["XAUT"])
    );
    let reply = json!({
        "e1": {"picks": [
            {"ticker": "XAUT", "reason": "Gold.", "conviction": "high"},
            {"ticker": "RENDER", "reason": "Compute.", "conviction": "high"},
            {"ticker": "nep141:dead", "reason": "x", "conviction": "low"}
        ]},
        "e2": {"picks": [], "none": "Nothing fits."},
        "e9": {"picks": []}
    });
    assert!(strategy::validate_pick(&reply).is_ok());
    let (chosen, ignored, abstained) = apply_picks(&lists, &reply);
    assert_eq!(chosen.len(), 1);
    assert_eq!(chosen[0].coin.ticker, "RENDER");
    assert_eq!(ignored.len(), 3, "{ignored:?}");
    assert_eq!(
        abstained.get("e2").map(String::as_str),
        Some("Nothing fits.")
    );
    // Promise words are sent back to the model.
    let hype = json!({"e1": {"picks": [{"ticker": "RENDER", "reason": "Guaranteed to 10x.", "conviction": "high"}]}});
    assert!(strategy::validate_pick(&hype).is_err());
}

#[test]
fn critic_can_only_shrink() {
    let coins = coins();
    let u = universe(&assets(), Some(&coins));
    let exposures = vec![
        exposure("AI compute", "ai", &["RENDER"]),
        exposure("Gold", "gold", &["XAUT"]),
        exposure("Bitcoin", "bitcoin", &["BTC"]),
    ];
    let (lists, _) = shortlist(&exposures, &u, Some(Risk::High));
    let reply = json!({
        "e1": {"picks": [{"ticker": "RENDER", "reason": "r", "conviction": "high"}]},
        "e2": {"picks": [{"ticker": "XAUT", "reason": "g", "conviction": "high"}]},
        "e3": {"picks": [{"ticker": "BTC", "reason": "b", "conviction": "high"}]}
    });
    let (chosen, _, _) = apply_picks(&lists, &reply);
    let critic = json!({
        "bearCase": ["One theme.", "Prices can fall."],
        "issues": [
            {"type": "off_theme", "ticker": "XAUT", "action": "drop", "note": "Not AI."},
            {"type": "concentration", "ticker": "BTC", "action": "downweight", "note": "Big."},
            {"type": "duplicate", "ticker": "ETH", "action": "drop", "note": "Not a pick."}
        ],
        "notes": []
    });
    assert!(strategy::validate_critic(&critic).is_ok());
    let out = apply_critic(chosen.clone(), &critic);
    assert_eq!(out.report.verdict, "revised");
    assert_eq!(out.kept.len(), 2);
    assert_eq!(out.dropped.len(), 1);
    assert_eq!(out.bear_case.len(), 2);
    // Size: the dropped pick's third and half of BTC's stay in cash, never move to RENDER.
    let picks: Vec<_> = chosen
        .into_iter()
        .map(|c| {
            let keep = out
                .trims
                .iter()
                .find(|(k, _)| *k == c.coin.key)
                .map(|t| t.1)
                .unwrap_or(1.0);
            let mut p = to_pick(c, true);
            p.keep = keep;
            p
        })
        .collect();
    let (sized, _, cash) = size(picks, 300.0, Risk::High);
    let w: Vec<_> = sized
        .iter()
        .map(|p| (p.ticker.as_str(), p.weight_pct))
        .collect();
    assert_eq!(w, vec![("RENDER", 34), ("BTC", 16)]);
    assert_eq!(cash, 50);
    let bad = json!({"bearCase": ["only one"], "issues": []});
    assert!(strategy::validate_critic(&bad).is_err());
}

#[test]
fn weights_follow_conviction_and_caps_only_shrink() {
    assert_eq!(weights(&[3, 2, 1], &[1.0; 3], 100), vec![50, 33, 17]);
    assert_eq!(weights(&[3, 2, 1], &[1.0; 3], 40), vec![40, 33, 17]);
    assert_eq!(weights(&[2], &[1.0], 60), vec![60]);
    assert_eq!(weights(&[2, 2], &[1.0, 0.5], 60), vec![50, 25]);
    assert!(weights(&[], &[], 50).is_empty());
}

fn pick(ticker: &str, conviction: Conviction) -> StrategyPick {
    let coins = coins();
    let u = universe(&assets(), Some(&coins));
    let coin = u.iter().find(|c| c.ticker == ticker).unwrap().clone();
    to_pick(
        strategy::Chosen {
            coin,
            exposure: format!("{ticker} exposure"),
            reason: "r".into(),
            conviction,
        },
        true,
    )
}

#[test]
fn sizing_drops_extra_and_dust_orders() {
    let picks = vec![
        pick("RENDER", Conviction::Low),
        pick("BTC", Conviction::High),
        pick("XAUT", Conviction::Medium),
        pick("DOGE", Conviction::Medium),
    ];
    // Medium: 3 assets max, 50% cap; the low-conviction pick goes.
    let (sized, unmatched, cash) = size(picks.clone(), 1000.0, Risk::Medium);
    assert_eq!(sized.len(), 3);
    assert_eq!(sized[0].ticker, "BTC");
    assert!(unmatched[0].note.contains("RENDER"));
    assert!(sized.iter().all(|p| p.weight_pct <= 50));
    assert_eq!(sized.iter().map(|p| p.weight_pct).sum::<u32>() + cash, 100);
    // $1.50 can't fund several $1 orders, so it buys one thing.
    let (sized, unmatched, _) = size(picks, 1.5, Risk::High);
    assert_eq!(sized.len(), 1);
    assert_eq!(unmatched.len(), 3);
}

struct MockQuoter;

#[async_trait]
impl Quoter for MockQuoter {
    async fn dry_quote(
        &self,
        _from: &RegistryAsset,
        to: &RegistryAsset,
        amount_in: u128,
    ) -> Result<DryQuote, String> {
        if to.symbol == "DOGE" {
            return Err("no route".into());
        }
        Ok(DryQuote {
            amount_out: format!("{}", amount_in as f64 / 1e6 / to.price_usd.unwrap_or(1.0)),
        })
    }
}

struct CountingQuoter(std::sync::atomic::AtomicUsize);

#[async_trait]
impl Quoter for CountingQuoter {
    async fn dry_quote(
        &self,
        from: &RegistryAsset,
        to: &RegistryAsset,
        amount_in: u128,
    ) -> Result<DryQuote, String> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        MockQuoter.dry_quote(from, to, amount_in).await
    }
}

/// One ranked set, three risk levels, one quote per distinct token and amount; a token
/// with no route leaves every level.
#[tokio::test]
async fn risk_levels_share_one_ranked_set_and_one_quote_round() {
    let base = vec![
        pick("BTC", Conviction::High),
        pick("XAUT", Conviction::High),
        pick("RENDER", Conviction::Medium),
        pick("DOGE", Conviction::Medium),
    ];
    let origin = assets().into_iter().find(|a| a.symbol == "USDC").unwrap();
    let quoter = CountingQuoter(Default::default());
    let (variants, log) = strategy::variants(&base, 100.0, Some(&origin), Some(&quoter)).await;
    let tickers = |r: Risk| {
        variants
            .iter()
            .find(|v| v.risk == r)
            .unwrap()
            .picks
            .iter()
            .map(|p| p.ticker.clone())
            .collect::<Vec<_>>()
    };
    // DOGE has no route; low risk holds no meme coins anyway.
    assert_eq!(tickers(Risk::Low), vec!["BTC", "XAUT"]);
    assert_eq!(tickers(Risk::Medium), vec!["BTC", "XAUT", "RENDER"]);
    assert_eq!(tickers(Risk::High), vec!["BTC", "XAUT", "RENDER"]);
    for v in &variants {
        assert!(v.picks.iter().all(|p| p.quote.as_ref().unwrap().ok));
        assert_eq!(
            v.picks.iter().map(|p| p.weight_pct).sum::<u32>() + v.cash_pct,
            100
        );
        if v.risk != Risk::Low {
            assert!(v.unmatched.iter().any(|u| u.note.contains("DOGE")));
        }
    }
    assert_eq!(log.failed.len(), 1);
    // Medium and high size the same three picks differently (caps 50% / 40%), so the
    // quotes are: round 1 for every distinct amount, round 2 only for re-sized amounts.
    assert!(quoter.0.load(std::sync::atomic::Ordering::SeqCst) <= 12);
}

#[test]
fn banned_phrases_are_whole_words() {
    assert_eq!(banned_phrase("This is GUARANTEED."), Some("guaranteed"));
    assert_eq!(banned_phrase("could 10x soon"), Some("10x"));
    assert_eq!(banned_phrase("Moonbeam is a chain"), None);
    assert_eq!(banned_phrase("plain words"), None);
}

#[test]
fn intent_records_assumptions() {
    let i = build_intent("AI", vec![], &Params::default());
    assert_eq!(i.amount_usd, 100.0);
    assert!(i.assumed.iter().any(|a| a.starts_with("amount")));
    assert_eq!(i.hash.len(), 64);
}

#[test]
fn thesis_check_enforces_enums_and_bounds() {
    let base = json!(fixture_thesis("AI"));
    assert!(validate_thesis(&base).is_ok());
    for (field, value) in [
        ("direction", json!("short")),
        ("conviction", json!("certain")),
        ("theme", json!("x".repeat(MAX_SHORT_TEXT + 1))),
        ("exposures", json!([])),
        ("bearCase", json!([])),
        ("rationale", json!("This is a safe bet.")),
        (
            "exposures",
            json!(vec![
                json!({"label": "a", "instruments": [], "wrongIf": "x"});
                MAX_EXPOSURES + 1
            ]),
        ),
        (
            "exposures",
            json!([{"label": "a", "instruments": [], "wrongIf": "x"}, {"label": "b", "instruments": []}]),
        ),
        (
            "exposures",
            json!([{"label": "a", "instruments": vec!["ETH"; MAX_INSTRUMENTS + 1], "wrongIf": "x"}, {"label": "b", "wrongIf": "y"}]),
        ),
    ] {
        let mut thesis = base.clone();
        thesis[field] = value;
        assert!(validate_thesis(&thesis).is_err(), "{field} accepted");
    }
    // A declined idea may carry no exposures, and it stops the run.
    for direction in STOP_DIRECTIONS {
        let mut thesis = base.clone();
        thesis["direction"] = json!(direction);
        thesis["exposures"] = json!([]);
        thesis["bearCase"] = json!([]);
        thesis["rationale"] = json!("You asked for a guaranteed 10x; Honey can't promise that.");
        assert!(validate_thesis(&thesis).is_ok());
        let parsed: Thesis = serde_json::from_value(thesis).unwrap();
        assert!(stop_message(&parsed).is_some());
    }
    assert!(stop_message(&fixture_thesis("AI")).is_none());
    let schema = thesis_schema();
    assert_eq!(schema["properties"]["direction"]["enum"], json!(DIRECTIONS));
    assert!(
        schema["properties"]["exposures"]["items"]["properties"]["category"]["enum"]
            .as_array()
            .unwrap()
            .contains(&json!("gold"))
    );
}

#[test]
fn fixture_thesis_passes_its_schema_check() {
    for idea in ["anything", "privacy", "Kazakhstan"] {
        assert!(
            validate_thesis(&json!(fixture_thesis(idea))).is_ok(),
            "{idea}"
        );
    }
    assert!(validate_thesis(&json!({"theme": "x"})).is_err());
}

async fn wait(service: &ThesisService, owner: Uuid, id: Uuid) -> RunView {
    for _ in 0..500 {
        let view = service.view(owner, id).await.unwrap().unwrap();
        if matches!(view.stage, Stage::Done | Stage::Failed) {
            return view;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("run did not finish");
}

/// A stand-in for NEAR AI Cloud that answers by role (which system prompt it got).
async fn stub_model(understand: Value, pick: Value, critic: Option<Value>) -> String {
    use axum::{Json, Router, routing::post};
    let app = Router::new().route(
        "/chat/completions",
        post(move |Json(body): Json<Value>| {
            let (understand, pick, critic) = (understand.clone(), pick.clone(), critic.clone());
            async move {
                let system = body["messages"][0]["content"].as_str().unwrap_or_default();
                let reply = if system.contains("at the picking step") {
                    pick
                } else if system.contains("risk reviewer") {
                    match critic {
                        Some(c) => c,
                        None => return Err(axum::http::StatusCode::BAD_GATEWAY),
                    }
                } else {
                    understand
                };
                Ok(Json(
                    json!({"choices": [{"message": {"content": reply.to_string()}}]}),
                ))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn live_service(base: String) -> Arc<ThesisService> {
    Arc::new(
        ThesisService::with_parts(
            Registry::with_assets(assets()),
            Intake::new().unwrap(),
            NearAi::new(reqwest::Client::new(), base, Some("k".into())),
        )
        .with_markets(Arc::new(FixedMarkets(Arc::new(coins()))))
        .with_quoter(Arc::new(MockQuoter)),
    )
}

fn start(text: &str, risk: Risk) -> StartThesis {
    StartThesis {
        text: Some(text.into()),
        links: vec![],
        params: Params {
            amount_usd: Some(200.0),
            risk: Some(risk),
        },
    }
}

/// The full live path against stubs: every new field is there and old ones kept.
#[tokio::test]
async fn live_pipeline_produces_the_full_proposal() {
    let mut thesis = json!(fixture_thesis("x"));
    thesis["exposures"] = json!([
        {"label": "AI compute", "category": "ai", "instruments": ["RENDER"], "wrongIf": "Render usage falls for two quarters."},
        {"label": "Gold", "category": "gold", "instruments": ["XAUT"], "wrongIf": "Gold falls 10% in three months."},
        {"label": "Memes", "category": "memecoins", "instruments": ["DOGE"], "wrongIf": "Meme volumes halve."}
    ]);
    let pick = json!({
        "e1": {"picks": [{"ticker": "RENDER", "reason": "It is the compute network.", "conviction": "high"}]},
        "e2": {"picks": [{"ticker": "XAUT", "reason": "It tracks gold.", "conviction": "medium"}]},
        "e3": {"picks": [{"ticker": "DOGE", "reason": "Largest meme coin.", "conviction": "low"}]}
    });
    let critic = json!({
        "bearCase": ["AI tokens can fall hard.", "Gold may lag."],
        "issues": [{"type": "meme", "ticker": "DOGE", "action": "keep", "note": "Meme coins are volatile."}],
        "notes": []
    });
    let service = live_service(stub_model(thesis, pick, Some(critic)).await);
    let owner = Uuid::new_v4();
    let id = service
        .start(owner, start("AI and gold", Risk::High))
        .await
        .unwrap();
    let view = wait(&service, owner, id).await;
    assert_eq!(view.stage, Stage::Done, "{:?}", view.progress);
    assert_eq!(view.step.as_deref(), Some("done"));
    assert!(!view.dry_run);
    let steps: Vec<_> = view
        .progress
        .iter()
        .filter_map(|p| p.step.clone())
        .collect();
    for s in [
        "intake",
        "understand",
        "shortlist",
        "pick",
        "critic",
        "size",
        "quote",
        "done",
    ] {
        assert!(steps.iter().any(|x| x == s), "missing step {s}");
    }
    assert!(view.progress.iter().all(|p| matches!(
        p.stage,
        Stage::Intake | Stage::Understand | Stage::Strategize | Stage::Done
    )));
    // The live feed, step timings and early partial results.
    assert!(view.started_at.is_some());
    assert!(
        view.events
            .iter()
            .any(|e| e.text.starts_with("Picked RENDER"))
    );
    assert!(view.events.iter().any(|e| e.text.starts_with("Looking at")));
    assert!(view.events.iter().any(|e| e.ms.is_some()));
    assert!(
        view.steps
            .iter()
            .any(|s| s.step == "pick" && s.ended_at.is_some())
    );
    assert!(view.thinking.is_none(), "cleared when the run ends");
    assert!(view.partial.theme.is_some());
    assert_eq!(view.partial.picks.as_ref().map(Vec::len), Some(3));
    let p = view.proposal.unwrap();
    assert_eq!(p["version"], "Strategy/1");
    assert_eq!(p["quoted"], true);
    for risk in ["low", "medium", "high"] {
        let v = &p["byRisk"][risk];
        assert!(v["picks"].is_array(), "{risk} missing");
        assert!(v.get("byRisk").is_none());
    }
    assert_eq!(
        p["picks"], p["byRisk"]["high"]["picks"],
        "top level is the risk asked for"
    );
    assert_eq!(p["promptVersions"]["model"], near_ai::MODEL_REASON);
    assert_eq!(p["critic"]["verdict"], "ok");
    assert_eq!(p["bearCase"].as_array().unwrap().len(), 2);
    assert_eq!(p["promptVersions"]["pick"], prompts::PICK.version);
    let picks = p["picks"].as_array().unwrap();
    assert_eq!(picks.len(), 2, "DOGE has no route in the mock quoter: {p}");
    for pick in picks {
        for field in [
            "asset",
            "weightPct",
            "match",
            "exposure",
            "amountUsd",
            "reason",
            "conviction",
            "market",
            "quote",
        ] {
            assert!(pick.get(field).is_some(), "{field} missing");
        }
        assert_eq!(pick["quote"]["ok"], true);
    }
    assert!(
        p["unmatched"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u["note"].as_str().unwrap().contains("DOGE"))
    );
    let thesis = view.thesis.unwrap();
    assert!(thesis["exposures"][0]["wrongIf"].is_string());
    let kinds: Vec<_> = service
        .artifacts(owner, id)
        .await
        .unwrap()
        .unwrap()
        .iter()
        .map(|a| a.kind.clone())
        .collect();
    for k in [
        "IntentRecord",
        "ModelCall",
        "Thesis",
        "Shortlist",
        "Picks",
        "Critic",
        "Strategy",
    ] {
        assert!(kinds.iter().any(|x| x == k), "missing artifact {k}");
    }
}

/// A critic that never answers ships the proposal without it, and says so.
#[tokio::test]
async fn critic_failure_ships_without_it() {
    let mut thesis = json!(fixture_thesis("x"));
    thesis["exposures"] = json!([
        {"label": "Bitcoin", "category": "bitcoin", "instruments": ["BTC"], "wrongIf": "BTC falls 30%."},
        {"label": "Gold", "category": "gold", "instruments": ["XAUT"], "wrongIf": "Gold falls 10%."}
    ]);
    let pick = json!({
        "e1": {"picks": [{"ticker": "BTC", "reason": "Bitcoin itself.", "conviction": "high"}]},
        "e2": {"picks": [{"ticker": "XAUT", "reason": "Gold itself.", "conviction": "high"}]}
    });
    let service = live_service(stub_model(thesis, pick, None).await);
    let owner = Uuid::new_v4();
    let id = service
        .start(owner, start("hard money", Risk::Low))
        .await
        .unwrap();
    let view = wait(&service, owner, id).await;
    assert_eq!(view.stage, Stage::Done);
    let p = view.proposal.unwrap();
    assert_eq!(p["critic"]["verdict"], "skipped");
    assert!(
        !p["bearCase"].as_array().unwrap().is_empty(),
        "falls back to the thesis bear case"
    );
    assert_eq!(p["picks"].as_array().unwrap().len(), 2);
    assert_eq!(p["cashPct"], 0);
}

/// A model that declines the idea ends the run as Failed, with no strategy.
#[tokio::test]
async fn declined_thesis_fails_the_run_without_a_strategy() {
    let mut declined = json!(fixture_thesis("AI"));
    declined["direction"] = json!("rejected");
    declined["exposures"] = json!([]);
    let service = live_service(stub_model(declined, json!({}), None).await);
    let owner = Uuid::new_v4();
    let id = service
        .start(owner, start("buy my friend's memecoin", Risk::Medium))
        .await
        .unwrap();
    let view = wait(&service, owner, id).await;
    assert_eq!(view.stage, Stage::Failed);
    assert!(view.proposal.is_none());
    assert!(view.progress.last().unwrap().message.contains("can't"));
}

/// Schema retry against a local stand-in for NEAR AI Cloud (no external network):
/// first reply is invalid, the second valid.
#[tokio::test]
async fn retries_once_on_invalid_output() {
    use axum::{Json, Router, routing::post};
    use std::sync::atomic::{AtomicU32, Ordering};
    let hits = Arc::new(AtomicU32::new(0));
    let counter = hits.clone();
    let app = Router::new().route(
        "/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                let content = if n == 0 {
                    "not json".to_string()
                } else {
                    json!(fixture_thesis("AI")).to_string()
                };
                Json(json!({"choices": [{"message": {"content": content}}]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let ai = NearAi::new(
        reqwest::Client::new(),
        format!("http://{addr}"),
        Some("k".into()),
    );
    let out = ai
        .json(
            &RunBudget::new(4),
            near_ai::JsonRequest {
                model: near_ai::MODEL_REASON,
                prompt_version: prompts::UNDERSTAND.version,
                system: "s",
                user: "u",
                schema_name: "Thesis",
                schema: &thesis_schema(),
                timeout: near_ai::CALL_TIMEOUT,
                think: false,
                on_text: None,
            },
            validate_thesis,
        )
        .await;
    assert!(out.value.is_some());
    assert_eq!(out.call.attempts, 2);
    assert!(!out.call.first_try_valid);
    assert_eq!(hits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn dry_run_pipeline_completes_and_is_owner_scoped() {
    let service = Arc::new(ThesisService::with_parts(
        Registry::with_assets(assets()),
        Intake::new().unwrap(),
        NearAi::new(reqwest::Client::new(), String::new(), None),
    ));
    let owner = Uuid::new_v4();
    let id = service
        .start(
            owner,
            StartThesis {
                text: Some("AI capex boom".into()),
                links: vec![],
                params: Params {
                    amount_usd: Some(1000.0),
                    risk: Some(Risk::High),
                },
            },
        )
        .await
        .unwrap();
    let view = wait(&service, owner, id).await;
    assert_eq!(view.stage, Stage::Done, "{:?}", view.progress);
    assert!(view.dry_run);
    let proposal = view.proposal.unwrap();
    assert_eq!(proposal["picks"].as_array().unwrap().len(), 3);
    assert_eq!(proposal["quoted"], false);
    assert_eq!(proposal["critic"]["verdict"], "skipped");
    assert!(service.view(Uuid::new_v4(), id).await.unwrap().is_none());
    let kinds: Vec<_> = service
        .artifacts(owner, id)
        .await
        .unwrap()
        .unwrap()
        .iter()
        .map(|a| a.kind.clone())
        .collect();
    assert_eq!(
        kinds,
        [
            "IntentRecord",
            "Thesis",
            "Shortlist",
            "Picks",
            "Critic",
            "Strategy"
        ]
    );
}

#[tokio::test]
async fn rejects_bad_input() {
    let service = Arc::new(ThesisService::with_parts(
        Registry::with_assets(vec![]),
        Intake::new().unwrap(),
        NearAi::new(reqwest::Client::new(), String::new(), None),
    ));
    let empty = StartThesis {
        text: Some("  ".into()),
        links: vec![],
        params: Params::default(),
    };
    assert!(service.start(Uuid::new_v4(), empty).await.is_err());
    let huge = StartThesis {
        text: Some("x".into()),
        links: vec![],
        params: Params {
            amount_usd: Some(f64::NAN),
            risk: None,
        },
    };
    assert!(service.start(Uuid::new_v4(), huge).await.is_err());
}

/// Two services sharing one Redis (two instances): a run started on one is readable,
/// with its artifacts, from the other; owners stay separate.
#[tokio::test]
#[ignore = "requires isolated TEST_REDIS_URL"]
async fn runs_are_shared_through_redis() {
    let url = std::env::var("TEST_REDIS_URL").expect("set isolated TEST_REDIS_URL");
    let namespace = format!("thesis-test-{}", Uuid::new_v4());
    let redis = || {
        crate::redis_store::RedisStore::new(
            redis::Client::open(url.as_str()).unwrap(),
            namespace.clone(),
            Duration::from_secs(2),
        )
    };
    let make = |store| {
        Arc::new(
            ThesisService::with_parts(
                Registry::with_assets(assets()),
                Intake::new().unwrap(),
                NearAi::new(reqwest::Client::new(), String::new(), None),
            )
            .with_store(store),
        )
    };
    let first = make(RunStore::Redis(redis()));
    let second = make(RunStore::Redis(redis()));
    let owner = Uuid::new_v4();
    let id = first
        .start(owner, start("AI capex", Risk::High))
        .await
        .unwrap();
    let view = wait(&second, owner, id).await;
    assert_eq!(view.stage, Stage::Done);
    assert!(view.proposal.is_some());
    assert!(second.view(Uuid::new_v4(), id).await.unwrap().is_none());
    assert!(
        !second
            .artifacts(owner, id)
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );
    let store = redis();
    let ttl: i64 = store
        .query(redis::cmd("TTL").arg(RunStore::redis_key(&store, id)))
        .await
        .unwrap();
    assert!(ttl > 0 && ttl <= store::RUN_TTL.as_secs() as i64);
    let _: i64 = store
        .query(redis::cmd("DEL").arg(RunStore::redis_key(&store, id)))
        .await
        .unwrap();
}
