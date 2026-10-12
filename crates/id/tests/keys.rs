//! Signing key rotation against a real Postgres. Needs `TEST_DATABASE_URL`; skipped without it.

mod common;

use std::time::Duration;

use common::*;
use id::keys::{Keys, rotate};
use serde::Serialize;

#[derive(Serialize)]
struct Claims {
    iss: String,
    aud: String,
    exp: u64,
}

fn signer(keys: &Keys) -> String {
    let token = keys.sign(&Claims { iss: "i".into(), aud: "a".into(), exp: u64::MAX / 2 }).unwrap();
    jsonwebtoken::decode_header(&token).unwrap().kid.unwrap()
}

#[tokio::test]
async fn keys_rotate_published_ahead_then_retired() {
    let Some(h) = Harness::new().await else { return };
    let keys = Keys::load(&h.db).await.unwrap();
    let first = signer(&keys);
    assert_eq!(keys.jwks().keys.len(), 1);
    let day = Duration::from_secs(86400);
    let overlap = Duration::from_secs(2);
    assert!(!rotate(&h.db, day, overlap).await.unwrap(), "a fresh key isn't due");

    // A day on: a new key is published but doesn't sign yet.
    sqlx::query("UPDATE signing_keys SET activates_at = activates_at - interval '2 days'").execute(&h.db).await.unwrap();
    assert!(rotate(&h.db, day, overlap).await.unwrap());
    assert!(!rotate(&h.db, day, overlap).await.unwrap(), "one waiting key is enough");
    keys.reload(&h.db).await.unwrap();
    let published: Vec<String> = keys.jwks().keys.into_iter().map(|k| k.kid).collect();
    assert_eq!(published.len(), 2);
    assert_eq!(signer(&keys), first, "the new key waits its turn");
    let next = published.into_iter().find(|k| *k != first).unwrap();

    // Its turn comes; the old key stays published for the overlap, then goes.
    sqlx::query("UPDATE signing_keys SET activates_at = now() WHERE kid = $1").bind(&next).execute(&h.db).await.unwrap();
    keys.reload(&h.db).await.unwrap();
    assert_eq!(signer(&keys), next);
    assert!(!rotate(&h.db, day, overlap).await.unwrap(), "still inside the overlap");
    assert_eq!(keys.jwks().keys.len(), 2);
    tokio::time::sleep(overlap + Duration::from_millis(500)).await;
    assert!(rotate(&h.db, day, overlap).await.unwrap());
    keys.reload(&h.db).await.unwrap();
    let left: Vec<String> = keys.jwks().keys.into_iter().map(|k| k.kid).collect();
    assert_eq!(left, vec![next]);
}
