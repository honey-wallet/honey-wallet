//! Public market data for jars: where a token trades (for routing), the newest
//! pools, and a pool's daily price history. No sign-in; answers are cached.

use crate::{
    error::AppError,
    market_data::{
        History, MarketData, MarketListToken, NewPool, TokenMarket, Venues, market_list,
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
        .with_state(market)
}

#[derive(Deserialize)]
struct SymbolQuery {
    symbol: String,
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

/// `GET /market/tokens`: every symbol 1Click can deliver on Honey's chains, with its
/// live 1Click price (Search's list; 24h numbers come from `/market/token`).
async fn tokens(
    State(market): State<Arc<MarketData>>,
) -> Result<Json<Vec<MarketListToken>>, AppError> {
    market
        .tokens()
        .await
        .map(|t| Json(market_list(&t)))
        .map_err(|_| AppError::Busy)
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
