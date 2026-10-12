//! Link previews. After a message with links is sent, the server fetches each page (up to
//! three), reads its OpenGraph / Twitter card tags, copies its picture into storage, and sends
//! the message again with `embeds`. Viewers only ever load the copy, so linked sites never see
//! who's reading. Fetches identify as branchr, only reach public addresses, and are capped in
//! size and time. `LINK_PREVIEWS=0` turns it off.

use std::collections::HashMap;
use std::io::Cursor;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use dashmap::DashMap;
use proto::Id;
use proto::gateway::ServerEvent;
use proto::models::{Embed, EmbedImage};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use url::{Host, Url};

use crate::db;
use crate::error::AppError;
use crate::routes::pictures::PREFIX;
use crate::state::AppState;
use crate::thumbs::{self, Fit};

const MAX_LINKS: usize = 3;
const HTML_BYTES: usize = 1024 * 1024;
const IMAGE_BYTES: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
const CACHE_FOR: Duration = Duration::from_secs(3600);
const CACHE_MAX: usize = 5000;

pub struct Unfurler {
    http: reqwest::Client,
    /// Recent results by URL (including "no preview"), so a link posted again isn't refetched.
    cache: DashMap<String, (Option<Embed>, Instant)>,
    /// Fetches at once, server-wide.
    slots: Semaphore,
    allow_private: bool,
}

impl Unfurler {
    /// `allow_private` is for tests, whose pages live on localhost.
    pub fn new(allow_private: bool) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("branchr/", env!("CARGO_PKG_VERSION"), " (link previews; +https://branchr.us)"))
            .dns_resolver(PublicOnly { allow_private })
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= 5 {
                    attempt.error("too many redirects")
                } else if !allowed_url(attempt.url(), allow_private) {
                    attempt.error("redirect to a private address")
                } else {
                    attempt.follow()
                }
            }))
            // Through a proxy, the address checks above would check the proxy instead.
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(TIMEOUT)
            .build()
            .expect("http client");
        Self { http, cache: DashMap::new(), slots: Semaphore::new(8), allow_private }
    }

    async fn embed(&self, state: &AppState, url: &str) -> Option<Embed> {
        if let Some(hit) = self.cache.get(url)
            && hit.1.elapsed() < CACHE_FOR
        {
            return hit.0.clone();
        }
        let _slot = self.slots.acquire().await.ok()?;
        let embed = tokio::time::timeout(TIMEOUT * 2, self.fetch(state, url)).await.ok().flatten();
        if self.cache.len() >= CACHE_MAX {
            self.cache.retain(|_, (_, at)| at.elapsed() < CACHE_FOR);
            if self.cache.len() >= CACHE_MAX {
                self.cache.clear();
            }
        }
        self.cache.insert(url.to_string(), (embed.clone(), Instant::now()));
        embed
    }

    async fn fetch(&self, state: &AppState, link: &str) -> Option<Embed> {
        let url = Url::parse(link).ok()?;
        if !allowed_url(&url, self.allow_private) {
            return None;
        }
        let resp = self.http.get(url).header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,image/*;q=0.8").send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let page = resp.url().clone();
        let ct = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        if ct.starts_with("image/") {
            let bytes = read(resp, IMAGE_BYTES, false).await?;
            let image = self.store_image(state, link, bytes, true).await?;
            return Some(Embed { url: link.to_string(), site_name: None, title: None, description: None, image: Some(image), large: true, color: None });
        }
        if !ct.contains("html") {
            return None;
        }
        let body = read(resp, HTML_BYTES, true).await?;
        let html = String::from_utf8_lossy(&body);
        let meta = Meta::parse(&html);
        let title = meta.get(&["og:title", "twitter:title"]).or(meta.title.clone()).map(|t| clip(&t, 256));
        let description = meta.get(&["og:description", "twitter:description", "description"]).map(|d| clip(&d, 350));
        let site_name = meta.get(&["og:site_name"]).map(|s| clip(&s, 100));
        let large = meta.get(&["twitter:card"]).is_some_and(|c| c == "summary_large_image") || meta.get(&["og:type"]).is_some_and(|t| t.starts_with("video"));
        let color = meta.get(&["theme-color"]).and_then(|c| hex_color(&c));
        let image_url = meta.get(&["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]).and_then(|i| page.join(&i).ok());
        if title.is_none() && description.is_none() && image_url.is_none() {
            return None;
        }
        let image = match image_url {
            Some(u) if allowed_url(&u, self.allow_private) => self.download_image(state, &u, large).await,
            _ => None,
        };
        Some(Embed { url: link.to_string(), site_name, title, description, large: large && image.is_some(), image, color })
    }

    async fn download_image(&self, state: &AppState, url: &Url, large: bool) -> Option<EmbedImage> {
        let resp = self.http.get(url.clone()).header(reqwest::header::ACCEPT, "image/*").send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let bytes = read(resp, IMAGE_BYTES, false).await?;
        self.store_image(state, url.as_str(), bytes, large).await
    }

    /// Shrinks a picture and keeps it, named after where it came from (so repeats share one copy).
    async fn store_image(&self, state: &AppState, source: &str, bytes: Vec<u8>, large: bool) -> Option<EmbedImage> {
        let fit = if large { Fit::Within(800, 600) } else { Fit::Within(320, 320) };
        let (out, ct, width, height) = tokio::task::spawn_blocking(move || {
            let (out, ct) = thumbs::picture(&bytes, fit)?;
            let (w, h) = image::ImageReader::new(Cursor::new(&out)).with_guessed_format().ok()?.into_dimensions().ok()?;
            Some((out, ct, w, h))
        })
        .await
        .ok()??;
        let hash: String = Sha256::digest(format!("{source}#{large}").as_bytes())[..12].iter().map(|b| format!("{b:02x}")).collect();
        let key = format!("embed/{hash}.{}", if ct == "image/webp" { "webp" } else { "jpg" });
        state.storage.put(&key, ct, futures::stream::iter([Ok::<_, AppError>(Bytes::from(out))])).await.ok()?;
        Some(EmbedImage { url: format!("{PREFIX}{key}"), width, height })
    }
}

/// Fills in `mid`'s previews (in the background, after it's sent or edited). `had` says whether
/// it had previews before, which then need clearing if its links went away.
pub fn spawn(state: AppState, guild: Id, cid: Id, mid: Id, author: Id, content: String, had: bool) {
    if state.unfurl.is_none() || (links(&content).is_empty() && !had) {
        return;
    }
    tokio::spawn(async move {
        let Some(unfurl) = state.unfurl.as_ref() else { return };
        let mut embeds = Vec::new();
        for link in links(&content) {
            if let Some(e) = unfurl.embed(&state, &link).await {
                embeds.push(e);
            }
        }
        if embeds.is_empty() && !had {
            return;
        }
        let json = (!embeds.is_empty()).then(|| serde_json::to_string(&embeds).unwrap_or_default());
        // Unless it was edited (or deleted) meanwhile; that edit brings its own previews.
        let r = sqlx::query("UPDATE messages SET embeds = $1 WHERE id = $2 AND content = $3").bind(json).bind(mid.0).bind(&content).execute(&state.db).await;
        if !matches!(r, Ok(ref r) if r.rows_affected() == 1) {
            return;
        }
        if let Ok(msg) = db::message(&state.db, mid, author).await {
            state.to_channel(guild, cid, &ServerEvent::MessageUpdate(msg)).await;
        }
    });
}

/// The http(s) links in a message worth previewing: not in code, not wrapped in `<…>`.
pub fn links(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_code = false;
    let mut rest = content;
    while !rest.is_empty() && out.len() < MAX_LINKS {
        // Code spans toggle on backticks; skip whatever's inside.
        let next_tick = rest.find('`');
        let next_link = ["https://", "http://"].iter().filter_map(|p| rest.find(p)).min();
        match (next_tick, next_link) {
            (Some(t), l) if in_code || l.is_none_or(|l| t < l) => {
                in_code = !in_code;
                rest = &rest[t + 1..];
            }
            (_, Some(l)) => {
                let suppressed = rest[..l].ends_with('<');
                let end = rest[l..].find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '`').map_or(rest.len(), |e| l + e);
                let raw = rest[l..end].trim_end_matches(['.', ',', '!', '?', ';', ':', '\'', '"', ')', ']']);
                if !suppressed && Url::parse(raw).is_ok() && !out.iter().any(|o| o == raw) {
                    out.push(raw.to_string());
                }
                rest = &rest[end..];
            }
            _ => break,
        }
    }
    out
}

async fn read(mut resp: reqwest::Response, max: usize, truncate: bool) -> Option<Vec<u8>> {
    if resp.content_length().is_some_and(|l| l as usize > max) && !truncate {
        return None;
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.ok()? {
        buf.extend_from_slice(&chunk);
        if buf.len() > max {
            if !truncate {
                return None;
            }
            buf.truncate(max);
            break;
        }
    }
    Some(buf)
}

fn clip(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= max { s } else { format!("{}…", s.chars().take(max - 1).collect::<String>().trim_end()) }
}

fn hex_color(c: &str) -> Option<String> {
    let h = c.trim().strip_prefix('#')?;
    let full = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 => h.to_string(),
        _ => return None,
    };
    full.chars().all(|c| c.is_ascii_hexdigit()).then(|| format!("#{}", full.to_ascii_lowercase()))
}

fn allowed_url(url: &Url, allow_private: bool) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    match url.host() {
        Some(Host::Ipv4(ip)) => allow_private || public(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => allow_private || public(IpAddr::V6(ip)),
        Some(Host::Domain(d)) => allow_private || !(d.eq_ignore_ascii_case("localhost") || d.ends_with(".localhost")),
        None => false,
    }
}

/// Whether an address is on the public internet (not this machine, a LAN, or anything special).
pub fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_unspecified()
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public(IpAddr::V4(v4));
            }
            let s = v6.segments();
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] == 0x2001 && s[1] == 0x0db8)
                || (s[0] == 0x0064 && s[1] == 0xff9b)
                || s[0] == 0x2002
                || s[..6].iter().all(|&x| x == 0))
        }
    }
}

/// Resolves names but only hands back public addresses (so a name can't point us inward).
struct PublicOnly {
    allow_private: bool,
}

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let allow_private = self.allow_private;
        Box::pin(async move {
            let found: Vec<SocketAddr> = tokio::net::lookup_host((name.as_str(), 0)).await?.filter(|a| allow_private || public(a.ip())).collect();
            if found.is_empty() {
                return Err("no public address".into());
            }
            Ok(Box::new(found.into_iter()) as Addrs)
        })
    }
}

/// `<meta>` tags and the `<title>` from a page's head.
struct Meta {
    tags: HashMap<String, String>,
    title: Option<String>,
}

impl Meta {
    fn parse(html: &str) -> Self {
        let head = match find_ci(html, "</head") {
            Some(end) => &html[..end],
            None => html,
        };
        let mut tags = HashMap::new();
        let mut at = 0;
        while let Some(i) = find_ci(&head[at..], "<meta") {
            let start = at + i + 5;
            let Some(len) = head[start..].find('>') else { break };
            let attrs = attributes(&head[start..start + len]);
            let key = attrs.get("property").or_else(|| attrs.get("name")).map(|k| k.to_ascii_lowercase());
            if let (Some(k), Some(v)) = (key, attrs.get("content")) {
                tags.entry(k).or_insert_with(|| v.clone());
            }
            at = start + len;
        }
        let title = find_ci(head, "<title").and_then(|i| {
            let open = i + head[i..].find('>')? + 1;
            let close = open + find_ci(&head[open..], "</title")?;
            Some(decode(head[open..close].trim())).filter(|t| !t.is_empty())
        });
        Meta { tags, title }
    }

    fn get(&self, keys: &[&str]) -> Option<String> {
        keys.iter().find_map(|k| self.tags.get(*k)).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    }
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let n = needle.len();
    hay.as_bytes().windows(n).position(|w| w.eq_ignore_ascii_case(needle.as_bytes()))
}

/// `name="value"` pairs (any quoting) in a tag, lowercased names, entities decoded.
fn attributes(tag: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let b = tag.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let ns = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        let name = tag[ns..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            let value = if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                let vs = i + 1;
                let ve = tag[vs..].bytes().position(|c| c == q).map_or(tag.len(), |p| vs + p);
                i = (ve + 1).min(tag.len());
                &tag[vs..ve]
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                &tag[vs..i]
            };
            if !name.is_empty() {
                out.insert(name, decode(value));
            }
        } else if name.is_empty() {
            i += 1;
        }
    }
    out
}

fn decode(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            e if e.starts_with("#x") || e.starts_with("#X") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            e if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_links_outside_code_and_brackets() {
        let l = links("see https://a.example/x, and <https://b.example> `https://c.example` (https://d.example/p?q=1) http://a.example/x https://a.example/x");
        assert_eq!(l, vec!["https://a.example/x", "https://d.example/p?q=1", "http://a.example/x"]);
        assert!(links("```\nhttps://e.example\n```").is_empty());
    }

    #[test]
    fn reads_open_graph() {
        let m = Meta::parse(
            r##"<html><HEAD><title> Fallback &amp; Title </title>
            <meta property="og:title" content="It&#39;s &quot;here&quot;">
            <meta name='description' content='Plain description'>
            <META content="https://img.example/a.png" property=og:image />
            <meta name="theme-color" content="#ABC"></head><body><meta property="og:title" content="body"></body>"##,
        );
        assert_eq!(m.get(&["og:title"]).as_deref(), Some("It's \"here\""));
        assert_eq!(m.title.as_deref(), Some("Fallback & Title"));
        assert_eq!(m.get(&["og:description", "description"]).as_deref(), Some("Plain description"));
        assert_eq!(m.get(&["og:image"]).as_deref(), Some("https://img.example/a.png"));
        assert_eq!(m.get(&["theme-color"]).and_then(|c| hex_color(&c)).as_deref(), Some("#aabbcc"));
    }

    #[test]
    fn only_public_addresses() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.16.5.4", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"] {
            assert!(!public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(public(ip.parse().unwrap()), "{ip}");
        }
        assert!(!allowed_url(&Url::parse("http://localhost:8080/").unwrap(), false));
        assert!(!allowed_url(&Url::parse("http://[::1]/").unwrap(), false));
        assert!(!allowed_url(&Url::parse("file:///etc/passwd").unwrap(), false));
        assert!(allowed_url(&Url::parse("https://example.com/").unwrap(), false));
    }
}
