//! 7TV integration: emote search / lookup proxied and cached server-side so clients
//! don't each hit 7TV and so the instance works behind strict CSPs. Images themselves
//! are loaded straight from the 7TV CDN.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use proto::models::SevenTvEmote;
use serde::Deserialize;
use serde_json::json;

const GQL: &str = "https://7tv.io/v3/gql";
const REST: &str = "https://7tv.io/v3";
const TTL: Duration = Duration::from_secs(600);
const MAX_CACHE: usize = 2048;

pub struct SevenTv {
    http: reqwest::Client,
    cache: DashMap<String, (Instant, Arc<Vec<SevenTvEmote>>)>,
}

#[derive(Deserialize)]
struct Host {
    files: Vec<File>,
}

#[derive(Deserialize)]
struct File {
    name: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
struct Owner {
    display_name: Option<String>,
    username: Option<String>,
}

#[derive(Deserialize)]
struct RawEmote {
    id: String,
    name: String,
    #[serde(default)]
    animated: bool,
    host: Host,
    owner: Option<Owner>,
}

impl From<RawEmote> for SevenTvEmote {
    fn from(e: RawEmote) -> Self {
        let (width, height) = e
            .host
            .files
            .iter()
            .find(|f| f.name.starts_with("1x"))
            .map(|f| (f.width, f.height))
            .unwrap_or((32, 32));
        SevenTvEmote {
            id: e.id,
            name: e.name,
            animated: e.animated,
            width,
            height,
            owner: e.owner.and_then(|o| o.display_name.or(o.username)),
        }
    }
}

impl SevenTv {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("discord-clone/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(10))
                .build()
                .expect("http client"),
            cache: DashMap::new(),
        }
    }

    fn cached(&self, key: &str) -> Option<Arc<Vec<SevenTvEmote>>> {
        self.cache.get(key).filter(|e| e.0.elapsed() < TTL).map(|e| e.1.clone())
    }

    fn store(&self, key: String, v: Arc<Vec<SevenTvEmote>>) {
        if self.cache.len() >= MAX_CACHE {
            self.cache.retain(|_, e| e.0.elapsed() < TTL);
            if self.cache.len() >= MAX_CACHE {
                self.cache.clear();
            }
        }
        self.cache.insert(key, (Instant::now(), v));
    }

    pub async fn search(&self, query: &str, limit: u32) -> anyhow::Result<Arc<Vec<SevenTvEmote>>> {
        let key = format!("s:{limit}:{}", query.to_lowercase());
        if let Some(v) = self.cached(&key) {
            return Ok(v);
        }
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
            items: Vec<RawEmote>,
        }
        let body = json!({
            "query": "query($q:String!,$l:Int){emotes(query:$q,limit:$l,sort:{value:\"popularity\",order:DESCENDING}){items{id name animated host{files{name width height}} owner{username display_name}}}}",
            "variables": {"q": query, "l": limit},
        });
        let resp: Resp = self.http.post(GQL).json(&body).send().await?.error_for_status()?.json().await?;
        let items = resp.data.map(|d| d.emotes.items).unwrap_or_default();
        let v = Arc::new(items.into_iter().map(Into::into).collect::<Vec<_>>());
        self.store(key, v.clone());
        Ok(v)
    }

    pub async fn emote(&self, id: &str) -> anyhow::Result<SevenTvEmote> {
        let key = format!("e:{id}");
        if let Some(v) = self.cached(&key)
            && let Some(e) = v.first()
        {
            return Ok(e.clone());
        }
        anyhow::ensure!(id.chars().all(|c| c.is_ascii_alphanumeric()), "bad emote id");
        let raw: RawEmote = self.http.get(format!("{REST}/emotes/{id}")).send().await?.error_for_status()?.json().await?;
        let e: SevenTvEmote = raw.into();
        self.store(key, Arc::new(vec![e.clone()]));
        Ok(e)
    }

    /// All emotes of a 7TV emote set (e.g. a streamer's channel set), using set-local names.
    pub async fn emote_set(&self, id: &str) -> anyhow::Result<Vec<SevenTvEmote>> {
        anyhow::ensure!(id.chars().all(|c| c.is_ascii_alphanumeric()), "bad set id");
        #[derive(Deserialize)]
        struct Set {
            #[serde(default)]
            emotes: Vec<SetEmote>,
        }
        #[derive(Deserialize)]
        struct SetEmote {
            name: String,
            data: RawEmote,
        }
        let set: Set = self.http.get(format!("{REST}/emote-sets/{id}")).send().await?.error_for_status()?.json().await?;
        Ok(set
            .emotes
            .into_iter()
            .map(|e| {
                let mut out: SevenTvEmote = e.data.into();
                out.name = e.name;
                out
            })
            .collect())
    }
}
