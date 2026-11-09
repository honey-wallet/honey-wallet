//! `honey-server invite-waitlist`: one-shot "you're off the waitlist" emails via Resend.
//!
//! Oldest uninvited rows first. Each send carries `Idempotency-Key: waitlist-invite-<id>`,
//! so a rerun after a crash between send and the `invited_at` update does not email twice
//! (Resend keeps keys for 24 hours). Per-address failures are counted and skipped.

use std::{future::Future, time::Duration};

use anyhow::Context;
use serde::Deserialize;
use sqlx::PgPool;

pub const DEFAULT_LIMIT: i64 = 50;
pub const MAX_LIMIT: i64 = 500;
pub const DEFAULT_FROM: &str = "Honey <team@honeywallet.org>";
pub const RESEND_API_BASE: &str = "https://api.resend.com";
pub const SUBJECT: &str = "You're in: Honey is ready";
/// Resend's default limit is 2 requests per second.
pub const SEND_SPACING: Duration = Duration::from_millis(600);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub limit: i64,
    pub dry_run: bool,
    pub email: Option<String>,
}

impl Options {
    /// Parses `[--limit N] [--dry-run] [--email ADDRESS]`.
    pub fn parse<I: IntoIterator<Item = String>>(args: I) -> anyhow::Result<Self> {
        const USAGE: &str =
            "usage: honey-server invite-waitlist [--limit N] [--dry-run] [--email ADDRESS]";
        let mut options = Self {
            limit: DEFAULT_LIMIT,
            dry_run: false,
            email: None,
        };
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--dry-run" => options.dry_run = true,
                "--limit" => {
                    let value = args.next().context(USAGE)?;
                    options.limit = value
                        .parse::<i64>()
                        .ok()
                        .filter(|n| (1..=MAX_LIMIT).contains(n))
                        .with_context(|| {
                            format!("--limit must be an integer from 1 to {MAX_LIMIT}")
                        })?;
                }
                "--email" => {
                    let value = args.next().context(USAGE)?.trim().to_lowercase();
                    anyhow::ensure!(value.contains('@'), "--email must be an email address");
                    options.email = Some(value);
                }
                _ => anyhow::bail!(USAGE),
            }
        }
        Ok(options)
    }
}

/// Default device-aware link: apps/web/vercel.json redirects /get by user agent to the App
/// Store, Google Play or the Chrome Web Store.
pub const DEFAULT_GET_URL: &str = "https://www.honeywallet.org/get";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Links {
    /// The "Get Honey" button and hero link (`INVITE_GET_URL`); `None` means
    /// [`DEFAULT_GET_URL`].
    pub get: Option<String>,
    pub ios: Option<String>,
    pub android: Option<String>,
    pub extension: Option<String>,
}

impl Links {
    pub fn get_url(&self) -> &str {
        self.get.as_deref().unwrap_or(DEFAULT_GET_URL)
    }

    /// Configured stores in display order: App Store, Google Play, Chrome Web Store.
    pub fn stores(&self) -> Vec<Store<'_>> {
        [
            ("App Store", &self.ios),
            ("Google Play", &self.android),
            ("Chrome", &self.extension),
        ]
        .into_iter()
        .filter_map(|(label, url)| url.as_deref().map(|url| Store { label, url }))
        .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Store<'a> {
    pub label: &'static str,
    pub url: &'a str,
}

#[derive(Clone)]
pub struct InviteConfig {
    pub api_key: Option<String>,
    pub api_base: String,
    pub from: String,
    pub reply_to: Option<String>,
    pub links: Links,
}

impl std::fmt::Debug for InviteConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InviteConfig")
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("api_base", &self.api_base)
            .field("from", &self.from)
            .field("reply_to", &self.reply_to)
            .field("links", &self.links)
            .finish()
    }
}

impl InviteConfig {
    pub fn from_env(dry_run: bool) -> anyhow::Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok(), dry_run)
    }

    /// Reads settings through `lookup`; blank values count as unset.
    pub fn from_lookup(
        lookup: impl Fn(&str) -> Option<String>,
        dry_run: bool,
    ) -> anyhow::Result<Self> {
        let get = |name: &str| {
            lookup(name)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let url = |name: &str| -> anyhow::Result<Option<String>> {
            let Some(value) = get(name) else {
                return Ok(None);
            };
            anyhow::ensure!(
                value.starts_with("https://") && !value.contains(['"', '<', '>', ' ']),
                "{name} must be an https URL"
            );
            Ok(Some(value))
        };
        let links = Links {
            get: url("INVITE_GET_URL")?,
            ios: url("INVITE_IOS_URL")?,
            android: url("INVITE_ANDROID_URL")?,
            extension: url("INVITE_EXTENSION_URL")?,
        };
        let api_key = get("RESEND_API_KEY");
        if !dry_run {
            anyhow::ensure!(api_key.is_some(), "RESEND_API_KEY is required");
            anyhow::ensure!(
                !links.stores().is_empty(),
                "set at least one of INVITE_IOS_URL, INVITE_ANDROID_URL, INVITE_EXTENSION_URL"
            );
        }
        Ok(Self {
            api_key,
            api_base: get("RESEND_API_BASE").unwrap_or_else(|| RESEND_API_BASE.to_owned()),
            from: get("INVITE_FROM").unwrap_or_else(|| DEFAULT_FROM.to_owned()),
            reply_to: get("INVITE_REPLY_TO"),
            links,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Email {
    pub subject: &'static str,
    pub html: String,
    pub text: String,
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Where the logo, hero and store icons are hosted (apps/web/public/email/, built by
/// apps/web/scripts/invite-hero.sh). They load only once the web app is deployed.
pub const ASSET_BASE: &str = "https://www.honeywallet.org/email";

/// Renders one invite: logo, headline, place in line, store buttons, then the app hero.
pub fn render(links: &Links) -> Email {
    render_with_assets(links, ASSET_BASE)
}

/// [`render`] with images from `asset_base` (local previews before the web deploy).
///
/// Warm charcoal with a lighter rounded card and a honey accent, sized to fit about one
/// screen with the store buttons above the fold. Everything is inline on nested tables
/// with `bgcolor` fallbacks; dark-mode locks keep Gmail's apps from inverting it. URLs are operator config. Never
/// contains the recipient's address.
pub fn render_with_assets(links: &Links, asset_base: &str) -> Email {
    const BG: &str = "#1c1b1a";
    const CARD: &str = "#242220";
    const TEXT: &str = "#f6f3eb";
    const TEXT_2: &str = "#a8a197";
    const WHITE: &str = "#ffffff";
    const SANS: &str =
        "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const SIGN_OFF: &str = "Hit reply, it comes to me. &mdash; Abhishek";
    // Gmail's app dark mode inverts colors but not background images, so every background
    // also carries a one-color gradient. Text is restored by the screen/difference blend
    // wrappers below (styled only in Gmail via `u + .body`); inline styles stay primary.
    const HEAD_STYLE: &str = "<style>u + .body .gmail-blend-screen{background:#000;mix-blend-mode:screen;}u + .body .gmail-blend-difference{background:#000;mix-blend-mode:difference;}</style>";
    let lock = |color: &str| {
        format!("background-color:{color};background-image:linear-gradient({color},{color});")
    };
    let blend = |inner: &str| {
        format!(
            r#"<div class="gmail-blend-screen"><div class="gmail-blend-difference">{inner}</div></div>"#
        )
    };
    let (bg_lock, card_lock) = (lock(BG), lock(CARD));
    let stores = links.stores();
    let get_url = links.get_url();
    let base = escape(asset_base.trim_end_matches('/'));

    // One CTA: "Get Honey" (an image, so no client can invert or restyle it) to the
    // device-aware /get link. Specific stores follow as small grey text links.
    let get_button = format!(
        r#"<a href="{get_url}" target="_blank" style="text-decoration:none;"><img src="{base}/btn-get-honey.png" width="560" height="52" alt="Get Honey" style="display:block;width:100%;height:auto;border:0;color:{TEXT};font-family:{SANS};font-size:16px;"></a>"#
    );
    // The store line's descender space eats 2px of the 40px gap to the hero card.
    let cta_bottom = if stores.is_empty() { 40 } else { 38 };
    let store_links = if stores.is_empty() {
        String::new()
    } else {
        let items: Vec<String> = stores
            .iter()
            .map(|store| {
                format!(
                    r#"<a href="{url}" target="_blank" style="color:{TEXT_2};text-decoration:underline;">{label}</a>"#,
                    url = store.url,
                    label = store.label,
                )
            })
            .collect();
        let line = blend(&format!("Or open {}", items.join(" &middot; ")));
        format!(
            r#"<tr><td style="padding:11px 0 0 0;font-family:{SANS};font-size:13px;line-height:20px;color:{TEXT_2};">{line}</td></tr>"#
        )
    };

    let wordmark = blend("Honey");
    let headline = blend("You're in.");
    let line = blend("You're off the waitlist.");
    let sign_off = blend(SIGN_OFF);
    let footer = blend(&format!(
        r#"You joined the waitlist at <a href="https://www.honeywallet.org" target="_blank" style="color:{TEXT_2};text-decoration:none;">honeywallet.org</a>."#
    ));

    let html = format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>{SUBJECT}</title>{HEAD_STYLE}</head>
<body class="body" bgcolor="{BG}" style="margin:0;padding:0;{bg_lock}color:{TEXT};font-family:{SANS};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">You're off the waitlist. Get Honey on your phone or in Chrome.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{BG}" style="{bg_lock}"><tr><td align="center" bgcolor="{BG}" style="{bg_lock}padding:40px 24px 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 0 33px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 8px 0 0;vertical-align:middle;"><img src="{base}/icon-honey.png" width="32" height="28" alt="" style="display:block;border:0;"></td><td style="vertical-align:middle;font-family:{SANS};font-size:18px;line-height:28px;font-weight:700;color:{TEXT};">{wordmark}</td></tr></table></td></tr>
<tr><td style="padding:0 0 5px 0;font-family:{SANS};font-size:44px;line-height:48px;font-weight:800;letter-spacing:-1.2px;color:{WHITE};">{headline}</td></tr>
<tr><td style="padding:0 0 35px 0;font-family:{SANS};font-size:17px;line-height:24px;color:{TEXT_2};">{line}</td></tr>
<tr><td style="padding:0 0 {cta_bottom}px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>{get_button}</td></tr>{store_links}</table></td></tr>
<tr><td bgcolor="{CARD}" style="{card_lock}border-radius:20px;padding:0;font-size:0;line-height:0;"><a href="{get_url}" target="_blank" style="text-decoration:none;"><img src="{base}/invite-hero.png" width="560" height="340" alt="The Honey app: your wallet and a $500 basket from the thesis agent" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:20px;color:{TEXT_2};font-family:{SANS};font-size:13px;"></a></td></tr>
<tr><td style="padding:35px 0 0 0;font-family:{SANS};font-size:15px;line-height:22px;color:{TEXT};">{sign_off}</td></tr>
<tr><td style="padding:11px 0 0 0;font-family:{SANS};font-size:12px;line-height:18px;color:{TEXT_2};">{footer}</td></tr>
</table></td></tr></table>
</body></html>"#
    );

    let mut text = format!("You're in.\nYou're off the waitlist.\n\nGet Honey: {get_url}\n");
    for store in &stores {
        text.push_str(&format!("{}: {}\n", store.label, store.url));
    }
    text.push_str(
        "\nHit reply, it comes to me. -- Abhishek\n\n--\nYou joined the waitlist at honeywallet.org.\n",
    );
    Email {
        subject: SUBJECT,
        html,
        text,
    }
}

/// `jane@example.com` -> `j***@example.com`, for logs and dry runs.
pub fn redact(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let first = local.chars().next().map(String::from).unwrap_or_default();
            format!("{first}***@{domain}")
        }
        None => "***".to_owned(),
    }
}

pub fn idempotency_key(id: i64) -> String {
    format!("waitlist-invite-{id}")
}

#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("resend rejected the email (HTTP {status}, {name})")]
    Rejected { status: u16, name: String },
    #[error("resend request failed")]
    Transport,
}

pub struct ResendClient {
    http: reqwest::Client,
    api_base: String,
    api_key: String,
    from: String,
    reply_to: Option<String>,
}

#[derive(Deserialize)]
struct SendResponse {
    id: String,
}

#[derive(Deserialize, Default)]
struct ErrorResponse {
    #[serde(default)]
    name: String,
}

impl ResendClient {
    pub fn new(config: &InviteConfig) -> anyhow::Result<Self> {
        let api_key = config
            .api_key
            .clone()
            .context("RESEND_API_KEY is required")?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .context("http client")?;
        Ok(Self {
            http,
            api_base: config.api_base.trim_end_matches('/').to_owned(),
            api_key,
            from: config.from.clone(),
            reply_to: config.reply_to.clone(),
        })
    }

    /// Sends one email; returns Resend's message id. One retry on HTTP 429.
    pub async fn send(&self, to: &str, key: &str, email: &Email) -> Result<String, SendError> {
        let mut body = serde_json::json!({
            "from": self.from,
            "to": [to],
            "subject": email.subject,
            "html": email.html,
            "text": email.text,
        });
        if let Some(reply_to) = &self.reply_to {
            body["reply_to"] = serde_json::json!(reply_to);
        }
        for attempt in 0..2 {
            let response = self
                .http
                .post(format!("{}/emails", self.api_base))
                .bearer_auth(&self.api_key)
                .header("Idempotency-Key", key)
                .json(&body)
                .send()
                .await
                .map_err(|_| SendError::Transport)?;
            let status = response.status();
            if status.is_success() {
                return response
                    .json::<SendResponse>()
                    .await
                    .map(|r| r.id)
                    .map_err(|_| SendError::Transport);
            }
            if status.as_u16() == 429 && attempt == 0 {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            let name = response
                .json::<ErrorResponse>()
                .await
                .unwrap_or_default()
                .name;
            return Err(SendError::Rejected {
                status: status.as_u16(),
                name,
            });
        }
        unreachable!("loop returns on its second attempt")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipient {
    pub id: i64,
    pub email: String,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    pub sent: usize,
    pub failed: usize,
}

/// Sends to each recipient in order, spacing requests, and calls `mark` after each
/// accepted send. A failed send or mark is logged and counted; the loop continues.
pub async fn deliver<F, Fut>(
    client: &ResendClient,
    links: &Links,
    recipients: &[Recipient],
    spacing: Duration,
    mut mark: F,
) -> Report
where
    F: FnMut(i64, String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let mut report = Report::default();
    let email = render(links);
    for (index, recipient) in recipients.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(spacing).await;
        }
        let to = redact(&recipient.email);
        match client
            .send(&recipient.email, &idempotency_key(recipient.id), &email)
            .await
        {
            Ok(message_id) => match mark(recipient.id, message_id).await {
                Ok(()) => {
                    report.sent += 1;
                    tracing::info!(id = recipient.id, to, "waitlist invite sent");
                }
                Err(error) => {
                    report.failed += 1;
                    tracing::error!(id = recipient.id, to, %error, "invite sent but not recorded; rerun within 24h is deduplicated by its idempotency key");
                }
            },
            Err(error) => {
                report.failed += 1;
                tracing::warn!(id = recipient.id, to, %error, "waitlist invite failed");
            }
        }
    }
    report
}

pub async fn pending(pool: &PgPool, options: &Options) -> sqlx::Result<Vec<Recipient>> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id, email FROM waitlist
         WHERE invited_at IS NULL AND ($2::text IS NULL OR email = $2)
         ORDER BY created_at, id
         LIMIT $1",
    )
    .bind(options.limit)
    .bind(options.email.as_deref())
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, email)| Recipient { id, email })
        .collect())
}

pub async fn mark_invited(pool: &PgPool, id: i64, message_id: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE waitlist SET invited_at = clock_timestamp(), invite_message_id = $2
         WHERE id = $1 AND invited_at IS NULL",
    )
    .bind(id)
    .bind(message_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// The whole subcommand. Errors if any send failed, so the job exits nonzero.
pub async fn run(
    pool: &PgPool,
    options: &Options,
    config: &InviteConfig,
) -> anyhow::Result<Report> {
    let recipients = pending(pool, options)
        .await
        .map_err(|_| anyhow::anyhow!("could not read the waitlist"))?;
    if options.dry_run {
        println!(
            "dry run: {} uninvited address(es) would be emailed",
            recipients.len()
        );
        for recipient in &recipients {
            println!("  {} {}", recipient.id, redact(&recipient.email));
        }
        return Ok(Report::default());
    }
    let client = ResendClient::new(config)?;
    let report = deliver(
        &client,
        &config.links,
        &recipients,
        SEND_SPACING,
        |id, message_id| async move {
            mark_invited(pool, id, &message_id)
                .await
                .map_err(|_| anyhow::anyhow!("database update failed"))
        },
    )
    .await;
    println!("invites: {} sent, {} failed", report.sent, report.failed);
    anyhow::ensure!(report.failed == 0, "{} invite(s) failed", report.failed);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(ios: bool, android: bool, extension: bool) -> Links {
        Links {
            get: None,
            ios: ios.then(|| "https://apps.apple.com/app/honey".to_owned()),
            android: android.then(|| "https://play.google.com/store/apps/honey".to_owned()),
            extension: extension
                .then(|| "https://chromewebstore.google.com/detail/honey".to_owned()),
        }
    }

    #[test]
    fn one_get_honey_cta_and_subtle_store_links() {
        let email = render(&links(false, true, true));
        assert_eq!(email.subject, "You're in: Honey is ready");
        // The button and the hero both go to the device-aware /get link.
        assert!(email.html.contains(&format!(
            "<a href=\"{DEFAULT_GET_URL}\" target=\"_blank\" style=\"text-decoration:none;\"><img src=\"{ASSET_BASE}/btn-get-honey.png\" width=\"560\" height=\"52\" alt=\"Get Honey\" style=\"display:block;width:100%;height:auto;"
        )));
        assert!(email.html.contains(&format!(
            "<a href=\"{DEFAULT_GET_URL}\" target=\"_blank\" style=\"text-decoration:none;\"><img src=\"{ASSET_BASE}/invite-hero.png\""
        )));
        // Configured stores only, as small grey links after the CTA.
        let play = "https://play.google.com/store/apps/honey";
        assert!(email.html.contains(&format!(
            "<div class=\"gmail-blend-difference\">Or open <a href=\"{play}\" target=\"_blank\" style=\"color:#a8a197;text-decoration:underline;\">Google Play</a> &middot; <a href=\"https://chromewebstore.google.com/detail/honey\""
        )));
        assert!(!email.html.contains("App Store"));
        assert!(
            email.html.find("btn-get-honey.png").unwrap() < email.html.find("Or open").unwrap()
        );
        assert!(email.text.contains(&format!(
            "Get Honey: {DEFAULT_GET_URL}\nGoogle Play: {play}\n"
        )));
        assert!(!email.text.contains("App Store"));
        // Logo, button and hero; no per-store button images.
        assert_eq!(email.html.matches("<img").count(), 3);
        assert!(!email.html.contains("btn-google-play"));
        assert!(email.html.contains(&format!(
            "<img src=\"{ASSET_BASE}/icon-honey.png\" width=\"32\" height=\"28\""
        )));
        assert!(
            email
                .html
                .contains("width=\"560\" height=\"340\" alt=\"The Honey app")
        );
        // Charcoal, not pure black.
        assert!(email.html.contains("bgcolor=\"#1c1b1a\""));
        assert!(email.html.contains("bgcolor=\"#242220\""));
        assert!(!email.html.contains("#0b0b0a"));
        // Dark-mode locks: gradient backgrounds Gmail won't invert, blend-wrapped text.
        for color in ["#1c1b1a", "#242220"] {
            assert!(email.html.contains(&format!(
                "background-color:{color};background-image:linear-gradient({color},{color});"
            )));
        }
        assert!(email.html.contains("<body class=\"body\""));
        assert!(
            email
                .html
                .contains("u + .body .gmail-blend-screen{background:#000;mix-blend-mode:screen;}")
        );
        assert!(email.html.contains(
            "u + .body .gmail-blend-difference{background:#000;mix-blend-mode:difference;}"
        ));
        for text in [
            "Honey",
            "You're in.",
            "You're off the waitlist.",
            "Or open ",
            "Hit reply",
            "You joined the waitlist",
        ] {
            assert!(
                email.html.contains(&format!(
                    "<div class=\"gmail-blend-screen\"><div class=\"gmail-blend-difference\">{text}"
                )),
                "{text}"
            );
        }
        // No colored text (it turns blue under the blend) and no inline blend spans.
        assert!(!email.html.contains("color:#f3c969"));
        assert!(!email.html.contains("<span class=\"gmail-blend"));
        assert!(!email.html.contains("border:1px solid"));
        assert!(email.html.contains("max-width:560px"));
        // Footer link is plain grey, not a blue auto-link.
        assert!(email.html.contains("<a href=\"https://www.honeywallet.org\" target=\"_blank\" style=\"color:#a8a197;text-decoration:none;\">honeywallet.org</a>"));
    }

    #[test]
    fn get_url_is_configurable_and_store_links_optional() {
        let mut custom = links(false, false, false);
        custom.get = Some("https://example.com/download".into());
        let email = render(&custom);
        assert_eq!(
            email
                .html
                .matches("href=\"https://example.com/download\"")
                .count(),
            2
        );
        assert!(!email.html.contains("Or open"));
        assert!(
            email
                .text
                .contains("Get Honey: https://example.com/download\n\nHit reply")
        );
        let config = InviteConfig::from_lookup(
            lookup(&[("INVITE_GET_URL", "https://example.com/download")]),
            true,
        )
        .unwrap();
        assert_eq!(config.links.get_url(), "https://example.com/download");
        assert_eq!(
            InviteConfig::from_lookup(lookup(&[]), true)
                .unwrap()
                .links
                .get_url(),
            DEFAULT_GET_URL
        );
        assert!(
            InviteConfig::from_lookup(lookup(&[("INVITE_GET_URL", "http://x.y")]), true).is_err()
        );
    }

    #[test]
    fn all_three_store_links_in_order() {
        let email = render(&links(true, true, true));
        let a = email.html.find(">App Store</a>").unwrap();
        let b = email.html.find(">Google Play</a>").unwrap();
        let c = email.html.find(">Chrome</a>").unwrap();
        assert!(a < b && b < c);
        assert!(c < email.html.find("invite-hero.png").unwrap());
    }

    #[test]
    fn copy_has_no_place_in_line_and_is_signed() {
        let email = render(&links(true, false, false));
        assert!(!email.html.contains("You were"));
        assert!(!email.text.contains('#'));
        assert!(
            email
                .html
                .contains("You're off the waitlist. Get Honey on your phone or in Chrome.</div>")
        );
        assert!(email.html.contains("color:#ffffff;\"><div class=\"gmail-blend-screen\"><div class=\"gmail-blend-difference\">You're in."));
        assert!(
            email
                .text
                .starts_with("You're in.\nYou're off the waitlist.\n\nGet Honey: ")
        );
        assert!(
            email
                .html
                .contains("Hit reply, it comes to me. &mdash; Abhishek<")
        );
        assert!(
            email
                .text
                .contains("Hit reply, it comes to me. -- Abhishek\n")
        );
    }

    #[test]
    fn spacing_is_optically_even() {
        // Visible gaps are 40 (section) and 16 (related); each padding is that gap minus
        // the measured line-height leading of the text rows around it.
        let email = render(&links(true, true, true));
        assert!(email.html.contains("padding:40px 24px 40px 24px;"));
        for (padding, gap) in [
            ("padding:0 0 33px 0;", "logo to headline 40"),
            ("padding:0 0 5px 0;font-family", "headline to subline 16"),
            ("padding:0 0 35px 0;font-family", "subline to button 40"),
            (
                "padding:11px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px",
                "button to store links 16",
            ),
            ("padding:0 0 38px 0;", "store links to hero 40"),
            ("padding:35px 0 0 0;font-family", "hero to sign-off 40"),
            (
                "padding:11px 0 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px",
                "sign-off to footer 16",
            ),
            (
                "padding:0 8px 0 0;vertical-align:middle;",
                "logo mark to wordmark 8",
            ),
        ] {
            assert!(email.html.contains(padding), "{gap}");
        }
        // Without store links the button sits a full 40 above the hero.
        let bare = render(&Links::default());
        assert!(bare.html.contains("padding:0 0 40px 0;"));
        assert!(!bare.html.contains("Or open"));
    }

    /// Run with INVITE_PREVIEW_PATH=<file> (and optionally INVITE_PREVIEW_ASSETS=<base url>)
    /// cargo test -p honey-server write_preview
    #[test]
    fn write_preview() {
        if let Ok(path) = std::env::var("INVITE_PREVIEW_PATH") {
            let base = std::env::var("INVITE_PREVIEW_ASSETS").unwrap_or_else(|_| ASSET_BASE.into());
            let email = render_with_assets(&links(true, true, true), &base);
            std::fs::write(path, email.html).unwrap();
        }
    }

    #[test]
    fn options_parse_and_bound() {
        assert_eq!(
            Options::parse(Vec::<String>::new()).unwrap(),
            Options {
                limit: 50,
                dry_run: false,
                email: None
            }
        );
        let parsed = Options::parse(
            ["--dry-run", "--limit", "500", "--email", " A@B.co "].map(String::from),
        )
        .unwrap();
        assert_eq!(
            parsed,
            Options {
                limit: 500,
                dry_run: true,
                email: Some("a@b.co".into())
            }
        );
        assert!(Options::parse(["--limit", "501"].map(String::from)).is_err());
        assert!(Options::parse(["--limit", "0"].map(String::from)).is_err());
        assert!(Options::parse(["--bogus"].map(String::from)).is_err());
    }

    fn lookup(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn config_requires_key_and_a_link_unless_dry_run() {
        assert!(InviteConfig::from_lookup(lookup(&[]), true).is_ok());
        let no_links = InviteConfig::from_lookup(lookup(&[("RESEND_API_KEY", "re_x")]), false);
        assert!(no_links.unwrap_err().to_string().contains("INVITE_IOS_URL"));
        let no_key = InviteConfig::from_lookup(lookup(&[("INVITE_IOS_URL", "https://a.b")]), false);
        assert!(no_key.unwrap_err().to_string().contains("RESEND_API_KEY"));
        let ok = InviteConfig::from_lookup(
            lookup(&[
                ("RESEND_API_KEY", "re_secret"),
                ("INVITE_ANDROID_URL", "https://a.b"),
                ("INVITE_IOS_URL", " "),
            ]),
            false,
        )
        .unwrap();
        assert_eq!(ok.from, DEFAULT_FROM);
        assert_eq!(ok.links.ios, None);
        assert!(!format!("{ok:?}").contains("re_secret"));
        assert!(
            InviteConfig::from_lookup(lookup(&[("INVITE_IOS_URL", "http://a.b")]), true).is_err()
        );
    }

    #[test]
    fn redacts_addresses() {
        assert_eq!(redact("jane@example.com"), "j***@example.com");
        assert_eq!(idempotency_key(7), "waitlist-invite-7");
    }
}
