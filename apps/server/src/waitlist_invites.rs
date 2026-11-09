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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Links {
    pub ios: Option<String>,
    pub android: Option<String>,
    pub extension: Option<String>,
}

impl Links {
    fn buttons(&self) -> Vec<(&'static str, &str)> {
        [
            ("iOS", &self.ios),
            ("Android", &self.android),
            ("Chrome", &self.extension),
        ]
        .into_iter()
        .filter_map(|(label, url)| url.as_deref().map(|url| (label, url)))
        .collect()
    }
}

#[derive(Clone)]
pub struct InviteConfig {
    pub api_key: Option<String>,
    pub api_base: String,
    pub from: String,
    pub reply_to: Option<String>,
    pub links: Links,
    /// Optional early-member perks (`INVITE_PERKS`, pipe-separated). Empty omits the section.
    pub perks: Vec<String>,
}

impl std::fmt::Debug for InviteConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InviteConfig")
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("api_base", &self.api_base)
            .field("from", &self.from)
            .field("reply_to", &self.reply_to)
            .field("links", &self.links)
            .field("perks", &self.perks)
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
            ios: url("INVITE_IOS_URL")?,
            android: url("INVITE_ANDROID_URL")?,
            extension: url("INVITE_EXTENSION_URL")?,
        };
        let perks: Vec<String> = get("INVITE_PERKS")
            .map(|value| {
                value
                    .split('|')
                    .map(str::trim)
                    .filter(|perk| !perk.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        anyhow::ensure!(
            perks.len() <= 5 && perks.iter().all(|perk| perk.chars().count() <= 120),
            "INVITE_PERKS takes at most 5 perks of up to 120 characters"
        );
        let api_key = get("RESEND_API_KEY");
        if !dry_run {
            anyhow::ensure!(api_key.is_some(), "RESEND_API_KEY is required");
            anyhow::ensure!(
                !links.buttons().is_empty(),
                "set at least one of INVITE_IOS_URL, INVITE_ANDROID_URL, INVITE_EXTENSION_URL"
            );
        }
        Ok(Self {
            api_key,
            api_base: get("RESEND_API_BASE").unwrap_or_else(|| RESEND_API_BASE.to_owned()),
            from: get("INVITE_FROM").unwrap_or_else(|| DEFAULT_FROM.to_owned()),
            reply_to: get("INVITE_REPLY_TO"),
            links,
            perks,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Email {
    pub subject: &'static str,
    pub html: String,
    pub text: String,
}

/// What is personal about one invite. Never includes the address itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Personal {
    /// 1-based place in line by `created_at, id`.
    pub position: i64,
    /// Join date as shown, e.g. `21 Oct` (UTC).
    pub joined: String,
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Hosted hero (apps/web/public/email/invite-hero.png, built by apps/web/scripts/invite-hero.sh).
pub const HERO_URL: &str = "https://www.honeywallet.org/email/invite-hero.png";

/// Renders one invite: minimal copy, a hero of the real app, one "Get Honey" button.
pub fn render(links: &Links, perks: &[String], personal: &Personal) -> Email {
    render_with_hero(links, perks, personal, HERO_URL)
}

/// [`render`] with a different hero URL (local previews before the web deploy).
///
/// Matches the landing page (apps/web/src/home.css): matte ink, cream text, honey accent,
/// no glow. Email-safe: nested tables, inline CSS, `bgcolor` fallbacks and explicit
/// backgrounds so light-mode clients still show it dark and readable. Perks and URLs are
/// operator config; perks are escaped anyway. Never contains the recipient's address.
pub fn render_with_hero(links: &Links, perks: &[String], personal: &Personal, hero: &str) -> Email {
    const INK: &str = "#0b0b0a";
    const TEXT: &str = "#f6f3eb";
    const TEXT_2: &str = "#a8a197";
    const HONEY: &str = "#f3c969";
    const ON_HONEY: &str = "#1a1408";
    const RULE: &str = "#1d1b18";
    const SANS: &str =
        "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const MONO: &str = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
    const SIGN_OFF: &str = "Hit reply, it comes to me. &mdash; Abhishek, Honey";
    let n = personal.position;
    let stores = links.buttons();
    let primary = stores
        .first()
        .map(|(_, url)| *url)
        .unwrap_or("https://www.honeywallet.org");
    let hero = escape(hero);

    let others = if stores.len() > 1 {
        let items: Vec<String> = stores
            .iter()
            .map(|(label, url)| {
                format!(r#"<a href="{url}" target="_blank" style="color:{TEXT_2};text-decoration:underline;">{label}</a>"#)
            })
            .collect();
        format!(
            r#"<tr><td align="center" style="padding:14px 0 0 0;font-family:{SANS};font-size:13px;line-height:20px;color:{TEXT_2};">{}</td></tr>"#,
            items.join(" &middot; ")
        )
    } else {
        String::new()
    };

    let perks_html = if perks.is_empty() {
        String::new()
    } else {
        let items: String = perks
            .iter()
            .map(|perk| {
                format!(
                    r#"<tr><td style="padding:0 0 8px 0;font-family:{SANS};font-size:15px;line-height:22px;color:{TEXT};"><span style="font-family:{MONO};color:{HONEY};">+</span>&nbsp;&nbsp;{}</td></tr>"#,
                    escape(perk)
                )
            })
            .collect();
        format!(
            r#"<tr><td style="padding:40px 0 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 0 12px 0;font-family:{MONO};font-size:11px;line-height:16px;letter-spacing:1.5px;color:{TEXT_2};">FOR EARLY MEMBERS</td></tr>{items}</table></td></tr>"#
        )
    };

    let html = format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>{SUBJECT}</title></head>
<body bgcolor="{INK}" style="margin:0;padding:0;background-color:{INK};color:{TEXT};font-family:{SANS};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">You were #{n} on the waitlist.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{INK}" style="background-color:{INK};"><tr><td align="center" bgcolor="{INK}" style="background-color:{INK};padding:48px 20px 40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 0 20px 0;font-family:{MONO};font-size:11px;line-height:16px;letter-spacing:1.5px;color:{HONEY};">INVITE &middot; #{n}</td></tr>
<tr><td style="padding:0 0 10px 0;font-family:{SANS};font-size:40px;line-height:44px;font-weight:700;letter-spacing:-1px;color:{TEXT};">You're in.</td></tr>
<tr><td style="padding:0 0 32px 0;font-family:{SANS};font-size:17px;line-height:26px;color:{TEXT_2};">You were #{n} on the waitlist.</td></tr>
<tr><td style="padding:0 0 32px 0;"><a href="{primary}" target="_blank" style="text-decoration:none;"><img src="{hero}" width="560" height="350" alt="The Honey app: your wallet and the thesis agent" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:16px;background-color:{INK};color:{TEXT_2};font-family:{SANS};font-size:13px;"></a></td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="{HONEY}" style="background-color:{HONEY};border-radius:999px;"><a href="{primary}" target="_blank" style="display:block;padding:18px 24px;font-family:{SANS};font-size:17px;line-height:22px;font-weight:700;color:{ON_HONEY};text-decoration:none;border-radius:999px;">Get Honey</a></td></tr></table></td></tr>
{others}
{perks_html}
<tr><td style="padding:40px 0 0 0;font-family:{SANS};font-size:15px;line-height:22px;color:{TEXT};">{SIGN_OFF}</td></tr>
<tr><td style="padding:32px 0 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="1" bgcolor="{RULE}" style="height:1px;line-height:1px;font-size:1px;background-color:{RULE};">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:16px 0 0 0;font-family:{SANS};font-size:11px;line-height:16px;color:{TEXT_2};">You joined the waitlist at honeywallet.org.</td></tr>
</table></td></tr></table>
</body></html>"#
    );

    let mut text = format!(
        "INVITE #{n}\n\nYou're in.\nYou were #{n} on the waitlist.\n\nGet Honey: {primary}\n"
    );
    for (label, url) in stores.iter().skip(1) {
        text.push_str(&format!("{label}: {url}\n"));
    }
    if !perks.is_empty() {
        text.push_str("\nFOR EARLY MEMBERS\n");
        for perk in perks {
            text.push_str(&format!("+ {perk}\n"));
        }
    }
    text.push_str(
        "\nHit reply, it comes to me. -- Abhishek, Honey\n\n--\nYou joined the waitlist at honeywallet.org.\n",
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
    pub personal: Personal,
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
    perks: &[String],
    recipients: &[Recipient],
    spacing: Duration,
    mut mark: F,
) -> Report
where
    F: FnMut(i64, String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let mut report = Report::default();
    for (index, recipient) in recipients.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(spacing).await;
        }
        let to = redact(&recipient.email);
        let email = render(links, perks, &recipient.personal);
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
    // Place in line counts every current row, invited or not.
    let rows: Vec<(i64, String, i64, String)> = sqlx::query_as(
        "SELECT id, email, position, to_char(created_at AT TIME ZONE 'UTC', 'FMDD Mon')
         FROM (
             SELECT id, email, created_at, invited_at,
                    row_number() OVER (ORDER BY created_at, id) AS position
             FROM waitlist
         ) ranked
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
        .map(|(id, email, position, joined)| Recipient {
            id,
            email,
            personal: Personal { position, joined },
        })
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
            println!(
                "  {} #{} {}",
                recipient.id,
                recipient.personal.position,
                redact(&recipient.email)
            );
        }
        return Ok(Report::default());
    }
    let client = ResendClient::new(config)?;
    let report = deliver(
        &client,
        &config.links,
        &config.perks,
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
            ios: ios.then(|| "https://apps.apple.com/app/honey".to_owned()),
            android: android.then(|| "https://play.google.com/store/apps/honey".to_owned()),
            extension: extension
                .then(|| "https://chromewebstore.google.com/detail/honey".to_owned()),
        }
    }

    fn personal() -> Personal {
        Personal {
            position: 128,
            joined: "21 Oct".into(),
        }
    }

    #[test]
    fn render_is_minimal_with_one_primary_cta() {
        let email = render(&links(false, true, true), &[], &personal());
        assert_eq!(email.subject, "You're in: Honey is ready");
        // Primary is the first available store: Android here, iOS missing.
        let primary = "https://play.google.com/store/apps/honey";
        assert!(email.html.contains(&format!(
            "<a href=\"{primary}\" target=\"_blank\" style=\"text-decoration:none;\"><img src=\"{HERO_URL}\""
        )));
        assert_eq!(email.html.matches(">Get Honey</a>").count(), 1);
        assert!(email.html.contains(">Android</a> &middot; <a"));
        assert!(email.html.contains(">Chrome</a>"));
        assert!(!email.html.contains(">iOS</a>"));
        assert!(email.text.contains(&format!("Get Honey: {primary}\n")));
        assert!(email.text.contains("Chrome: https://chromewebstore"));
        assert!(!email.text.contains("iOS"));
        // Hero: alt, dimensions, the only image.
        assert_eq!(email.html.matches("<img").count(), 1);
        assert!(
            email
                .html
                .contains("width=\"560\" height=\"350\" alt=\"The Honey app")
        );
        // Copy that was cut stays cut.
        for gone in ["joined on", "Download Honey", "invest in what you believe"] {
            assert!(
                !email.html.contains(gone) && !email.text.contains(gone),
                "{gone}"
            );
        }
        assert!(email.html.contains("bgcolor=\"#0b0b0a\""));
        assert!(
            email
                .html
                .contains("name=\"color-scheme\" content=\"dark\"")
        );
        assert!(email.html.contains("max-width:560px"));
        assert!(!email.html.contains("<style"));
    }

    #[test]
    fn single_store_has_no_secondary_links() {
        let email = render(&links(true, false, false), &[], &personal());
        assert!(!email.html.contains(">iOS</a>"));
        assert_eq!(
            email
                .html
                .matches("https://apps.apple.com/app/honey")
                .count(),
            2
        );
    }

    #[test]
    fn render_is_personal_and_signed() {
        let email = render(&links(true, false, false), &[], &personal());
        assert!(email.html.contains("INVITE &middot; #128"));
        assert!(email.html.contains("You were #128 on the waitlist."));
        assert!(
            email
                .text
                .starts_with("INVITE #128\n\nYou're in.\nYou were #128 on the waitlist.")
        );
        assert!(
            email
                .html
                .contains("Hit reply, it comes to me. &mdash; Abhishek, Honey")
        );
        assert!(
            email
                .text
                .contains("Hit reply, it comes to me. -- Abhishek, Honey")
        );
    }

    #[test]
    fn perks_are_optional_and_escaped() {
        let none = render(&links(true, false, false), &[], &personal());
        assert!(!none.html.contains("FOR EARLY MEMBERS"));
        assert!(!none.text.contains("FOR EARLY MEMBERS"));
        let perks = vec![
            "Founding member badge".to_owned(),
            "<b>x</b> & y".to_owned(),
        ];
        let some = render(&links(true, false, false), &perks, &personal());
        assert!(some.html.contains("FOR EARLY MEMBERS"));
        assert!(some.html.contains("Founding member badge"));
        assert!(some.html.contains("&lt;b&gt;x&lt;/b&gt; &amp; y"));
        assert!(
            some.text
                .contains("FOR EARLY MEMBERS\n+ Founding member badge\n")
        );
    }

    #[test]
    fn perks_config_parses_pipes() {
        let config =
            InviteConfig::from_lookup(lookup(&[("INVITE_PERKS", " A | |B ")]), true).unwrap();
        assert_eq!(config.perks, ["A", "B"]);
        let unset = InviteConfig::from_lookup(lookup(&[]), true).unwrap();
        assert!(unset.perks.is_empty());
        assert!(
            InviteConfig::from_lookup(lookup(&[("INVITE_PERKS", "a|b|c|d|e|f")]), true).is_err()
        );
    }

    /// Sample perks for the preview only; production default is none.
    /// Run with INVITE_PREVIEW_PATH=<file> (and optionally INVITE_PREVIEW_HERO=<url>)
    /// cargo test -p honey-server write_preview
    #[test]
    fn write_preview() {
        if let Ok(path) = std::env::var("INVITE_PREVIEW_PATH") {
            let hero = std::env::var("INVITE_PREVIEW_HERO").unwrap_or_else(|_| HERO_URL.into());
            let perks = [
                "Founding member badge",
                "First jars free of Honey fees for 30 days",
                "Direct line to the founders: reply to this email",
            ]
            .map(String::from);
            let email = render_with_hero(&links(true, true, true), &perks, &personal(), &hero);
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
