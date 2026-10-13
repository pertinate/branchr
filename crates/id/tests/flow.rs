//! The whole sign-in against a real Postgres and a stand-in Discord.
//!
//! Needs `TEST_DATABASE_URL` (postgres://…); each test uses its own schema and drops it at
//! the end (a failed test's schema is swept by a later run). Skipped when unset so
//! `cargo test` works without a database.


mod common;

use common::*;

#[tokio::test]
async fn sign_in_refresh_and_logout() {
    let Some(h) = Harness::new().await else { return };

    let back = h.sign_in("good").await;
    assert!(back.as_str().starts_with("branchr://auth/callback?"), "{back}");
    assert_eq!(param(&back, "state").as_deref(), Some("client-state"));
    let code = param(&back, "code").unwrap();

    // The wrong verifier is refused (and burns the code).
    let r = h.token(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT), ("code_verifier", &"x".repeat(43))]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = h.token(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT), ("code_verifier", VERIFIER)]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST, "codes are single-use");

    let code = param(&h.sign_in("good").await, "code").unwrap();
    let r = h.token(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT), ("code_verifier", VERIFIER)]).await;
    assert_eq!(r.status(), StatusCode::OK);
    let t: TokenResponse = r.json().await.unwrap();
    assert_eq!(t.account.display_name, "Nelly");
    let first_account = t.account.id;

    // The access token verifies with nothing but the published JWKS, as an instance would.
    let jwks: serde_json::Value = h.http.get(format!("{}/.well-known/jwks.json", h.base)).send().await.unwrap().json().await.unwrap();
    let x = jwks["keys"][0]["x"].as_str().unwrap();
    let mut v = Validation::new(Algorithm::EdDSA);
    v.set_audience(&["branchr-id"]);
    v.set_issuer(&[&h.base]);
    let claims = jsonwebtoken::decode::<serde_json::Value>(&t.access_token, &DecodingKey::from_ed_components(x).unwrap(), &v).unwrap();
    assert_eq!(claims.claims["sub"], first_account.to_string());

    let me: Account = h.http.get(format!("{}/me", h.base)).bearer_auth(&t.access_token).send().await.unwrap().json().await.unwrap();
    assert_eq!(me.id, first_account);
    let r = h.http.get(format!("{}/me", h.base)).bearer_auth("nope").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);

    // Signing in again is the same account.
    let code = param(&h.sign_in("good").await, "code").unwrap();
    let again: TokenResponse =
        h.token(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT), ("code_verifier", VERIFIER)]).await.json().await.unwrap();
    assert_eq!(again.account.id, first_account);

    // Refresh rotates. Two tabs refreshing at once may both use the old token, briefly.
    let r1: TokenResponse = h.token(&[("grant_type", "refresh_token"), ("refresh_token", &t.refresh_token)]).await.json().await.unwrap();
    assert_ne!(r1.refresh_token, t.refresh_token);
    let r = h.token(&[("grant_type", "refresh_token"), ("refresh_token", &t.refresh_token)]).await;
    assert_eq!(r.status(), StatusCode::OK, "a concurrent refresh within the grace period works");
    // Later, reusing a rotated token means it leaked: the whole sign-in is revoked.
    sqlx::query("UPDATE refresh_tokens SET rotated_at = now() - interval '5 minutes' WHERE rotated").execute(&h.db).await.unwrap();
    let r = h.token(&[("grant_type", "refresh_token"), ("refresh_token", &t.refresh_token)]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST, "reuse is refused");
    let r = h.token(&[("grant_type", "refresh_token"), ("refresh_token", &r1.refresh_token)]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST, "and the newer token died with it");

    // The other sign-in is unaffected until it logs out.
    let r = h.token(&[("grant_type", "refresh_token"), ("refresh_token", &again.refresh_token)]).await;
    assert_eq!(r.status(), StatusCode::OK);
    let latest: TokenResponse = r.json().await.unwrap();
    let r = h.http.post(format!("{}/logout", h.base)).form(&[("refresh_token", &latest.refresh_token)]).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let r = h.token(&[("grant_type", "refresh_token"), ("refresh_token", &latest.refresh_token)]).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    h.finish().await;
}

#[tokio::test]
async fn refuses_bad_requests() {
    let Some(h) = Harness::new().await else { return };

    // Only allow-listed redirect URIs.
    let r = h
        .http
        .get(format!("{}/authorize", h.base))
        .query(&[
            ("redirect_uri", "https://evil.example/cb"),
            ("code_challenge", &Harness::challenge(VERIFIER)),
            ("code_challenge_method", "S256"),
            ("state", "s"),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);

    // PKCE is mandatory.
    let r = h
        .http
        .get(format!("{}/authorize", h.base))
        .query(&[("redirect_uri", REDIRECT), ("code_challenge", VERIFIER), ("code_challenge_method", "plain"), ("state", "s")])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);

    // A callback for an unknown sign-in shows an error page and redirects nowhere.
    let r = h.http.get(format!("{}/auth/discord/callback", h.base)).query(&[("code", "good"), ("state", "made-up")]).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(r.text().await.unwrap().contains("expired or was already used"));

    // Discord refusing the code surfaces as an error, not an account.
    let r = h
        .http
        .get(format!("{}/authorize", h.base))
        .query(&[("redirect_uri", REDIRECT), ("code_challenge", &Harness::challenge(VERIFIER)), ("code_challenge_method", "S256"), ("state", "s")])
        .send()
        .await
        .unwrap();
    let state = param(&url::Url::parse(r.headers()["location"].to_str().unwrap()).unwrap(), "state").unwrap();
    let r = h.http.get(format!("{}/auth/discord/callback", h.base)).query(&[("code", "bad"), ("state", &state)]).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_GATEWAY);

    // Declining at Discord goes back to the client with an error.
    let r = h
        .http
        .get(format!("{}/authorize", h.base))
        .query(&[("redirect_uri", REDIRECT), ("code_challenge", &Harness::challenge(VERIFIER)), ("code_challenge_method", "S256"), ("state", "s2")])
        .send()
        .await
        .unwrap();
    let state = param(&url::Url::parse(r.headers()["location"].to_str().unwrap()).unwrap(), "state").unwrap();
    let r = h.http.get(format!("{}/auth/discord/callback", h.base)).query(&[("error", "access_denied"), ("state", &state)]).send().await.unwrap();
    let back = url::Url::parse(r.headers()["location"].to_str().unwrap()).unwrap();
    assert_eq!(param(&back, "error").as_deref(), Some("access_denied"));
    assert_eq!(param(&back, "state").as_deref(), Some("s2"));
    h.finish().await;
}

impl Harness {
    /// A signed-in user's access token (the fake Discord user 42).
    async fn access_token(&self) -> String {
        let code = param(&self.sign_in("good").await, "code").unwrap();
        let t: TokenResponse = self
            .token(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT), ("code_verifier", VERIFIER)])
            .await
            .json()
            .await
            .unwrap();
        t.access_token
    }
}

#[tokio::test]
async fn servers_register_get_claimed_and_issue_passes() {
    use id::instances::{Claimed, InstanceToken, Registered, Status};
    let Some(h) = Harness::new().await else { return };

    let reg: Registered = h
        .http
        .post(format!("{}/instances", h.base))
        .json(&serde_json::json!({ "name": "Home lab", "publicUrl": "https://chat.example.com" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let status_url = format!("{}/instances/{}", h.base, reg.instance_id);
    let st: Status = h.http.get(&status_url).bearer_auth(&reg.secret).send().await.unwrap().json().await.unwrap();
    assert!(!st.claimed);
    let r = h.http.get(&status_url).bearer_auth("wrong").send().await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED, "status needs the server's secret");

    // Claiming needs a signed-in user; the code is forgiving about how it's typed.
    let at = h.access_token().await;
    let r = h.http.post(format!("{}/claims", h.base)).json(&serde_json::json!({ "code": reg.claim_code })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let typed = reg.claim_code.to_lowercase().replace('-', " ");
    let claimed: Claimed =
        h.http.post(format!("{}/claims", h.base)).bearer_auth(&at).json(&serde_json::json!({ "code": typed })).send().await.unwrap().json().await.unwrap();
    assert_eq!(claimed.instance_id, reg.instance_id);
    assert_eq!(claimed.name, "Home lab");
    let r = h.http.post(format!("{}/claims", h.base)).bearer_auth(&at).json(&serde_json::json!({ "code": reg.claim_code })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST, "a code works once");
    let st: Status = h.http.get(&status_url).bearer_auth(&reg.secret).send().await.unwrap().json().await.unwrap();
    assert!(st.claimed && st.owner_id.is_some());
    let r = h.http.post(format!("{status_url}/claim-code")).bearer_auth(&reg.secret).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST, "no new codes once claimed");

    // A pass for this server only, saying who the user is.
    let pass: InstanceToken = h.http.post(format!("{status_url}/token")).bearer_auth(&at).send().await.unwrap().json().await.unwrap();
    let jwks: serde_json::Value = h.http.get(format!("{}/.well-known/jwks.json", h.base)).send().await.unwrap().json().await.unwrap();
    let key = DecodingKey::from_ed_components(jwks["keys"][0]["x"].as_str().unwrap()).unwrap();
    let mut v = Validation::new(Algorithm::EdDSA);
    v.set_issuer(&[&h.base]);
    v.set_audience(&[reg.instance_id.to_string()]);
    let c = jsonwebtoken::decode::<serde_json::Value>(&pass.token, &key, &v).unwrap().claims;
    assert_eq!(c["name"], "Nelly");
    assert_eq!(c["username"], "nelly");
    v.set_audience(&["some-other-server"]);
    assert!(jsonwebtoken::decode::<serde_json::Value>(&pass.token, &key, &v).is_err(), "not valid for other servers");

    let r = h.http.post(format!("{}/instances/{}/token", h.base, uuid::Uuid::now_v7())).bearer_auth(&at).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST, "unknown server");

    // The owner sees it among their servers.
    let owned: Vec<serde_json::Value> = h.http.get(format!("{}/me/owned", h.base)).bearer_auth(&at).send().await.unwrap().json().await.unwrap();
    assert_eq!(owned.len(), 1);
    assert_eq!(owned[0]["instanceId"], reg.instance_id.to_string());
    assert_eq!(owned[0]["publicUrl"], "https://chat.example.com");

    // Handing it to Bob: it's his now, and the server sees the new owner.
    let bob = h.token_for("bob").await;
    let transfer = format!("{status_url}/transfer");
    let r = h.http.post(&transfer).bearer_auth(&at).json(&serde_json::json!({ "handle": "nobody_here" })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST, "unknown handle");
    let r = h.http.post(&transfer).bearer_auth(&bob).json(&serde_json::json!({ "handle": "bob" })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST, "only to someone else");
    let r = h.http.post(&transfer).bearer_auth(&at).json(&serde_json::json!({ "handle": "@Bob" })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    let mine: Vec<serde_json::Value> = h.http.get(format!("{}/me/owned", h.base)).bearer_auth(&at).send().await.unwrap().json().await.unwrap();
    assert!(mine.is_empty());
    let his: Vec<serde_json::Value> = h.http.get(format!("{}/me/owned", h.base)).bearer_auth(&bob).send().await.unwrap().json().await.unwrap();
    assert_eq!(his.len(), 1);
    let st2: Status = h.http.get(&status_url).bearer_auth(&reg.secret).send().await.unwrap().json().await.unwrap();
    assert!(st2.claimed && st2.owner_id != st.owner_id);
    let r = h.http.post(&transfer).bearer_auth(&at).json(&serde_json::json!({ "handle": "bob" })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND, "no longer Nelly's to give");
    h.finish().await;
}

#[tokio::test]
async fn remembers_an_accounts_hosts() {
    let Some(h) = Harness::new().await else { return };
    let at = h.access_token().await;
    let url = format!("{}/me/instances", h.base);
    let r = h.http.get(&url).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);

    for u in ["https://b.example.com/", "http://localhost:8081/#/invite/x", "https://b.example.com"] {
        let r = h.http.put(&url).bearer_auth(&at).json(&serde_json::json!({ "url": u })).send().await.unwrap();
        assert_eq!(r.status(), StatusCode::OK, "{u}");
    }
    let r = h.http.put(&url).bearer_auth(&at).json(&serde_json::json!({ "url": "javascript:alert(1)" })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let hosts: Vec<serde_json::Value> = h.http.get(&url).bearer_auth(&at).send().await.unwrap().json().await.unwrap();
    let urls: Vec<&str> = hosts.iter().map(|x| x["url"].as_str().unwrap()).collect();
    assert_eq!(urls, ["https://b.example.com", "http://localhost:8081"], "normalized to origins, no duplicates");

    let r = h.http.delete(&url).bearer_auth(&at).json(&serde_json::json!({ "url": "https://b.example.com/" })).send().await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let hosts: Vec<serde_json::Value> = h.http.get(&url).bearer_auth(&at).send().await.unwrap().json().await.unwrap();
    assert_eq!(hosts.len(), 1);
    h.finish().await;
}
