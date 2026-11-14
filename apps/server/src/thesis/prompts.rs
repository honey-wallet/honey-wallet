//! Versioned system prompts (`prompts/*.md`). Each file starts with `<!-- <version> -->`;
//! the version is recorded with every model call and in the proposal, so a proposal can
//! be traced to the exact prompt text (R-PR-4). Change a prompt, bump its version.

use std::collections::BTreeMap;

pub struct Prompt {
    pub name: &'static str,
    pub version: &'static str,
    file: &'static str,
}

impl Prompt {
    /// The prompt text without its version line.
    pub fn body(&self) -> &'static str {
        self.file
            .split_once('\n')
            .map(|(_, rest)| rest)
            .unwrap_or("")
            .trim()
    }
}

pub const UNDERSTAND: Prompt = Prompt {
    name: "understand",
    // version: "understand/7",
    // understand/7 said (replaced 2026-11-14, when the DEX list joined the registry):
    // "What Honey can do: buy and hold tokens (long only). Through NEAR Intents it can buy crypto tokens, stablecoins, tokenized gold and, when listed, tokenized shares (Ondo, xStocks). It cannot short, use leverage, buy options, perps or prediction markets, or buy anything off chain."
    version: "understand/8",
    file: include_str!("prompts/understand.md"),
};

pub const PICK: Prompt = Prompt {
    name: "pick",
    version: "pick/4",
    file: include_str!("prompts/pick.md"),
};

pub const CRITIC: Prompt = Prompt {
    name: "critic",
    version: "critic/6",
    file: include_str!("prompts/critic.md"),
};

/// Follow-up questions on a finished strategy (`POST /theses/ask`).
pub const ASK: Prompt = Prompt {
    name: "ask",
    version: "ask/1",
    file: include_str!("prompts/ask.md"),
};

pub const ALL: [&Prompt; 4] = [&UNDERSTAND, &PICK, &CRITIC, &ASK];

pub fn versions() -> BTreeMap<String, String> {
    ALL.iter()
        .map(|p| (p.name.to_string(), p.version.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_file_carries_its_version() {
        for p in ALL {
            assert_eq!(
                p.file.lines().next(),
                Some(format!("<!-- {} -->", p.version).as_str()),
                "{}",
                p.name
            );
            assert!(p.version.starts_with(p.name));
            assert!(!p.body().contains("<!--"));
            assert!(p.body().contains("untrusted_source"), "{}", p.name);
            assert!(p.body().to_lowercase().contains("ticker"), "{}", p.name);
        }
        assert!(UNDERSTAND.body().contains("{{CATEGORIES}}"));
        assert_eq!(versions().len(), 4);
    }
}
