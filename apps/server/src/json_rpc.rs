//! One JSON-RPC 2.0 caller for the keyless public nodes the server reads (NEAR, EVM,
//! Solana), shared by jar DAO reads and portfolio balances.

use serde_json::{Value, json};

/// The 1Click API origin shared by jar buys, market data and NEAR Intents quotes.
pub const ONE_CLICK_ORIGIN: &str = "https://1click.chaindefuser.com/v0";

#[derive(Debug)]
pub enum RpcError {
    /// The node could not be reached, answered non-2xx, or sent something that is not JSON.
    Transport(String),
    /// The node answered with a JSON-RPC `error` object.
    Rpc(Value),
}

impl RpcError {
    /// NEAR's "account does not exist" error, in either of its shapes.
    pub fn is_unknown_account(&self) -> bool {
        match self {
            Self::Rpc(error) => {
                let text = error.to_string();
                text.contains("UNKNOWN_ACCOUNT") || text.contains("does not exist")
            }
            Self::Transport(_) => false,
        }
    }

    /// The `cause.name` of a NEAR RPC error (`INVALID_TRANSACTION`, `TIMEOUT_ERROR`, ...).
    pub fn cause(&self) -> Option<&str> {
        match self {
            Self::Rpc(error) => error["cause"]["name"].as_str(),
            Self::Transport(_) => None,
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(error) => write!(f, "rpc transport: {error}"),
            Self::Rpc(error) => write!(f, "rpc error: {error}"),
        }
    }
}

pub async fn call(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let response = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| RpcError::Transport(e.without_url().to_string()))?;
    // NEAR answers some errors with a non-2xx status and a JSON-RPC error body; read it.
    let status = response.status();
    let mut value: Value = response
        .json()
        .await
        .map_err(|e| RpcError::Transport(format!("{status}: {}", e.without_url())))?;
    if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
        return Err(RpcError::Rpc(error.clone()));
    }
    if !status.is_success() {
        return Err(RpcError::Transport(status.to_string()));
    }
    Ok(value["result"].take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transport_errors_never_carry_the_url() {
        // An RPC URL can hold a provider key in its path or query; it must not reach
        // an error message (and so a log).
        let client = reqwest::Client::new();
        let error = call(
            &client,
            "http://127.0.0.1:9/v1/secret-api-key?key=hunter2",
            "status",
            json!([]),
        )
        .await
        .unwrap_err();
        let text = error.to_string();
        assert!(matches!(error, RpcError::Transport(_)), "{text}");
        assert!(
            !text.contains("secret-api-key") && !text.contains("hunter2"),
            "{text}"
        );
    }
}
