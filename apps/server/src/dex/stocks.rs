//! Tokenized stocks on Solana (15 Nov): xStocks (Backed), Ondo Global Markets and
//! Backpack Securities, all Token-2022 mints. They trade, price and show like any other
//! token; what differs is how a mint becomes one of them.
//!
//! - Candidates: xStocks from the issuer's own list (`GET api.xstocks.fi/api/v2/public/
//!   assets?page=N`, keyless, every asset's Solana deployment), Ondo and Backpack from
//!   Jupiter's verified list by their issuer tag (`ondo`, `backpack`). Read once a day.
//! - Admission: the mint itself, read on chain (`getMultipleAccounts`, 100 a call): owned
//!   by the Token-2022 program, its authorities the issuer's own (pinned below, read from
//!   chain), no transfer hook program, not paused, no transfer fee, accounts not frozen by
//!   default, and no extension Honey doesn't know. A mint is classified by its address
//!   and its authorities, never by its symbol: a token called NVDAx anywhere else is an
//!   ordinary token.
//! - Their Token-2022 shapes (permanent delegate, freeze and mint authorities) would fail
//!   Honey's general scam checks; for admitted mints only those are waived ([`WAIVED`]),
//!   and a quote re-reads the mint (at most a minute old) and refuses an active hook, a
//!   pause, a fee, a default-frozen state, changed authorities, or a multiplier change
//!   within an hour ([`MULTIPLIER_GUARD_SECS`]).
//!
//! Units: these mints carry a `ScaledUiAmount` multiplier (dividends paid in more
//! shares): what a wallet shows is `raw / 10^decimals × multiplier`. Honey's prices for
//! them are per `10^decimals` raw units, like every other token (DexScreener's pools and
//! every quote count raw units); Jupiter's `usdPrice` is per shown unit, so it is
//! multiplied by the multiplier on the way in ([`raw_price`]).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::solana_relayer::TOKEN_2022_PROGRAM;

/// The xStocks list's origin.
pub const XSTOCKS_ORIGIN: &str = "https://api.xstocks.fi";
/// Pages of the xStocks list read at most (100 assets a page; 16 on 15 Nov).
pub const XSTOCKS_MAX_PAGES: usize = 40;
/// Mints per `getMultipleAccounts` call (the RPC's limit).
pub const ACCOUNTS_PER_CALL: usize = 100;
/// How long a registry stands before it is read again.
pub const REGISTRY_TTL_SECS: u64 = 24 * 60 * 60;
/// How long Redis keeps a registry (served stale while a rebuild fails).
pub const REGISTRY_KEEP_SECS: u64 = 3 * 24 * 60 * 60;
/// How old a quote's own read of the mint may be.
pub const MINT_READ_TTL_SECS: u64 = 60;
/// No quote within this many seconds either side of a scheduled multiplier change: the
/// amounts the wallet shows (and a quote's prices) jump at that moment.
pub const MULTIPLIER_GUARD_SECS: i64 = 60 * 60;

/// General scam flags waived for registry mints only: their Token-2022 shape (an issuer
/// who can mint, freeze, pause and move balances under a regulated program) and GoPlus's
/// "could be changed" forms of the hook and default state, which Honey reads on chain
/// itself at quote time. `transfer_hook` and `default_frozen` stay waived too: GoPlus
/// reported the upgradable form under those names until 15 Nov, and the on-chain read
/// refuses the active forms.
pub const WAIVED: &[&str] = &[
    "token_2022",
    "owner_can_mint",
    "freezable",
    "owner_can_change_balance",
    "transfer_hook_upgradable",
    "default_state_upgradable",
    "transfer_hook",
    "default_frozen",
];

/// Who issues a tokenized stock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Issuer {
    Xstocks,
    Ondo,
    Backpack,
}

impl Issuer {
    /// The API's name (`TokenView.issuer`).
    pub fn as_str(self) -> &'static str {
        match self {
            Issuer::Xstocks => "xstocks",
            Issuer::Ondo => "ondo",
            Issuer::Backpack => "backpack",
        }
    }

    /// How a person reads it: "Apple (xStocks)".
    pub fn label(self) -> &'static str {
        match self {
            Issuer::Xstocks => "xStocks",
            Issuer::Ondo => "Ondo",
            Issuer::Backpack => "Backpack",
        }
    }

    /// Jupiter's verified-list tag for the issuer (xStocks come from the issuer's list).
    fn jupiter_tag(self) -> &'static str {
        match self {
            Issuer::Xstocks => "xstocks",
            Issuer::Ondo => "ondo",
            Issuer::Backpack => "backpack",
        }
    }

    fn pin(self) -> &'static Pin {
        PINS.iter().find(|p| p.issuer == self).unwrap_or(&PINS[0])
    }
}

/// An issuer's authorities, as its mints carry them on chain.
pub struct Pin {
    pub issuer: Issuer,
    /// The mint authority every mint shares; None where it differs per mint (Backpack's
    /// is a per-stock key, so it isn't pinned; its freeze and admin keys are).
    pub mint_authority: Option<&'static str>,
    pub freeze_authority: &'static str,
    /// Keys any other authority on the mint may be: permanent delegate, transfer hook
    /// authority and pause authority (absent is fine too).
    pub admins: &'static [&'static str],
}

/// Read from chain on 15 Nov 2026 (`getMultipleAccounts`, jsonParsed and base64):
/// - xStocks: AAPLx `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` and TSLAx
///   `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB`: mint authority `7pt9…`, freeze and
///   pause `JDq1…`, permanent delegate, hook, metadata and confidential-transfer authority
///   `5aMN…` (multiplier authority `S7vY…`, not pinned).
/// - Ondo: SLVon `iy11ytbSGcUnrjE6Lfv78TFqxKyUESfku1FugS9ondo` and NVDAon
///   `gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo`: mint, pause, hook and metadata
///   authority `9foM…`, freeze `51QV…`; no permanent delegate.
/// - Backpack: TTWO `TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo`, NVDA
///   `NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv`, TSLA
///   `TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S` and DJT
///   `DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF`: freeze, permanent delegate, pause,
///   hook and metadata authority `2cVY…`; the mint (and multiplier) authority is a
///   different key per stock.
pub const PINS: [Pin; 3] = [
    Pin {
        issuer: Issuer::Xstocks,
        mint_authority: Some("7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj"),
        freeze_authority: "JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs",
        admins: &[
            "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq",
            "JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs",
        ],
    },
    Pin {
        issuer: Issuer::Ondo,
        mint_authority: Some("9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD"),
        freeze_authority: "51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK",
        admins: &["9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD"],
    },
    Pin {
        issuer: Issuer::Backpack,
        mint_authority: None,
        freeze_authority: "2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a",
        admins: &["2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a"],
    },
];

/// A `ScaledUiAmount` config: the multiplier now, and a scheduled one from
/// `effective_at` (unix seconds; 0 when none was ever set).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scaled {
    pub multiplier: f64,
    pub new_multiplier: f64,
    pub effective_at: i64,
}

impl Scaled {
    pub const ONE: Scaled = Scaled {
        multiplier: 1.0,
        new_multiplier: 1.0,
        effective_at: 0,
    };

    /// The multiplier in force at `now` (the program's own rule).
    pub fn effective(&self, now: i64) -> f64 {
        if self.effective_at != 0 && now >= self.effective_at {
            self.new_multiplier
        } else {
            self.multiplier
        }
    }

    /// Whether a change of multiplier takes effect within an hour of `now`, either side.
    pub fn changes_near(&self, now: i64) -> bool {
        self.effective_at != 0
            && self.new_multiplier != self.multiplier
            && (now - self.effective_at).abs() <= MULTIPLIER_GUARD_SECS
    }

    fn valid(&self) -> bool {
        let ok = |m: f64| m.is_finite() && m > 0.0 && m < 1_000.0;
        ok(self.multiplier) && ok(self.new_multiplier)
    }
}

/// What Honey reads from a Token-2022 mint's data.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MintInfo {
    pub decimals: u8,
    pub mint_authority: Option<String>,
    pub freeze_authority: Option<String>,
    pub permanent_delegate: Option<String>,
    pub hook_authority: Option<String>,
    /// The transfer hook program: any at all refuses the mint.
    pub hook_program: Option<String>,
    pub pause_authority: Option<String>,
    pub paused: bool,
    /// `TransferFeeConfig` or `ConfidentialTransferFeeConfig`.
    pub transfer_fee: bool,
    /// `DefaultAccountState` frozen.
    pub default_frozen: bool,
    pub non_transferable: bool,
    pub interest_bearing: bool,
    pub scaled: Option<Scaled>,
    /// The first extension type Honey doesn't know.
    pub unknown_extension: Option<u16>,
}

fn key_at(data: &[u8], at: usize) -> Option<[u8; 32]> {
    data.get(at..at + 32)?.try_into().ok()
}

/// A 32-byte key, None when all zero (Token-2022's `OptionalNonZeroPubkey`).
fn optional_key(data: &[u8], at: usize) -> Option<String> {
    key_at(data, at)
        .filter(|k| k.iter().any(|b| *b != 0))
        .map(|k| bs58::encode(k).into_string())
}

/// A `COption<Pubkey>`: a u32 tag (1 = some) then the key.
fn coption_key(data: &[u8], at: usize) -> Option<String> {
    let tag = u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?);
    (tag == 1).then(|| key_at(data, at + 4).map(|k| bs58::encode(k).into_string()))?
}

fn f64_at(data: &[u8], at: usize) -> Option<f64> {
    Some(f64::from_le_bytes(data.get(at..at + 8)?.try_into().ok()?))
}

/// A mint account's data (classic layout for the first 82 bytes; Token-2022 then pads to
/// 165, writes the account type 1 and its extensions as `(u16 type, u16 length, data)`).
pub fn parse_mint(data: &[u8]) -> Result<MintInfo, &'static str> {
    if data.len() < 82 || data[45] != 1 {
        return Err("not a mint");
    }
    let mut info = MintInfo {
        decimals: data[44],
        mint_authority: coption_key(data, 0),
        freeze_authority: coption_key(data, 46),
        ..MintInfo::default()
    };
    if data.len() == 82 {
        return Ok(info);
    }
    if data.len() < 166 || data[165] != 1 {
        return Err("not a Token-2022 mint");
    }
    let mut at = 166;
    while at + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = usize::from(u16::from_le_bytes([data[at + 2], data[at + 3]]));
        if kind == 0 {
            break;
        }
        let body = data
            .get(at + 4..at + 4 + len)
            .ok_or("truncated extension")?;
        let need = |n: usize| (body.len() >= n).then_some(()).ok_or("short extension");
        match kind {
            1 | 16 => info.transfer_fee = true,
            // Close authority, confidential transfers (opt-in per account), metadata and
            // group pointers and data: nothing a holder's transfer depends on.
            3 | 4 | 18 | 19 | 20 | 21 | 22 | 23 => {}
            6 => {
                need(1)?;
                info.default_frozen = body[0] == 2;
            }
            9 => info.non_transferable = true,
            10 => info.interest_bearing = true,
            12 => {
                need(32)?;
                info.permanent_delegate = optional_key(body, 0);
            }
            14 => {
                need(64)?;
                info.hook_authority = optional_key(body, 0);
                info.hook_program = optional_key(body, 32);
            }
            25 => {
                need(56)?;
                info.scaled = Some(Scaled {
                    multiplier: f64_at(body, 32).ok_or("short extension")?,
                    effective_at: i64::from_le_bytes(
                        body[40..48].try_into().map_err(|_| "short extension")?,
                    ),
                    new_multiplier: f64_at(body, 48).ok_or("short extension")?,
                });
            }
            26 => {
                need(33)?;
                info.pause_authority = optional_key(body, 0);
                info.paused = body[32] != 0;
            }
            other => {
                info.unknown_extension.get_or_insert(other);
            }
        }
        at += 4 + len;
    }
    Ok(info)
}

/// Whether `info` is one of `issuer`'s stocks Honey may trade now: the issuer's
/// authorities, and nothing that could stop or tax a transfer. The reason when not.
pub fn admit(issuer: Issuer, info: &MintInfo) -> Result<(), &'static str> {
    let pin = issuer.pin();
    if let Some(kind) = info.unknown_extension {
        tracing::info!(kind, "tokenized stock with an unknown extension");
        return Err("an extension Honey doesn't know");
    }
    if info.transfer_fee {
        return Err("a transfer fee");
    }
    if info.non_transferable || info.interest_bearing {
        return Err("not an ordinary token");
    }
    if info.hook_program.is_some() {
        return Err("an active transfer hook");
    }
    if info.paused {
        return Err("paused by its issuer");
    }
    if info.default_frozen {
        return Err("new accounts start frozen");
    }
    if pin
        .mint_authority
        .is_some_and(|m| info.mint_authority.as_deref() != Some(m))
    {
        return Err("not the issuer's mint authority");
    }
    if info.freeze_authority.as_deref() != Some(pin.freeze_authority) {
        return Err("not the issuer's freeze authority");
    }
    for key in [
        &info.permanent_delegate,
        &info.hook_authority,
        &info.pause_authority,
    ]
    .into_iter()
    .flatten()
    {
        if !pin.admins.contains(&key.as_str()) {
            return Err("an authority that isn't the issuer's");
        }
    }
    if info.scaled.is_some_and(|s| !s.valid()) {
        return Err("a bad multiplier");
    }
    Ok(())
}

/// A mint that may become a tokenized stock, from its issuer's list or tag.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub mint: String,
    pub issuer: Issuer,
    pub symbol: String,
    pub name: String,
}

fn text(v: &Value, max: usize) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(String::from)
}

fn mint(v: &Value) -> Option<String> {
    let m = v.as_str()?.trim();
    (bs58::decode(m).into_vec().ok()?.len() == 32).then(|| m.to_string())
}

/// xStocks list pages (`{ nodes: [...], page: { hasNextPage } }`) → each asset's Solana
/// deployment.
pub fn xstocks_candidates(pages: &[Value]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for page in pages {
        for asset in page["nodes"].as_array().into_iter().flatten() {
            let (Some(symbol), Some(name)) = (text(&asset["symbol"], 32), text(&asset["name"], 64))
            else {
                continue;
            };
            let Some(m) = asset["deployments"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|d| d["network"].as_str() == Some("Solana"))
                .and_then(|d| mint(&d["address"]))
            else {
                continue;
            };
            out.push(Candidate {
                mint: m,
                issuer: Issuer::Xstocks,
                symbol,
                name,
            });
        }
    }
    out
}

/// Jupiter's verified list → the mints tagged with `issuers`' tags.
pub fn jupiter_candidates(list: &Value, issuers: &[Issuer]) -> Vec<Candidate> {
    let mut out = Vec::new();
    for t in list.as_array().into_iter().flatten() {
        let tags: Vec<&str> = t["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let Some(issuer) = issuers
            .iter()
            .copied()
            .find(|i| tags.contains(&i.jupiter_tag()))
        else {
            continue;
        };
        let (Some(m), Some(symbol)) = (mint(&t["id"]), text(&t["symbol"], 32)) else {
            continue;
        };
        out.push(Candidate {
            mint: m,
            issuer,
            symbol: symbol.clone(),
            name: text(&t["name"], 96).unwrap_or(symbol),
        });
    }
    out
}

/// One admitted tokenized stock.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockEntry {
    pub mint: String,
    pub issuer: Issuer,
    pub symbol: String,
    /// The issuer's name for it ("Apple xStock").
    pub name: String,
    pub decimals: u8,
    pub scaled: Scaled,
}

impl StockEntry {
    /// The multiplier in force at `now` (unix seconds).
    pub fn multiplier(&self, now: i64) -> f64 {
        self.scaled.effective(now)
    }

    /// "Apple (xStocks)", "NVIDIA (Ondo)", "Nvidia (Backpack)".
    pub fn display_name(&self) -> String {
        display_name(self.issuer, &self.name)
    }
}

/// The company out of an issuer's name, then the issuer: "Apple xStock" → "Apple
/// (xStocks)", "NVIDIA (Ondo Tokenized)" → "NVIDIA (Ondo)", "Nvidia - Backpack
/// Securities" → "Nvidia (Backpack)".
pub fn display_name(issuer: Issuer, name: &str) -> String {
    let mut base = name.trim();
    for suffix in [
        " xStock",
        " (Ondo Tokenized)",
        " - Backpack Securities",
        " Backpack Securities",
    ] {
        if let Some(b) = base.strip_suffix(suffix) {
            base = b.trim();
        }
    }
    let base = if base.is_empty() { name.trim() } else { base };
    format!("{base} ({})", issuer.label())
}

/// Admitted tokenized stocks by mint, with when they were read.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StockRegistry {
    /// Unix seconds.
    pub built_at: u64,
    pub entries: HashMap<String, StockEntry>,
}

impl StockRegistry {
    pub fn get(&self, mint: &str) -> Option<&StockEntry> {
        self.entries.get(mint)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// A `getMultipleAccounts` (base64) answer → each account's (owner, data), in order.
pub fn accounts(body: &Value) -> Vec<Option<(String, Vec<u8>)>> {
    use base64::Engine as _;
    body["result"]["value"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| {
            let owner = v["owner"].as_str()?.to_string();
            let data = base64::engine::general_purpose::STANDARD
                .decode(v["data"][0].as_str()?)
                .ok()?;
            Some((owner, data))
        })
        .collect()
}

/// Candidates with their mint accounts (same order) → the admitted ones. A mint named
/// by two issuers, or not owned by Token-2022, is refused.
pub fn admit_all(
    candidates: &[Candidate],
    read: &[Option<(String, Vec<u8>)>],
) -> HashMap<String, StockEntry> {
    let mut named: HashMap<&str, usize> = HashMap::new();
    for c in candidates {
        *named.entry(c.mint.as_str()).or_default() += 1;
    }
    let mut out = HashMap::new();
    for (c, account) in candidates.iter().zip(read) {
        if named.get(c.mint.as_str()).copied().unwrap_or(0) != 1 {
            continue;
        }
        let Some((owner, data)) = account else {
            continue;
        };
        if owner != TOKEN_2022_PROGRAM {
            continue;
        }
        let Ok(info) = parse_mint(data) else {
            continue;
        };
        if let Err(why) = admit(c.issuer, &info) {
            tracing::debug!(mint = c.mint.as_str(), why, "tokenized stock refused");
            continue;
        }
        out.insert(
            c.mint.clone(),
            StockEntry {
                mint: c.mint.clone(),
                issuer: c.issuer,
                symbol: c.symbol.clone(),
                name: c.name.clone(),
                decimals: info.decimals,
                scaled: info.scaled.unwrap_or(Scaled::ONE),
            },
        );
    }
    out
}

/// A shown-unit price (Jupiter's `usdPrice`) as Honey's per-raw-unit price.
pub fn raw_price(ui_price: f64, multiplier: f64) -> f64 {
    ui_price * multiplier
}

/// Drops the [`WAIVED`] flags.
pub fn waive(flags: &mut Vec<String>) {
    flags.retain(|f| !WAIVED.contains(&f.as_str()));
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::json;

    pub const AAPLX: &str = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
    const NVDAON: &str = "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo";
    const NVDA_BACKPACK: &str = "NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv";

    fn fixture(text: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(text.trim())
            .unwrap()
    }

    pub fn aaplx() -> Vec<u8> {
        fixture(include_str!("fixtures/mint_xstocks_aaplx.b64"))
    }
    fn nvdaon() -> Vec<u8> {
        fixture(include_str!("fixtures/mint_ondo_nvdaon.b64"))
    }
    fn nvda_backpack() -> Vec<u8> {
        fixture(include_str!("fixtures/mint_backpack_nvda.b64"))
    }

    /// Finds an extension's body in a fixture, to edit it.
    fn ext(data: &mut [u8], kind: u16) -> std::ops::Range<usize> {
        let mut at = 166;
        loop {
            let k = u16::from_le_bytes([data[at], data[at + 1]]);
            let len = usize::from(u16::from_le_bytes([data[at + 2], data[at + 3]]));
            if k == kind {
                return at + 4..at + 4 + len;
            }
            at += 4 + len;
        }
    }

    #[test]
    fn the_live_mints_parse_and_pass() {
        let a = parse_mint(&aaplx()).unwrap();
        assert_eq!(a.decimals, 8);
        assert_eq!(
            a.permanent_delegate.as_deref(),
            Some("5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq")
        );
        assert_eq!(a.hook_program, None);
        assert!(!a.paused && !a.default_frozen && !a.transfer_fee);
        let s = a.scaled.unwrap();
        assert_eq!(s.multiplier, 1.003_269_012_539_818_7);
        assert_eq!(s.new_multiplier, 1.003_802_303_058_803_2);
        assert_eq!(s.effective_at, 1_794_447_000);
        assert_eq!(admit(Issuer::Xstocks, &a), Ok(()));

        let o = parse_mint(&nvdaon()).unwrap();
        assert_eq!((o.decimals, o.permanent_delegate.as_deref()), (9, None));
        assert_eq!(admit(Issuer::Ondo, &o), Ok(()));

        let b = parse_mint(&nvda_backpack()).unwrap();
        assert_eq!(b.decimals, 6);
        assert_eq!(admit(Issuer::Backpack, &b), Ok(()));

        // Each issuer's keys are its own.
        assert!(admit(Issuer::Ondo, &a).is_err());
        assert!(admit(Issuer::Xstocks, &b).is_err());
        assert!(admit(Issuer::Backpack, &o).is_err());
    }

    #[test]
    fn wrong_authorities_hooks_pauses_fees_and_frozen_defaults_are_refused() {
        // Another freeze authority.
        let mut d = aaplx();
        d[50] ^= 1;
        assert_eq!(
            admit(Issuer::Xstocks, &parse_mint(&d).unwrap()),
            Err("not the issuer's freeze authority")
        );
        // Another mint authority.
        let mut d = aaplx();
        d[4] ^= 1;
        assert!(admit(Issuer::Xstocks, &parse_mint(&d).unwrap()).is_err());
        // Another permanent delegate.
        let mut d = aaplx();
        let r = ext(&mut d, 12);
        d[r.start] ^= 1;
        assert_eq!(
            admit(Issuer::Xstocks, &parse_mint(&d).unwrap()),
            Err("an authority that isn't the issuer's")
        );
        // A hook program set.
        let mut d = aaplx();
        let r = ext(&mut d, 14);
        d[r.start + 32] = 7;
        assert_eq!(
            admit(Issuer::Xstocks, &parse_mint(&d).unwrap()),
            Err("an active transfer hook")
        );
        // Paused.
        let mut d = aaplx();
        let r = ext(&mut d, 26);
        d[r.start + 32] = 1;
        assert_eq!(
            admit(Issuer::Xstocks, &parse_mint(&d).unwrap()),
            Err("paused by its issuer")
        );
        // Accounts frozen by default.
        let mut d = aaplx();
        let r = ext(&mut d, 6);
        d[r.start] = 2;
        assert_eq!(
            admit(Issuer::Xstocks, &parse_mint(&d).unwrap()),
            Err("new accounts start frozen")
        );
        // A transfer fee (the default-state extension relabelled as one).
        let mut d = aaplx();
        let r = ext(&mut d, 6);
        d[r.start - 4..r.start - 2].copy_from_slice(&1u16.to_le_bytes());
        assert_eq!(
            admit(Issuer::Xstocks, &parse_mint(&d).unwrap()),
            Err("a transfer fee")
        );
        // An extension Honey doesn't know.
        let mut d = aaplx();
        let r = ext(&mut d, 6);
        d[r.start - 4..r.start - 2].copy_from_slice(&99u16.to_le_bytes());
        assert!(admit(Issuer::Xstocks, &parse_mint(&d).unwrap()).is_err());
        // Truncated data.
        assert!(parse_mint(&aaplx()[..300]).is_err());
        assert!(parse_mint(&[0u8; 40]).is_err());
    }

    #[test]
    fn candidates_come_from_the_issuer_list_and_jupiter_tags() {
        let page = json!({"nodes": [
            {"symbol": "AAPLx", "name": "Apple xStock", "deployments": [
                {"network": "Ethereum", "address": "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a"},
                {"network": "Solana", "address": AAPLX}
            ]},
            {"symbol": "BAD", "name": "No Solana", "deployments": [{"network": "Ton", "address": "x"}]},
            {"symbol": "JUNK", "name": "Bad mint", "deployments": [{"network": "Solana", "address": "nope"}]}
        ], "page": {"currentPage": 0, "hasNextPage": false}});
        let x = xstocks_candidates(&[page]);
        assert_eq!(x.len(), 1);
        assert_eq!((x[0].mint.as_str(), x[0].issuer), (AAPLX, Issuer::Xstocks));
        let list = json!([
            {"id": NVDAON, "symbol": "NVDAon", "name": "NVIDIA (Ondo Tokenized)", "tags": ["verified", "ondo"]},
            {"id": NVDA_BACKPACK, "symbol": "NVDA", "name": "Nvidia - Backpack Securities", "tags": ["backpack"]},
            {"id": AAPLX, "symbol": "AAPLx", "tags": ["xstocks"]},
            {"id": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "symbol": "JUP", "tags": ["verified"]}
        ]);
        let j = jupiter_candidates(&list, &[Issuer::Ondo, Issuer::Backpack]);
        assert_eq!(
            j.iter()
                .map(|c| (c.mint.as_str(), c.issuer))
                .collect::<Vec<_>>(),
            vec![(NVDAON, Issuer::Ondo), (NVDA_BACKPACK, Issuer::Backpack)]
        );
    }

    #[test]
    fn admission_is_by_mint_and_authorities_never_by_symbol() {
        let c = |m: &str, issuer, symbol: &str| Candidate {
            mint: m.into(),
            issuer,
            symbol: symbol.into(),
            name: symbol.into(),
        };
        let spoof = "So11111111111111111111111111111111111111112";
        let candidates = vec![
            c(AAPLX, Issuer::Xstocks, "AAPLx"),
            c(NVDAON, Issuer::Ondo, "NVDAon"),
            c(NVDA_BACKPACK, Issuer::Backpack, "NVDA"),
            // A token tagged like a stock whose mint is another issuer's shape (or a
            // classic mint) is not one.
            c(spoof, Issuer::Xstocks, "NVDAx"),
        ];
        let owned = |d: Vec<u8>| Some((TOKEN_2022_PROGRAM.to_string(), d));
        let read = vec![
            owned(aaplx()),
            owned(nvdaon()),
            owned(nvda_backpack()),
            owned(nvdaon()),
        ];
        let admitted = admit_all(&candidates, &read);
        assert_eq!(admitted.len(), 3);
        assert!(!admitted.contains_key(spoof));
        assert_eq!(admitted[AAPLX].decimals, 8);
        assert_eq!(admitted[NVDAON].issuer, Issuer::Ondo);
        // The right data under the classic program is refused too.
        let classic = vec![Some((
            crate::solana_relayer::TOKEN_PROGRAM.to_string(),
            aaplx(),
        ))];
        assert!(admit_all(&candidates[..1], &classic).is_empty());
        // A mint two issuers both claim is nobody's.
        let twice = vec![
            c(AAPLX, Issuer::Xstocks, "AAPLx"),
            c(AAPLX, Issuer::Ondo, "AAPLx"),
        ];
        assert!(admit_all(&twice, &[owned(aaplx()), owned(aaplx())]).is_empty());
    }

    #[test]
    fn multipliers_and_the_hour_either_side_of_a_change() {
        let s = parse_mint(&aaplx()).unwrap().scaled.unwrap();
        let at = s.effective_at;
        assert_eq!(s.effective(at - 1), s.multiplier);
        assert_eq!(s.effective(at), s.new_multiplier);
        assert!(s.changes_near(at - 3_600) && s.changes_near(at + 3_600));
        assert!(!s.changes_near(at - 3_601) && !s.changes_near(at + 3_601));
        // No change scheduled, or one to the same value: never refused.
        assert!(!Scaled::ONE.changes_near(0));
        let same = Scaled {
            effective_at: at,
            new_multiplier: s.multiplier,
            ..s
        };
        assert!(!same.changes_near(at));
        assert!((raw_price(355.4, 1.0038) - 356.75).abs() < 0.01);
    }

    #[test]
    fn display_names() {
        assert_eq!(
            display_name(Issuer::Xstocks, "Apple xStock"),
            "Apple (xStocks)"
        );
        assert_eq!(
            display_name(Issuer::Ondo, "NVIDIA (Ondo Tokenized)"),
            "NVIDIA (Ondo)"
        );
        assert_eq!(
            display_name(Issuer::Backpack, "Nvidia - Backpack Securities"),
            "Nvidia (Backpack)"
        );
        let mut flags = vec!["token_2022".to_string(), "low_liquidity".to_string()];
        waive(&mut flags);
        assert_eq!(flags, vec!["low_liquidity"]);
    }
}
