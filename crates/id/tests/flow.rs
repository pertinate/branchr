//! The whole sign-in against a real Postgres and a stand-in Discord.
//!
//! Needs `TEST_DATABASE_URL` (postgres://…); each test uses its own schema and drops it at
//! the end (a failed test's schema is swept by a later run). Skipped when unset so
//! `cargo test` works without a database.

use std::net::SocketAddr;

use axum::routing::{get, post};
use axum::{Form, Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use id::config::Config;
use id::oauth::{Account, TokenResponse};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use reqwest::StatusCode;
use reqwest::redirect::Policy;
use sha2::{Digest, Sha256};

const REDIRECT: &str = "branchr://auth/callback";
const VERIFIER: &str = "a-pkce-verifier-that-is-long-enough-for-rfc-7636-0123456789";

async fn serve(app: Router) -> SocketAddr {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    addr
}

/// Discord's token and user endpoints. Code `good` belongs to user 42.
fn fake_discord() -> Router {
    #[derive(serde::Deserialize)]
    struct F {
        code: String,
        grant_type: String,
    }
    Router::new()
        .route(
            "/oauth2/token",
            post(|Form(f): Form<F>| async move {
                assert_eq!(f.grant_type, "authorization_code");
                if f.code == "good" {
                    Ok(Json(serde_json::json!({ "access_token": "discord-at", "token_type": "Bearer" })))
                } else {
                    Err(StatusCode::BAD_REQUEST)
                }
            }),
        )
        .route(
            "/users/@me",
            get(|| async { Json(serde_json::json!({ "id": "42", "username": "nelly", "global_name": "Nelly", "avatar": null })) }),
        )
}

struct Harness {
    base: String,
    http: reqwest::Client,
    db: sqlx::PgPool,
    schema: String,
}

impl Harness {
    async fn new() -> Option<Self> {
        let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
            eprintln!("TEST_DATABASE_URL not set; skipping");
            return None;
        };
        sweep(&url).await;
        let schema = format!("idtest_{}", uuid::Uuid::now_v7().simple());
        let db = id::connect(&url, Some(&schema)).await.expect("database");
        let discord = serve(fake_discord()).await;
        // Bind first so the public URL (token issuer, Discord redirect) is known.
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let config = Config {
            bind: l.local_addr().unwrap(),
            public_url: base.clone(),
            database_url: url,
            discord_client_id: "client".into(),
            discord_client_secret: "secret".into(),
            discord_api: format!("http://{discord}"),
            discord_authorize: "https://discord.example/oauth2/authorize".into(),
            redirects: vec![REDIRECT.into()],
        };
        let app = id::router(id::state(config, db.clone()).await.unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let http = reqwest::Client::builder().redirect(Policy::none()).build().unwrap();
        Some(Self { base, http, db, schema })
    }

    fn challenge(verifier: &str) -> String {
        B64.encode(Sha256::digest(verifier.as_bytes()))
    }

    /// /authorize → (Discord) → callback with Discord's `code`; returns where we were sent.
    async fn sign_in(&self, discord_code: &str) -> url::Url {
        let r = self
            .http
            .get(format!("{}/authorize", self.base))
            .query(&[
                ("redirect_uri", REDIRECT),
                ("code_challenge", &Self::challenge(VERIFIER)),
                ("code_challenge_method", "S256"),
                ("state", "client-state"),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::SEE_OTHER, "{}", r.text().await.unwrap());
        let to_discord = url::Url::parse(r.headers()["location"].to_str().unwrap()).unwrap();
        assert!(to_discord.as_str().starts_with("https://discord.example/oauth2/authorize?"));
        let q: std::collections::HashMap<_, _> = to_discord.query_pairs().into_owned().collect();
        assert_eq!(q["scope"], "identify", "identify only");
        assert_eq!(q["redirect_uri"], format!("{}/auth/discord/callback", self.base));

        let r = self
            .http
            .get(format!("{}/auth/discord/callback", self.base))
            .query(&[("code", discord_code), ("state", &q["state"])])
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::SEE_OTHER);
        url::Url::parse(r.headers()["location"].to_str().unwrap()).unwrap()
    }

    async fn token(&self, form: &[(&str, &str)]) -> reqwest::Response {
        self.http.post(format!("{}/token", self.base)).form(form).send().await.unwrap()
    }
}

impl Harness {
    async fn finish(self) {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {} CASCADE", self.schema))).execute(&self.db).await.unwrap();
        self.db.close().await;
    }
}

/// Drops test schemas left by failed runs over an hour ago (their names carry a UUIDv7 time).
async fn sweep(url: &str) {
    let db = sqlx::PgPool::connect(url).await.expect("database");
    let names: Vec<(String,)> = sqlx::query_as("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'idtest\\_%'").fetch_all(&db).await.unwrap();
    let hour_ago = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs().saturating_sub(3600);
    for (name,) in names {
        let old = uuid::Uuid::parse_str(&name["idtest_".len()..])
            .ok()
            .and_then(|u| u.get_timestamp())
            .is_some_and(|t| t.to_unix().0 < hour_ago);
        if old {
            let _ = sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {name} CASCADE"))).execute(&db).await;
        }
    }
    db.close().await;
}

fn param(u: &url::Url, k: &str) -> Option<String> {
    u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned())
}

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
