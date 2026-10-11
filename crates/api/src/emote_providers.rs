//! Third-party emote providers (7TV, BetterTTV, FrankerFaceZ): search, lookup and set
//! imports, proxied and cached server-side so clients don't each hit the providers and
//! the instance works behind strict CSPs. Images themselves load straight from each CDN.
//!
//! Requests identify honestly as this app (no browser impersonation), so only each
//! provider's public endpoints are used. BetterTTV has no public search or single-emote
//! lookup: its emotes come from Twitch channel imports, or a CDN link plus a name.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use futures::{StreamExt, stream};
use proto::models::{EmoteProvider, ExternalEmote};
use reqwest::Url;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::json;

const SEVENTV_GQL: &str = "https://7tv.io/v3/gql";
const SEVENTV: &str = "https://7tv.io/v3";
const BTTV: &str = "https://api.betterttv.net/3";
const BTTV_CDN: &str = "https://cdn.betterttv.net/emote";
const FFZ: &str = "https://api.frankerfacez.com/v1";
const TTL: Duration = Duration::from_secs(600);
const MAX_CACHE: usize = 2048;
/// Largest image read when probing a BetterTTV emote's dimensions.
const MAX_PROBE_BYTES: usize = 2 << 20;

#[derive(Debug)]
pub enum ProviderError {
    NotFound,
    /// Something the provider doesn't offer publicly; the message is shown to the user.
    Unsupported(&'static str),
    Upstream(reqwest::Error),
    Other(String),
}

impl From<reqwest::Error> for ProviderError {
    fn from(e: reqwest::Error) -> Self {
        Self::Upstream(e)
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("not found"),
            Self::Unsupported(m) => f.write_str(m),
            Self::Upstream(e) => write!(f, "emote provider error: {e}"),
            Self::Other(m) => f.write_str(m),
        }
    }
}

type Result<T> = std::result::Result<T, ProviderError>;

/// What a pasted link or name points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Emote(EmoteProvider, String),
    SevenTvSet(String),
    SevenTvUser(String),
    /// A BetterTTV user page; only resolvable when the user has a linked Twitch account
    /// (BetterTTV's user lookup isn't public), so this is reported as unsupported.
    BttvUser(String),
    FfzChannel(String),
    Twitch(String),
}

fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

fn login_ok(login: &str) -> bool {
    (1..=25).contains(&login.len()) && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Parses an emote, emote-set, user or channel link from any supported site. A bare word
/// is a Twitch channel name, except 7TV-style ULIDs (26 chars) which are 7TV set ids.
pub fn parse_link(input: &str) -> Option<Link> {
    let input = input.trim();
    if !input.contains('/') && !input.contains('.') {
        let s = input.trim_start_matches('@');
        if s.len() == 26 && id_ok(s) {
            return Some(Link::SevenTvSet(s.to_string()));
        }
        return login_ok(s).then(|| Link::Twitch(s.to_lowercase()));
    }
    let url = if input.contains("://") { Url::parse(input) } else { Url::parse(&format!("https://{input}")) }.ok()?;
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("old.");
    let seg: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let id = |i: usize| seg.get(i).copied().filter(|s| id_ok(s)).map(str::to_string);
    let link = match (host, seg.first().copied()?) {
        ("7tv.app", "emotes") => Link::Emote(EmoteProvider::SevenTv, id(1)?),
        ("7tv.app", "emote-sets") => Link::SevenTvSet(id(1)?),
        ("7tv.app", "users") => Link::SevenTvUser(id(1)?),
        ("cdn.7tv.app", "emote") => Link::Emote(EmoteProvider::SevenTv, id(1)?),
        ("betterttv.com", "emotes") => Link::Emote(EmoteProvider::Bttv, id(1)?),
        ("betterttv.com", "users") => Link::BttvUser(id(1)?),
        ("cdn.betterttv.net", "emote") => Link::Emote(EmoteProvider::Bttv, id(1)?),
        ("frankerfacez.com", "emoticon") => {
            // `/emoticon/128054-OMEGALUL`
            let n = seg.get(1)?.split('-').next()?;
            Link::Emote(EmoteProvider::Ffz, n.parse::<u64>().ok()?.to_string())
        }
        ("frankerfacez.com", "channel") => Link::FfzChannel(seg.get(1).filter(|s| login_ok(s))?.to_lowercase()),
        ("cdn.frankerfacez.com", "emote") => Link::Emote(EmoteProvider::Ffz, seg.get(1)?.parse::<u64>().ok()?.to_string()),
        ("twitch.tv" | "m.twitch.tv", login) if login_ok(login) => Link::Twitch(login.to_lowercase()),
        _ => return None,
    };
    Some(link)
}

// --- 7TV ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct StvHost {
    files: Vec<StvFile>,
}

#[derive(Deserialize)]
struct StvFile {
    name: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
struct StvOwner {
    display_name: Option<String>,
    username: Option<String>,
}

#[derive(Deserialize)]
struct StvEmote {
    id: String,
    name: String,
    #[serde(default)]
    animated: bool,
    host: StvHost,
    owner: Option<StvOwner>,
}

impl From<StvEmote> for ExternalEmote {
    fn from(e: StvEmote) -> Self {
        let (width, height) =
            e.host.files.iter().find(|f| f.name.starts_with("1x")).map(|f| (f.width, f.height)).unwrap_or((32, 32));
        ExternalEmote {
            provider: EmoteProvider::SevenTv,
            id: e.id,
            name: e.name,
            animated: e.animated,
            width,
            height,
            owner: e.owner.and_then(|o| o.display_name.or(o.username)),
        }
    }
}

#[derive(Deserialize)]
struct StvSet {
    #[serde(default)]
    emotes: Option<Vec<StvSetEmote>>,
}

#[derive(Deserialize)]
struct StvSetEmote {
    /// Set-local name (may differ from the emote's own name).
    name: String,
    data: StvEmote,
}

impl StvSet {
    fn into_emotes(self) -> Vec<ExternalEmote> {
        self.emotes
            .unwrap_or_default()
            .into_iter()
            .map(|e| ExternalEmote { name: e.name, ..e.data.into() })
            .collect()
    }
}

// --- FrankerFaceZ ------------------------------------------------------------------

#[derive(Deserialize)]
struct FfzOwner {
    display_name: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct FfzEmote {
    id: u64,
    name: String,
    width: u32,
    height: u32,
    owner: Option<FfzOwner>,
    /// Present (a map of sizes to urls) only for animated emotes.
    animated: Option<serde_json::Value>,
}

impl From<FfzEmote> for ExternalEmote {
    fn from(e: FfzEmote) -> Self {
        ExternalEmote {
            provider: EmoteProvider::Ffz,
            id: e.id.to_string(),
            name: e.name,
            animated: e.animated.is_some_and(|a| a.is_object()),
            width: e.width,
            height: e.height,
            owner: e.owner.and_then(|o| o.display_name.or(o.name)),
        }
    }
}

#[derive(Deserialize)]
struct FfzRoom {
    room: FfzRoomInfo,
    sets: std::collections::HashMap<String, FfzSet>,
}

#[derive(Deserialize)]
struct FfzRoomInfo {
    twitch_id: Option<u64>,
}

#[derive(Deserialize)]
struct FfzSet {
    #[serde(default)]
    emoticons: Vec<FfzEmote>,
}

// --- BetterTTV ---------------------------------------------------------------------

#[derive(Deserialize)]
struct BttvEmote {
    id: String,
    code: String,
    #[serde(default)]
    animated: bool,
    user: Option<BttvUser>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BttvUser {
    display_name: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BttvChannel {
    #[serde(default)]
    channel_emotes: Vec<BttvEmote>,
    #[serde(default)]
    shared_emotes: Vec<BttvEmote>,
}

/// Width, height and animation of a WebP image, from its header.
pub fn webp_info(b: &[u8]) -> Option<(u32, u32, bool)> {
    if b.len() < 30 || &b[0..4] != b"RIFF" || &b[8..12] != b"WEBP" {
        return None;
    }
    let u24 = |i: usize| u32::from(b[i]) | u32::from(b[i + 1]) << 8 | u32::from(b[i + 2]) << 16;
    match &b[12..16] {
        b"VP8X" => Some((u24(24) + 1, u24(27) + 1, b[20] & 0x02 != 0)),
        b"VP8L" => {
            let bits = u32::from_le_bytes([b[21], b[22], b[23], b[24]]);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, false))
        }
        b"VP8 " => {
            let w = u16::from_le_bytes([b[26], b[27]]) & 0x3fff;
            let h = u16::from_le_bytes([b[28], b[29]]) & 0x3fff;
            Some((w.into(), h.into(), false))
        }
        _ => None,
    }
}

pub struct EmoteProviders {
    http: reqwest::Client,
    cache: DashMap<String, (Instant, Arc<Vec<ExternalEmote>>)>,
}

impl Default for EmoteProviders {
    fn default() -> Self {
        Self::new()
    }
}

impl EmoteProviders {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(concat!(
                    "discord-clone/",
                    env!("CARGO_PKG_VERSION"),
                    " (self-hosted chat server; emote lookups)"
                ))
                .timeout(Duration::from_secs(10))
                .build()
                .expect("http client"),
            cache: DashMap::new(),
        }
    }

    fn cached(&self, key: &str) -> Option<Arc<Vec<ExternalEmote>>> {
        self.cache.get(key).filter(|e| e.0.elapsed() < TTL).map(|e| e.1.clone())
    }

    fn store(&self, key: String, v: Arc<Vec<ExternalEmote>>) {
        if self.cache.len() >= MAX_CACHE {
            self.cache.retain(|_, e| e.0.elapsed() < TTL);
            if self.cache.len() >= MAX_CACHE {
                self.cache.clear();
            }
        }
        self.cache.insert(key, (Instant::now(), v));
    }

    async fn memo<F>(&self, key: String, f: F) -> Result<Arc<Vec<ExternalEmote>>>
    where
        F: Future<Output = Result<Vec<ExternalEmote>>>,
    {
        if let Some(v) = self.cached(&key) {
            return Ok(v);
        }
        let v = Arc::new(f.await?);
        self.store(key, v.clone());
        Ok(v)
    }

    async fn get<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let resp = self.http.get(url).send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ProviderError::NotFound);
        }
        Ok(resp.error_for_status()?.json().await?)
    }

    pub async fn search(&self, provider: EmoteProvider, query: &str, limit: u32) -> Result<Arc<Vec<ExternalEmote>>> {
        let key = format!("s:{}:{limit}:{}", provider.as_str(), query.to_lowercase());
        self.memo(key, async {
            match provider {
                EmoteProvider::SevenTv => {
                    #[derive(Deserialize)]
                    struct Resp {
                        data: Option<Data>,
                    }
                    #[derive(Deserialize)]
                    struct Data {
                        emotes: Items,
                    }
                    #[derive(Deserialize)]
                    struct Items {
                        items: Vec<StvEmote>,
                    }
                    let body = json!({
                        "query": "query($q:String!,$l:Int){emotes(query:$q,limit:$l,sort:{value:\"popularity\",order:DESCENDING}){items{id name animated host{files{name width height}} owner{username display_name}}}}",
                        "variables": {"q": query, "l": limit},
                    });
                    let resp: Resp =
                        self.http.post(SEVENTV_GQL).json(&body).send().await?.error_for_status()?.json().await?;
                    Ok(resp.data.map(|d| d.emotes.items).unwrap_or_default().into_iter().map(Into::into).collect())
                }
                EmoteProvider::Ffz => {
                    #[derive(Deserialize)]
                    struct Resp {
                        emoticons: Vec<FfzEmote>,
                    }
                    let mut url = Url::parse(&format!("{FFZ}/emotes")).expect("static url");
                    url.query_pairs_mut()
                        .append_pair("q", query)
                        .append_pair("sort", "count-desc")
                        .append_pair("per_page", &limit.min(200).to_string());
                    let resp: Resp = self.get(url.as_str()).await?;
                    Ok(resp.emoticons.into_iter().map(Into::into).collect())
                }
                EmoteProvider::Bttv => Err(ProviderError::Unsupported(
                    "BetterTTV has no public search; import a Twitch channel or paste an emote link",
                )),
            }
        })
        .await
    }

    /// A single emote. BetterTTV emotes can't be looked up publicly, so `name` is
    /// required for them and the size comes from the image itself.
    pub async fn emote(&self, provider: EmoteProvider, id: &str, name: Option<&str>) -> Result<ExternalEmote> {
        if !id_ok(id) {
            return Err(ProviderError::NotFound);
        }
        let key = format!("e:{}:{id}", provider.as_str());
        let v = self
            .memo(key, async {
                Ok(vec![match provider {
                    EmoteProvider::SevenTv => self.get::<StvEmote>(&format!("{SEVENTV}/emotes/{id}")).await?.into(),
                    EmoteProvider::Ffz => {
                        #[derive(Deserialize)]
                        struct Resp {
                            emote: FfzEmote,
                        }
                        self.get::<Resp>(&format!("{FFZ}/emote/{id}")).await?.emote.into()
                    }
                    EmoteProvider::Bttv => {
                        let (width, height, animated) = self.bttv_probe(id).await?;
                        ExternalEmote {
                            provider,
                            id: id.to_string(),
                            name: String::new(),
                            animated,
                            width,
                            height,
                            owner: None,
                        }
                    }
                }])
            })
            .await?;
        let mut e = v.first().cloned().ok_or(ProviderError::NotFound)?;
        if let Some(n) = name {
            e.name = n.to_string();
        }
        if e.name.is_empty() {
            return Err(ProviderError::Unsupported("BetterTTV emotes need a name"));
        }
        Ok(e)
    }

    /// Reads a BetterTTV emote's 1x WebP header for its size and animation flag.
    async fn bttv_probe(&self, id: &str) -> Result<(u32, u32, bool)> {
        let mut resp = self.http.get(format!("{BTTV_CDN}/{id}/1x.webp")).send().await?;
        if !resp.status().is_success() {
            return Err(ProviderError::NotFound);
        }
        let mut buf = Vec::new();
        while let Some(chunk) = resp.chunk().await? {
            buf.extend_from_slice(&chunk);
            if let Some(info) = webp_info(&buf) {
                return Ok(info);
            }
            if buf.len() > MAX_PROBE_BYTES {
                break;
            }
        }
        Err(ProviderError::Other("unrecognized BetterTTV image".into()))
    }

    async fn bttv_list(&self, emotes: Vec<BttvEmote>) -> Vec<ExternalEmote> {
        stream::iter(emotes)
            .map(|e| async move {
                // Probe failures fall back to BetterTTV's standard 28px square.
                let (width, height, animated) = self.bttv_probe(&e.id).await.unwrap_or((28, 28, e.animated));
                ExternalEmote {
                    provider: EmoteProvider::Bttv,
                    owner: e.user.and_then(|u| u.display_name.or(u.name)),
                    id: e.id,
                    name: e.code,
                    animated: animated || e.animated,
                    width,
                    height,
                }
            })
            .buffered(16)
            .collect()
            .await
    }

    pub async fn seventv_set(&self, id: &str) -> Result<Arc<Vec<ExternalEmote>>> {
        if !id_ok(id) {
            return Err(ProviderError::NotFound);
        }
        self.memo(format!("set:7tv:{id}"), async {
            Ok(self.get::<StvSet>(&format!("{SEVENTV}/emote-sets/{id}")).await?.into_emotes())
        })
        .await
    }

    /// The active emote set of a 7TV user (their first connection's set).
    pub async fn seventv_user(&self, id: &str) -> Result<Arc<Vec<ExternalEmote>>> {
        if !id_ok(id) {
            return Err(ProviderError::NotFound);
        }
        #[derive(Deserialize)]
        struct User {
            #[serde(default)]
            connections: Vec<Conn>,
        }
        #[derive(Deserialize)]
        struct Conn {
            emote_set_id: Option<String>,
        }
        let user: User = self.get(&format!("{SEVENTV}/users/{id}")).await?;
        let set = user.connections.into_iter().find_map(|c| c.emote_set_id).ok_or(ProviderError::NotFound)?;
        self.seventv_set(&set).await
    }

    /// Resolves a Twitch login to its numeric id via FrankerFaceZ, falling back to 7TV's
    /// user search (FFZ only knows channels that have used FFZ).
    async fn twitch_id(&self, login: &str) -> Result<u64> {
        match self.get::<FfzRoom>(&format!("{FFZ}/room/{login}")).await {
            Ok(FfzRoom { room: FfzRoomInfo { twitch_id: Some(id) }, .. }) => return Ok(id),
            Ok(_) | Err(ProviderError::NotFound) => {}
            Err(e) => return Err(e),
        }
        #[derive(Deserialize)]
        struct Resp {
            data: Option<Data>,
        }
        #[derive(Deserialize)]
        struct Data {
            users: Vec<User>,
        }
        #[derive(Deserialize)]
        struct User {
            connections: Vec<Conn>,
        }
        #[derive(Deserialize)]
        struct Conn {
            platform: String,
            id: String,
            username: String,
        }
        let body = json!({
            "query": "query($q:String!){users(query:$q){connections{platform id username}}}",
            "variables": {"q": login},
        });
        let resp: Resp = self.http.post(SEVENTV_GQL).json(&body).send().await?.error_for_status()?.json().await?;
        resp.data
            .into_iter()
            .flat_map(|d| d.users)
            .flat_map(|u| u.connections)
            .find(|c| c.platform == "TWITCH" && c.username.eq_ignore_ascii_case(login))
            .and_then(|c| c.id.parse().ok())
            .ok_or(ProviderError::NotFound)
    }

    /// One provider's emotes for a Twitch channel. Channels without emotes on that
    /// provider yield an empty list.
    pub async fn twitch_channel(&self, provider: EmoteProvider, login: &str) -> Result<Arc<Vec<ExternalEmote>>> {
        if !login_ok(login) {
            return Err(ProviderError::NotFound);
        }
        let key = format!("tw:{}:{login}", provider.as_str());
        self.memo(key, async {
            let empty = |r: Result<Vec<ExternalEmote>>| match r {
                Err(ProviderError::NotFound) => Ok(vec![]),
                r => r,
            };
            match provider {
                EmoteProvider::Ffz => empty(async {
                    let room: FfzRoom = self.get(&format!("{FFZ}/room/{login}")).await?;
                    Ok(room.sets.into_values().flat_map(|s| s.emoticons).map(Into::into).collect())
                }
                .await),
                EmoteProvider::SevenTv => {
                    let id = self.twitch_id(login).await?;
                    #[derive(Deserialize)]
                    struct Resp {
                        emote_set: Option<StvSet>,
                    }
                    empty(async {
                        let r: Resp = self.get(&format!("{SEVENTV}/users/twitch/{id}")).await?;
                        Ok(r.emote_set.map(StvSet::into_emotes).unwrap_or_default())
                    }
                    .await)
                }
                EmoteProvider::Bttv => {
                    let id = self.twitch_id(login).await?;
                    empty(async {
                        let ch: BttvChannel = self.get(&format!("{BTTV}/cached/users/twitch/{id}")).await?;
                        Ok(self.bttv_list(ch.channel_emotes.into_iter().chain(ch.shared_emotes).collect()).await)
                    }
                    .await)
                }
            }
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        use EmoteProvider::*;
        let cases = [
            ("https://7tv.app/emotes/01F6MZGCNG000255K4X1K96XYV", Link::Emote(SevenTv, "01F6MZGCNG000255K4X1K96XYV".into())),
            ("7tv.app/emote-sets/01HBR0B6XG000EHCF1GW1HN2CJ", Link::SevenTvSet("01HBR0B6XG000EHCF1GW1HN2CJ".into())),
            ("01HBR0B6XG000EHCF1GW1HN2CJ", Link::SevenTvSet("01HBR0B6XG000EHCF1GW1HN2CJ".into())),
            ("https://old.7tv.app/users/01F6RDZDRG0006GRP49Q74E2DF", Link::SevenTvUser("01F6RDZDRG0006GRP49Q74E2DF".into())),
            ("https://cdn.7tv.app/emote/abc123/4x.webp", Link::Emote(SevenTv, "abc123".into())),
            ("https://betterttv.com/emotes/5f1b0186cf6d2144653d2970", Link::Emote(Bttv, "5f1b0186cf6d2144653d2970".into())),
            ("https://cdn.betterttv.net/emote/5f1b0186cf6d2144653d2970/3x.webp", Link::Emote(Bttv, "5f1b0186cf6d2144653d2970".into())),
            ("https://www.frankerfacez.com/emoticon/128054-OMEGALUL", Link::Emote(Ffz, "128054".into())),
            ("https://cdn.frankerfacez.com/emote/128054/4", Link::Emote(Ffz, "128054".into())),
            ("https://www.frankerfacez.com/channel/xQc", Link::FfzChannel("xqc".into())),
            ("https://www.twitch.tv/Sodapoppin", Link::Twitch("sodapoppin".into())),
            ("xqc", Link::Twitch("xqc".into())),
        ];
        for (input, want) in cases {
            assert_eq!(parse_link(input), Some(want), "{input}");
        }
        assert_eq!(parse_link("https://example.com/emotes/1"), None);
        assert_eq!(parse_link("not a channel!"), None);
    }

    #[test]
    fn webp_headers() {
        // VP8X canvas 112x28, animated.
        let mut x = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\x02\0\0\0".to_vec();
        x.extend_from_slice(&[111, 0, 0, 27, 0, 0, 0, 0]);
        assert_eq!(webp_info(&x), Some((112, 28, true)));
        // VP8L 28x28: 14-bit (w-1), 14-bit (h-1) after the 0x2f signature.
        let bits: u32 = 27 | 27 << 14;
        let mut l = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f".to_vec();
        l.extend_from_slice(&bits.to_le_bytes());
        l.resize(30, 0);
        assert_eq!(webp_info(&l), Some((28, 28, false)));
        assert_eq!(webp_info(b"GIF89a"), None);
    }
}
