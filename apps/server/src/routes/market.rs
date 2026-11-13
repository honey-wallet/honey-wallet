//! Public market data for jars: where a token trades (for routing), the newest
//! pools, and a pool's daily price history. No sign-in; answers are cached.

use crate::{
    error::AppError,
    market_data::{
        ChartRange, History, MarketData, MarketListing, NewPool, TokenChart, TokenInfo,
        TokenMarket, Venues,
    },
};
use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use serde::Deserialize;
use std::sync::Arc;

pub fn router(market: Arc<MarketData>) -> Router {
    Router::new()
        .route("/market/venues", get(venues))
        .route("/market/token", get(token))
        .route("/market/tokens", get(tokens))
        .route("/market/new-pools", get(new_pools))
        .route("/market/history", get(history))
        .route("/market/info", get(info))
        .route("/market/chart", get(chart))
        .route("/market/logos", get(logos))
        .with_state(market)
}

#[derive(Deserialize)]
struct SymbolQuery {
    symbol: String,
}

#[derive(Deserialize)]
struct ChartQuery {
    symbol: String,
    range: String,
}

#[derive(Deserialize)]
struct ChainQuery {
    chain: Option<String>,
}

#[derive(Deserialize)]
struct PoolQuery {
    chain: String,
    pool: String,
}

fn bad(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}

/// A symbol as Honey lists them: 1-20 letters, digits, dots or dashes.
fn valid_symbol(symbol: &str) -> Result<&str, AppError> {
    let symbol = symbol.trim();
    if symbol.is_empty()
        || symbol.len() > 20
        || !symbol
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(bad("symbol must be 1-20 letters or digits"));
    }
    Ok(symbol)
}

/// `GET /market/info?symbol=cbBTC`: About text, website, explorer, logo, caps and supply
/// (CoinGecko, by the id the 1Click list gives the token).
async fn info(
    State(market): State<Arc<MarketData>>,
    Query(q): Query<SymbolQuery>,
) -> Result<Json<TokenInfo>, AppError> {
    market
        .token_info(valid_symbol(&q.symbol)?)
        .await
        .map(Json)
        .map_err(|_| AppError::Unsupported("no details for this token".into()))
}

/// `GET /market/logos`: a logo URL for every symbol 1Click lists, `{ "AAVE": "https://…" }`.
async fn logos(
    State(market): State<Arc<MarketData>>,
) -> Result<Json<std::collections::BTreeMap<String, String>>, AppError> {
    market
        .token_logos()
        .await
        .map(|logos| Json((*logos).clone()))
        .map_err(|_| AppError::Unsupported("token logos unavailable".into()))
}

/// `GET /market/chart?symbol=cbBTC&range=1W`: USD prices for 1H, 1D, 1W, 1M, 1Y or All.
async fn chart(
    State(market): State<Arc<MarketData>>,
    Query(q): Query<ChartQuery>,
) -> Result<Json<TokenChart>, AppError> {
    let symbol = valid_symbol(&q.symbol)?;
    let range = ChartRange::parse(q.range.trim())
        .ok_or_else(|| bad("range must be 1H, 1D, 1W, 1M, 1Y or All"))?;
    market
        .token_chart(symbol, range)
        .await
        .map(Json)
        .map_err(|_| AppError::Unsupported("no price history for this token".into()))
}

/// `GET /market/tokens`: Search's list. Every symbol 1Click can deliver on Honey's chains,
/// with its live 1Click price, the coin's name, logo, market cap and 24h volume and change
/// (CoinGecko), wrapped copies folded into their coin, ranked by market cap.
async fn tokens(
    State(market): State<Arc<MarketData>>,
) -> Result<Json<Vec<MarketListing>>, AppError> {
    market.listing().await.map(Json).map_err(|_| AppError::Busy)
}

/// `GET /market/token?symbol=ETH`: price, 24h change, volume, liquidity and caps.
async fn token(
    State(market): State<Arc<MarketData>>,
    Query(q): Query<SymbolQuery>,
) -> Result<Json<TokenMarket>, AppError> {
    let symbol = q.symbol.trim();
    if symbol.is_empty()
        || symbol.len() > 20
        || !symbol
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(bad("symbol must be 1-20 letters or digits"));
    }
    market
        .token_market(symbol)
        .await
        .map(Json)
        .map_err(|_| AppError::Unsupported("no market data for this token".into()))
}

async fn venues(
    State(market): State<Arc<MarketData>>,
    Query(q): Query<SymbolQuery>,
) -> Result<Json<Venues>, AppError> {
    let symbol = q.symbol.trim();
    if symbol.is_empty()
        || symbol.len() > 20
        || !symbol
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(bad("symbol must be 1-20 letters or digits"));
    }
    market
        .venues(symbol)
        .await
        .map(Json)
        .map_err(|_| AppError::Busy)
}

async fn new_pools(
    State(market): State<Arc<MarketData>>,
    Query(q): Query<ChainQuery>,
) -> Result<Json<Vec<NewPool>>, AppError> {
    market
        .new_pools(q.chain.as_deref())
        .await
        .map(Json)
        .map_err(|_| AppError::Busy)
}

async fn history(
    State(market): State<Arc<MarketData>>,
    Query(q): Query<PoolQuery>,
) -> Result<Json<History>, AppError> {
    market
        .history(&q.chain, &q.pool)
        .await
        .map(Json)
        .map_err(|_| AppError::Busy)
}
