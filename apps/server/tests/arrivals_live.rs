//! Live: reads real balances of well-known public addresses on every chain the arrival
//! watcher covers and runs them through its diff. No push is sent and nothing is stored
//! outside this process. Run with
//! `cargo test -p honey-server --test arrivals_live -- --ignored --nocapture`.

use honey_server::{
    arrivals::{MemoryStore, Observation, diff, observe},
    market_data::MarketData,
    portfolio::{Addresses, PortfolioService},
};

/// vitalik.eth, a large Solana account (Binance's hot wallet) and the `near` account.
const EVM: &str = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOLANA: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const NEAR: &str = "near";

#[tokio::test]
#[ignore = "live network: reads public nodes"]
async fn reads_real_balances_on_every_chain_without_pushing() {
    let service = PortfolioService::new(MarketData::new().ok()).unwrap();
    let addresses = Addresses::parse(Some(EVM), Some(SOLANA), Some(NEAR)).unwrap();
    let chains = service.chains(&addresses);
    assert_eq!(
        chains,
        // ["Ethereum", "Base", "Arbitrum", "Polygon", "Solana", "NEAR"]
        [
            "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Solana", "NEAR"
        ]
    );
    let reading = service.balances(&addresses, false).await;
    for chain in &chains {
        let held: Vec<_> = reading
            .holdings
            .iter()
            .filter(|h| h.chain == *chain)
            .map(|h| format!("{} {}", h.amount, h.symbol))
            .collect();
        println!(
            "{chain}: {} {:?}",
            if reading.unavailable.contains(chain) {
                "unavailable"
            } else {
                "ok"
            },
            held
        );
    }
    let answered: Vec<_> = chains
        .iter()
        .filter(|c| !reading.unavailable.contains(c))
        .collect();
    assert!(
        answered.len() >= 4,
        "too many chains unavailable: {:?}",
        reading.unavailable
    );
    assert!(!reading.holdings.is_empty());

    // A first reading is a baseline; the same reading again tells nothing.
    let (arrivals, baseline) = diff(None, &reading, &chains);
    assert!(arrivals.is_empty());
    let (arrivals, _) = diff(Some(&baseline), &reading, &chains);
    assert!(arrivals.is_empty());
    let store = MemoryStore::default();
    let (first, _) = observe(&store, "live", &reading, &chains).await.unwrap();
    assert_eq!(first, Observation::Baseline);
    let again = service.balances(&addresses, false).await;
    let (second, _) = observe(&store, "live", &again, &chains).await.unwrap();
    // Busy public accounts may really receive something between the two reads.
    println!("second reading: {second:?}");
}
