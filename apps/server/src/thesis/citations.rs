//! Citations, as Claude shows them: the pages a run read (links the user pasted and the
//! news search) are numbered, the models cite them inline with markers like `[1]`, and
//! the answer carries the numbered list. Code checks every marker: one that points at no
//! source is removed, and only http(s) pages are ever listed.

use super::intake::{self, LinkContent, LinkResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// At most this many sources are numbered for one answer.
pub const MAX_SOURCES: usize = 8;
const MAX_TITLE: usize = 140;

/// One numbered source: what a `[n]` marker points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub n: u32,
    pub url: String,
    pub title: String,
    /// The site, without `www.` ("reuters.com").
    pub domain: String,
}

/// A page Honey may list: http or https, with a host.
pub fn web_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    rest.is_some_and(|r| {
        let host = r.split(['/', '?', '#']).next().unwrap_or("");
        !host.is_empty() && !host.contains(char::is_whitespace)
    })
}

/// "reuters.com" from "https://www.reuters.com/markets/…".
pub fn domain(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    host.trim_start_matches("www.").to_ascii_lowercase()
}

fn source(n: u32, url: &str, title: Option<&str>) -> Source {
    let domain = domain(url);
    let title = title
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|t| !t.is_empty())
        .map(|t| clip(&t, MAX_TITLE))
        .unwrap_or_else(|| domain.clone());
    Source {
        n,
        url: url.trim().to_string(),
        title,
        domain,
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The pages a run read, numbered from 1 in the order the models see them, each with
/// its content. Unreadable links and anything that isn't http(s) are left out.
pub fn numbered(links: &[LinkResult]) -> Vec<(Source, &LinkContent)> {
    let mut out: Vec<(Source, &LinkContent)> = Vec::new();
    for link in links {
        let LinkResult::Read(content) = link else {
            continue;
        };
        if !web_url(&content.final_url) || out.iter().any(|(s, _)| s.url == content.final_url) {
            continue;
        }
        if out.len() == MAX_SOURCES {
            break;
        }
        let n = out.len() as u32 + 1;
        out.push((
            source(n, &content.final_url, content.title.as_deref()),
            content,
        ));
    }
    out
}

/// The sources as the models read them: each quoted block under its number.
pub fn prompt_block(sources: &[(Source, &LinkContent)]) -> String {
    let mut out = String::new();
    for (s, content) in sources {
        out.push_str(&format!(
            "Source [{}]:\n{}\n",
            s.n,
            intake::untrusted_block(content)
        ));
    }
    out
}

/// Sources from a stored `IntentRecord` (a finished run read back from the store).
pub fn from_intent(intent: &Value) -> Vec<Source> {
    let mut out: Vec<Source> = Vec::new();
    for link in intent["links"].as_array().into_iter().flatten() {
        if link["status"] != "read" {
            continue;
        }
        let Some(url) = link["finalUrl"].as_str().or(link["url"].as_str()) else {
            continue;
        };
        if !web_url(url) || out.iter().any(|s| s.url == url) || out.len() == MAX_SOURCES {
            continue;
        }
        out.push(source(out.len() as u32 + 1, url, link["title"].as_str()));
    }
    out
}

/// Adds pages to `list`, numbered after it, skipping any already there (a follow-up
/// adds fresh news under the run's own sources).
pub fn append(list: &mut Vec<Source>, more: &[LinkContent]) {
    for content in more {
        if list.len() == MAX_SOURCES {
            break;
        }
        if !web_url(&content.final_url) || list.iter().any(|s| s.url == content.final_url) {
            continue;
        }
        let n = list.len() as u32 + 1;
        list.push(source(n, &content.final_url, content.title.as_deref()));
    }
}

/// Keeps the citation markers that point at a source (`1..=count`) and removes the rest.
/// "[1, 3]" and "[1][3]" both come out as "[1][3]"; a marker with nothing valid in it is
/// dropped with the space before it. Brackets that aren't markers are left alone.
pub fn clean_markers(text: &str, count: usize) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let (before, from) = rest.split_at(open);
        out.push_str(before);
        let Some(close) = from.find(']') else {
            out.push_str(from);
            return tidy(&out);
        };
        let inside = &from[1..close];
        let numbers: Option<Vec<u32>> = if inside.trim().is_empty() {
            None
        } else {
            inside
                .split(',')
                .map(|n| n.trim().parse::<u32>().ok())
                .collect()
        };
        match numbers {
            Some(ns) => {
                let mut kept: Vec<u32> = Vec::new();
                for n in ns {
                    if n >= 1 && (n as usize) <= count && !kept.contains(&n) {
                        kept.push(n);
                    }
                }
                if kept.is_empty() {
                    while out.ends_with(' ') {
                        out.pop();
                    }
                } else {
                    for n in kept {
                        out.push_str(&format!("[{n}]"));
                    }
                }
            }
            // Not a marker ("[sic]"): keep it as written.
            None => out.push_str(&from[..=close]),
        }
        rest = &from[close + 1..];
    }
    out.push_str(rest);
    tidy(&out)
}

/// No space left before punctuation where a dropped marker sat.
fn tidy(text: &str) -> String {
    let mut out = text.to_string();
    for p in [" .", " ,", " ;", " :", " !", " ?"] {
        while out.contains(p) {
            out = out.replace(p, &p[1..]);
        }
    }
    out
}

/// The numbers a text cites, in order, once each.
pub fn cited(text: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let from = &rest[open..];
        let Some(close) = from.find(']') else { break };
        if let Ok(n) = from[1..close].trim().parse::<u32>()
            && !out.contains(&n)
        {
            out.push(n);
        }
        rest = &from[close + 1..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::thesis::intake::FetchedVia;
    use serde_json::json;

    fn page(url: &str, title: Option<&str>) -> LinkResult {
        LinkResult::Read(LinkContent {
            url: url.into(),
            final_url: url.into(),
            title: title.map(Into::into),
            text: "Body.".into(),
            author: None,
            published_at: None,
            fetched_via: FetchedVia::Linkup,
        })
    }

    #[test]
    fn numbers_only_readable_web_pages_once_each() {
        let links = vec![
            page(
                "https://www.reuters.com/markets/ai",
                Some("AI  capex\nslows"),
            ),
            LinkResult::Unreadable {
                url: "https://x.com/a".into(),
                reason: "blocked".into(),
            },
            page("ftp://files.example/a", None),
            page("javascript:alert(1)", None),
            page("https://www.reuters.com/markets/ai", None),
            page("http://news.example/b", None),
        ];
        let sources: Vec<Source> = numbered(&links).into_iter().map(|(s, _)| s).collect();
        assert_eq!(
            sources,
            vec![
                Source {
                    n: 1,
                    url: "https://www.reuters.com/markets/ai".into(),
                    title: "AI capex slows".into(),
                    domain: "reuters.com".into(),
                },
                Source {
                    n: 2,
                    url: "http://news.example/b".into(),
                    title: "news.example".into(),
                    domain: "news.example".into(),
                },
            ]
        );
        let block = prompt_block(&numbered(&links));
        assert!(block.starts_with("Source [1]:\n<untrusted_source"));
        assert!(block.contains("Source [2]:"));
    }

    #[test]
    fn markers_that_point_nowhere_are_removed() {
        assert_eq!(
            clean_markers("Chips slow [1]. Gold holds [4]. Both [1, 2, 9].", 2),
            "Chips slow [1]. Gold holds. Both [1][2]."
        );
        assert_eq!(clean_markers("None [0] here [x].", 3), "None here [x].");
        assert_eq!(
            clean_markers("Twice [2][2] and [ 1 ]", 2),
            "Twice [2][2] and [1]"
        );
        assert_eq!(clean_markers("Open [1", 2), "Open [1");
        assert_eq!(clean_markers("No sources [1].", 0), "No sources.");
        assert_eq!(cited("A [2]. B [1][2]. C [x]"), vec![2, 1]);
    }

    #[test]
    fn only_web_urls() {
        assert!(web_url("https://reuters.com/a"));
        assert!(web_url("HTTP://news.example"));
        assert!(!web_url("javascript:alert(1)"));
        assert!(!web_url("data:text/html,hi"));
        assert!(!web_url("https://"));
        assert_eq!(
            domain("https://user@www.Reuters.com:443/x?y"),
            "reuters.com"
        );
    }

    #[test]
    fn reads_sources_back_from_a_stored_intent() {
        let intent = json!({"links": [
            {"status": "read", "url": "https://a.example/1", "finalUrl": "https://a.example/1", "title": "One"},
            {"status": "unreadable", "url": "https://b.example", "reason": "x"},
            {"status": "read", "finalUrl": "javascript:alert(1)"},
            {"status": "read", "finalUrl": "https://c.example/3"},
        ]});
        let s = from_intent(&intent);
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].n, s[0].title.as_str()), (1, "One"));
        assert_eq!((s[1].n, s[1].domain.as_str()), (2, "c.example"));
        let mut list = s.clone();
        append(
            &mut list,
            &[LinkContent {
                url: "https://d.example".into(),
                final_url: "https://d.example".into(),
                title: Some("Four".into()),
                text: String::new(),
                author: None,
                published_at: None,
                fetched_via: FetchedVia::Linkup,
            }],
        );
        assert_eq!(list.last().map(|s| s.n), Some(3));
    }
}
