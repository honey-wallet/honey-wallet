//! News search for the research stage, through Linkup. Results join the run's
//! sources as untrusted text, exactly like links the user pasted.

use super::intake::{FetchedVia, LinkContent};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

pub const DEFAULT_BASE_URL: &str = "https://api.linkup.so/v1";
const MAX_RESULTS: usize = 5;
const MAX_CHARS: usize = 2_000;

#[derive(Clone)]
pub struct Linkup {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
}

#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    results: Vec<Hit>,
}

#[derive(Deserialize)]
struct Hit {
    #[serde(default)]
    name: String,
    url: String,
    #[serde(default)]
    content: String,
}

impl Linkup {
    pub fn new(client: reqwest::Client, base_url: String, api_key: Option<String>) -> Self {
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
        }
    }

    pub fn enabled(&self) -> bool {
        self.api_key.is_some()
    }

    /// Recent coverage of the idea; empty on any failure (research is best effort).
    pub async fn search(&self, idea: &str) -> Vec<LinkContent> {
        let Some(key) = &self.api_key else {
            return Vec::new();
        };
        let query: String = idea.chars().take(400).collect();
        let sent = self
            .client
            .post(format!("{}/search", self.base_url))
            .bearer_auth(key)
            .timeout(Duration::from_secs(20))
            .json(&json!({ "q": query, "depth": "standard", "outputType": "searchResults" }))
            .send()
            .await;
        let Ok(response) = sent.and_then(|r| r.error_for_status()) else {
            tracing::warn!("linkup search failed");
            return Vec::new();
        };
        let Ok(body) = response.json::<Response>().await else {
            return Vec::new();
        };
        parse(body)
    }
}

fn parse(body: Response) -> Vec<LinkContent> {
    body.results
        .into_iter()
        .filter(|h| h.url.starts_with("https://") && !h.content.trim().is_empty())
        .take(MAX_RESULTS)
        .map(|h| LinkContent {
            url: h.url.clone(),
            final_url: h.url,
            title: Some(h.name).filter(|n| !n.trim().is_empty()),
            text: h.content.chars().take(MAX_CHARS).collect(),
            author: None,
            published_at: None,
            fetched_via: FetchedVia::Linkup,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_https_results_with_text_and_caps_them() {
        let body: Response = serde_json::from_value(json!({ "results": [
            { "type": "text", "name": "Capex", "url": "https://news.example/a", "content": "x".repeat(5_000) },
            { "type": "text", "name": "Plain", "url": "http://news.example/b", "content": "text" },
            { "type": "text", "name": "Empty", "url": "https://news.example/c", "content": " " },
        ]}))
        .unwrap();
        let out = parse(body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title.as_deref(), Some("Capex"));
        assert_eq!(out[0].text.chars().count(), MAX_CHARS);
    }

    #[tokio::test]
    async fn without_a_key_returns_nothing() {
        let l = Linkup::new(reqwest::Client::new(), DEFAULT_BASE_URL.into(), None);
        assert!(!l.enabled());
        assert!(l.search("ai capex").await.is_empty());
    }
}
