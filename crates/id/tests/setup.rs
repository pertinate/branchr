//! Setting a hub up with a one-time code. Needs `TEST_DATABASE_URL`; skipped without it.

mod common;

use common::*;
use reqwest::StatusCode;
use serde_json::json;

#[tokio::test]
async fn a_setup_code_makes_a_hub_already_owned() {
    let Some(h) = Harness::new().await else { return };
    let nelly = h.token_for("good").await;
    let bob = h.token_for("bob").await;

    assert_eq!(h.http.post(format!("{}/setup-codes", h.base)).json(&json!({ "name": "Den" })).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    let code: serde_json::Value = h.http.post(format!("{}/setup-codes", h.base)).bearer_auth(&nelly).json(&json!({ "name": "Den" })).send().await.unwrap().json().await.unwrap();
    let code = code["code"].as_str().unwrap().to_string();
    assert!(code.starts_with("BRS-") && code.len() == 23, "{code}");
    let status = |token: String| {
        let url = format!("{}/setup-codes/{code}", h.base);
        let http = h.http.clone();
        async move { http.get(url).bearer_auth(token).send().await.unwrap() }
    };
    let st: serde_json::Value = status(nelly.clone()).await.json().await.unwrap();
    assert!(st["instanceId"].is_null());
    assert_eq!(status(bob.clone()).await.status(), StatusCode::NOT_FOUND, "only its owner can look");

    // The hub's first start: the code becomes its key and secret, and it's Nelly's.
    let reg: serde_json::Value = h.http.post(format!("{}/instances/setup", h.base)).json(&json!({ "code": code.to_lowercase(), "publicUrl": "" })).send().await.unwrap().json().await.unwrap();
    assert_eq!(reg["claimCode"], "");
    let key = reg["instanceId"].as_str().unwrap().to_string();
    let again = h.http.post(format!("{}/instances/setup", h.base)).json(&json!({ "code": code })).send().await.unwrap();
    assert_eq!(again.status(), StatusCode::BAD_REQUEST, "once only");

    let st: serde_json::Value = status(nelly.clone()).await.json().await.unwrap();
    assert_eq!(st["instanceId"], key);
    let owned: Vec<serde_json::Value> = h.http.get(format!("{}/me/owned", h.base)).bearer_auth(&nelly).send().await.unwrap().json().await.unwrap();
    assert!(owned.iter().any(|o| o["instanceId"] == key && o["name"] == "Den"));
    let hub: serde_json::Value = h.http.get(format!("{}/instances/{key}", h.base)).bearer_auth(reg["secret"].as_str().unwrap()).send().await.unwrap().json().await.unwrap();
    assert_eq!(hub["claimed"], true);
    h.finish().await;
}
