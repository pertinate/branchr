//! Friends, blocks and DMs between two signed-in people, over REST and the gateway.
//! Needs `TEST_DATABASE_URL`; skipped without it.

mod common;

use std::time::Duration;

use common::*;
use futures::{SinkExt, StreamExt};
use proto::social::{DmChannel, DmMessage, Person, Relationship, RelationshipKind, SocialEvent};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;

struct Client<'a> {
    h: &'a Harness,
    token: String,
}

impl Client<'_> {
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<serde_json::Value>) -> reqwest::Response {
        let mut r = self.h.http.request(method, format!("{}{path}", self.h.base)).bearer_auth(&self.token);
        if let Some(b) = body {
            r = r.json(&b);
        }
        r.send().await.unwrap()
    }
    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> T {
        let r = self.call(reqwest::Method::GET, path, None).await;
        assert!(r.status().is_success(), "GET {path}: {}", r.status());
        r.json().await.unwrap()
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn gateway(h: &Harness, token: &str) -> Socket {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("{}/gateway", h.base.replace("http", "ws"))).await.unwrap();
    ws.send(Message::text(json!({ "op": "identify", "d": { "token": token } }).to_string())).await.unwrap();
    ws
}

/// The next event matching `pick`, within a few seconds.
async fn next<T>(ws: &mut Socket, mut pick: impl FnMut(SocialEvent) -> Option<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let Some(Ok(Message::Text(t))) = ws.next().await else { panic!("gateway closed") };
            if let Some(v) = pick(serde_json::from_str(&t).unwrap()) {
                return v;
            }
        }
    })
    .await
    .expect("event in time")
}

#[tokio::test]
async fn friends_blocks_and_direct_messages() {
    let Some(h) = Harness::new().await else { return };
    let nelly = Client { h: &h, token: h.token_for("good").await };
    let bob = Client { h: &h, token: h.token_for("bob").await };
    let me: Person = nelly.get("/people/@me").await;
    assert_eq!(me.handle, "nelly");
    let bob_me: Person = bob.get("/people/@me").await;

    let mut nelly_ws = gateway(&h, &nelly.token).await;
    let ready = next(&mut nelly_ws, |e| if let SocialEvent::Ready(r) = e { Some(r) } else { None }).await;
    assert!(ready.relationships.is_empty());

    // Unknown handles (and blocks) fail the same way; asking yourself is refused.
    assert_eq!(nelly.call(reqwest::Method::POST, "/relationships", Some(json!({ "handle": "nobody" }))).await.status(), 400);
    assert_eq!(nelly.call(reqwest::Method::POST, "/relationships", Some(json!({ "handle": "nelly" }))).await.status(), 400);

    // A request and its acceptance, seen live by Nelly.
    assert!(nelly.call(reqwest::Method::POST, "/relationships", Some(json!({ "handle": "@Bob" }))).await.status().is_success());
    let r = next(&mut nelly_ws, |e| if let SocialEvent::RelationshipUpdate(r) = e { Some(r) } else { None }).await;
    assert_eq!((r.person.handle.as_str(), r.kind), ("bob", RelationshipKind::Outgoing));
    let bobs: Vec<Relationship> = bob.get("/relationships").await;
    assert_eq!(bobs[0].kind, RelationshipKind::Incoming);
    // DMs need friendship.
    assert_eq!(nelly.call(reqwest::Method::POST, "/dms", Some(json!({ "recipient": bob_me.id }))).await.status(), 403);
    assert!(bob.call(reqwest::Method::PUT, &format!("/relationships/{}", me.id), Some(json!({ "kind": "friend" }))).await.status().is_success());
    let r = next(&mut nelly_ws, |e| if let SocialEvent::RelationshipUpdate(r) = e { Some(r) } else { None }).await;
    assert_eq!(r.kind, RelationshipKind::Friend);

    // Bob comes online: Nelly sees it.
    let mut bob_ws = gateway(&h, &bob.token).await;
    // (Accepting also told her he was offline; this is him arriving.)
    let p = next(&mut nelly_ws, |e| if let SocialEvent::PresenceUpdate(p) = e { p.online.then_some(p) } else { None }).await;
    assert_eq!(p.id, bob_me.id);
    next(&mut bob_ws, |e| if let SocialEvent::Ready(_) = e { Some(()) } else { None }).await;

    // A DM: opening twice is the same channel; Bob gets it with the first message.
    let dm: DmChannel = nelly.call(reqwest::Method::POST, "/dms", Some(json!({ "recipient": bob_me.id }))).await.json().await.unwrap();
    let again: DmChannel = nelly.call(reqwest::Method::POST, "/dms", Some(json!({ "recipient": bob_me.id }))).await.json().await.unwrap();
    assert_eq!(dm.id, again.id);
    let sent: DmMessage = nelly
        .call(reqwest::Method::POST, &format!("/dms/{}/messages", dm.id), Some(json!({ "content": "hi bob", "nonce": "n1" })))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(sent.nonce.as_deref(), Some("n1"));
    let c = next(&mut bob_ws, |e| if let SocialEvent::DmChannelCreate(c) = e { Some(c) } else { None }).await;
    assert_eq!(c.recipients[0].handle, "nelly");
    let m = next(&mut bob_ws, |e| if let SocialEvent::DmMessageCreate(m) = e { Some(m) } else { None }).await;
    assert_eq!(m.content, "hi bob");

    // Only the author edits or deletes.
    let path = format!("/dms/{}/messages/{}", dm.id, sent.id);
    assert_eq!(bob.call(reqwest::Method::PATCH, &path, Some(json!({ "content": "x" }))).await.status(), 403);
    assert!(nelly.call(reqwest::Method::PATCH, &path, Some(json!({ "content": "hi bob!" }))).await.status().is_success());
    let m = next(&mut bob_ws, |e| if let SocialEvent::DmMessageUpdate(m) = e { Some(m) } else { None }).await;
    assert!(m.edited_at.is_some() && m.content == "hi bob!");
    let history: Vec<DmMessage> = bob.get(&format!("/dms/{}/messages", dm.id)).await;
    assert_eq!(history.len(), 1);
    // Strangers can't read it.
    assert!(nelly.call(reqwest::Method::DELETE, &path, None).await.status().is_success());
    next(&mut bob_ws, |e| if let SocialEvent::DmMessageDelete(_) = e { Some(()) } else { None }).await;

    // Bob blocks Nelly: they're no longer friends, and she can't message him or ask again.
    assert!(bob.call(reqwest::Method::PUT, &format!("/relationships/{}", me.id), Some(json!({ "kind": "blocked" }))).await.status().is_success());
    let gone = next(&mut nelly_ws, |e| if let SocialEvent::RelationshipRemove(r) = e { Some(r) } else { None }).await;
    assert_eq!(gone.id, bob_me.id);
    assert_eq!(nelly.call(reqwest::Method::POST, &format!("/dms/{}/messages", dm.id), Some(json!({ "content": "?" }))).await.status(), 403);
    assert_eq!(nelly.call(reqwest::Method::POST, "/relationships", Some(json!({ "handle": "bob" }))).await.status(), 400);
    // Unblocking leaves them strangers.
    assert!(bob.call(reqwest::Method::DELETE, &format!("/relationships/{}", me.id), None).await.status().is_success());
    let bobs: Vec<Relationship> = bob.get("/relationships").await;
    assert!(bobs.is_empty());

    h.finish().await;
}

#[tokio::test]
async fn group_dms() {
    let Some(h) = Harness::new().await else { return };
    let nelly = Client { h: &h, token: h.token_for("good").await };
    let bob = Client { h: &h, token: h.token_for("bob").await };
    let me: Person = nelly.get("/people/@me").await;
    let bob_me: Person = bob.get("/people/@me").await;

    // Groups are with friends only.
    let make = |body| nelly.call(reqwest::Method::POST, "/dms/groups", Some(body));
    assert_eq!(make(json!({ "recipients": [bob_me.id] })).await.status(), 403);
    nelly.call(reqwest::Method::POST, "/relationships", Some(json!({ "handle": "bob" }))).await;
    bob.call(reqwest::Method::PUT, &format!("/relationships/{}", me.id), Some(json!({ "kind": "friend" }))).await;

    let mut bob_ws = gateway(&h, &bob.token).await;
    next(&mut bob_ws, |e| if let SocialEvent::Ready(_) = e { Some(()) } else { None }).await;
    let g: DmChannel = make(json!({ "recipients": [bob_me.id], "name": "  " })).await.json().await.unwrap();
    assert!(g.group && g.name.is_none() && g.owner_id.as_deref() == Some(me.id.as_str()));
    // Bob hears about it at once (not on the first message, as with one-to-one).
    let seen = next(&mut bob_ws, |e| if let SocialEvent::DmChannelCreate(c) = e { Some(c) } else { None }).await;
    assert_eq!(seen.id, g.id);

    // Anyone renames; only the owner removes others; anyone leaves.
    let r = bob.call(reqwest::Method::PATCH, &format!("/dms/{}", g.id), Some(json!({ "name": "plans" }))).await;
    assert!(r.status().is_success());
    let renamed = next(&mut bob_ws, |e| if let SocialEvent::DmChannelCreate(c) = e { Some(c) } else { None }).await;
    assert_eq!(renamed.name.as_deref(), Some("plans"));
    assert_eq!(bob.call(reqwest::Method::DELETE, &format!("/dms/{}/recipients/{}", g.id, me.id), None).await.status(), 403);
    assert!(bob.call(reqwest::Method::DELETE, &format!("/dms/{}/recipients/{}", g.id, bob_me.id), None).await.status().is_success());
    let left = next(&mut bob_ws, |e| if let SocialEvent::DmChannelDelete(c) = e { Some(c) } else { None }).await;
    assert_eq!(left.id, g.id);
    let mine: Vec<DmChannel> = nelly.get("/dms").await;
    assert!(mine.iter().any(|c| c.id == g.id && c.recipients.is_empty()));
    let his: Vec<DmChannel> = bob.get("/dms").await;
    assert!(!his.iter().any(|c| c.id == g.id));

    h.finish().await;
}
