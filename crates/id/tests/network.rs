//! branchr staff and network-wide bans. Needs `TEST_DATABASE_URL`; skipped without it.

mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::json;

#[tokio::test]
async fn staff_ban_accounts_network_wide() {
    let Some(h) = Harness::new().await else { return };
    let nelly = h.token_for("good").await;
    let bob = h.token_for("bob").await;
    let get = |path: &str, token: &str| h.http.get(format!("{}{path}", h.base)).bearer_auth(token.to_string()).send();
    let put = |path: &str, token: &str, body: serde_json::Value| h.http.put(format!("{}{path}", h.base)).bearer_auth(token.to_string()).json(&body).send();
    let del = |path: &str, token: &str| h.http.delete(format!("{}{path}", h.base)).bearer_auth(token.to_string()).send();

    // Nobody's staff yet; Nelly becomes the first admin from the command line.
    let me: serde_json::Value = get("/network/me", &nelly).await.unwrap().json().await.unwrap();
    assert!(me["role"].is_null());
    assert_eq!(get("/network/bans", &nelly).await.unwrap().status(), StatusCode::FORBIDDEN);
    id::network::cli(&h.db, &["add".into(), "nelly".into(), "admin".into()]).await.unwrap();
    let me: serde_json::Value = get("/network/me", &nelly).await.unwrap().json().await.unwrap();
    assert_eq!(me["role"], "admin");

    // A ban needs a reason; then Bob is out: his tokens stop working at once.
    assert_eq!(put("/network/bans/bob", &nelly, json!({ "reason": " " })).await.unwrap().status(), StatusCode::BAD_REQUEST);
    assert_eq!(put("/network/bans/@Bob", &nelly, json!({ "reason": "spam" })).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(get("/people/@me", &bob).await.unwrap().status(), StatusCode::FORBIDDEN);
    let bans: Vec<serde_json::Value> = get("/network/bans", &nelly).await.unwrap().json().await.unwrap();
    assert_eq!(bans.len(), 1);
    assert_eq!(bans[0]["account"]["handle"], "bob");
    assert_eq!(bans[0]["reason"], "spam");
    assert_eq!(bans[0]["bannedBy"], "nelly");
    assert_eq!(put("/network/bans/nelly", &nelly, json!({ "reason": "x" })).await.unwrap().status(), StatusCode::BAD_REQUEST, "not yourself");

    // Unbanned: back in, and made a moderator, who can ban but not manage staff.
    assert_eq!(del("/network/bans/bob", &nelly).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(get("/people/@me", &bob).await.unwrap().status(), StatusCode::OK);
    assert_eq!(put("/network/staff/bob", &nelly, json!({ "role": "moderator" })).await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(get("/network/bans", &bob).await.unwrap().status(), StatusCode::OK);
    assert_eq!(put("/network/staff/bob", &bob, json!({ "role": "admin" })).await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_eq!(put("/network/bans/nelly", &bob, json!({ "reason": "coup" })).await.unwrap().status(), StatusCode::BAD_REQUEST, "staff can't be banned");
    let staff: Vec<serde_json::Value> = get("/network/staff", &bob).await.unwrap().json().await.unwrap();
    assert_eq!(staff.len(), 2);
    h.finish().await;
}
