//! Ed25519 signing keys for the JWTs branchr ID issues, published as a JWKS so instances
//! can verify tokens without calling back here.
//!
//! Keys rotate on their own: every `KEY_ROTATE_DAYS` (90; 0 turns it off) a new key is
//! published an hour before it starts signing, so instances already have it, and the old one
//! is retired an hour after that, when every token it signed has expired.

use std::sync::RwLock;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::EncodePrivateKey;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

struct Key {
    kid: String,
    /// Signing yet (otherwise only published, ahead of taking over).
    active: bool,
    encoding: EncodingKey,
    decoding: DecodingKey,
    public: [u8; 32],
}

pub struct Keys {
    /// Every unretired key, newest first; the first active one signs.
    keys: RwLock<Vec<Key>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Jwk {
    pub kty: String,
    pub crv: String,
    pub alg: String,
    #[serde(rename = "use")]
    pub use_: String,
    pub kid: String,
    pub x: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Jwks {
    pub keys: Vec<Jwk>,
}

fn key(kid: String, seed: &[u8], active: bool) -> anyhow::Result<Key> {
    let seed: [u8; 32] = seed.try_into().map_err(|_| anyhow::anyhow!("signing key {kid}: bad seed"))?;
    let sk = SigningKey::from_bytes(&seed);
    let der = sk.to_pkcs8_der().map_err(|e| anyhow::anyhow!("signing key {kid}: {e}"))?;
    let public = sk.verifying_key().to_bytes();
    Ok(Key { kid, active, encoding: EncodingKey::from_ed_der(der.as_bytes()), decoding: DecodingKey::from_ed_der(&public), public })
}

impl Keys {
    /// Loads the keys, creating the first one on a fresh database.
    pub async fn load(db: &PgPool) -> anyhow::Result<Self> {
        let me = Self { keys: RwLock::new(Vec::new()) };
        me.reload(db).await?;
        Ok(me)
    }

    /// Picks up keys added or retired (by rotation here or on another replica).
    pub async fn reload(&self, db: &PgPool) -> anyhow::Result<()> {
        const Q: &str = "SELECT kid, seed, activates_at <= now() FROM signing_keys WHERE NOT retired ORDER BY activates_at DESC";
        let mut rows: Vec<(String, Vec<u8>, bool)> = sqlx::query_as(Q).fetch_all(db).await?;
        if !rows.iter().any(|r| r.2) {
            insert_key(db, Duration::ZERO).await?;
            // Another replica may have raced us; take whatever is newest.
            rows = sqlx::query_as(Q).fetch_all(db).await?;
        }
        let keys = rows.into_iter().map(|(kid, seed, active)| key(kid, &seed, active)).collect::<anyhow::Result<Vec<_>>>()?;
        *self.keys.write().expect("keys lock") = keys;
        Ok(())
    }

    pub fn sign<T: Serialize>(&self, claims: &T) -> anyhow::Result<String> {
        let keys = self.keys.read().expect("keys lock");
        let k = keys.iter().find(|k| k.active).ok_or_else(|| anyhow::anyhow!("no active signing key"))?;
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(k.kid.clone());
        Ok(jsonwebtoken::encode(&header, claims, &k.encoding)?)
    }

    /// Verifies a token we issued, for `audience`.
    pub fn verify<T: DeserializeOwned>(&self, token: &str, issuer: &str, audience: &str) -> Option<T> {
        let kid = jsonwebtoken::decode_header(token).ok()?.kid?;
        let keys = self.keys.read().expect("keys lock");
        let k = keys.iter().find(|k| k.kid == kid)?;
        let mut v = Validation::new(Algorithm::EdDSA);
        v.set_issuer(&[issuer]);
        v.set_audience(&[audience]);
        jsonwebtoken::decode::<T>(token, &k.decoding, &v).ok().map(|d| d.claims)
    }

    pub fn jwks(&self) -> Jwks {
        Jwks {
            keys: self
                .keys
                .read()
                .expect("keys lock")
                .iter()
                .map(|k| Jwk {
                    kty: "OKP".into(),
                    crv: "Ed25519".into(),
                    alg: "EdDSA".into(),
                    use_: "sig".into(),
                    kid: k.kid.clone(),
                    x: B64.encode(k.public),
                })
                .collect(),
        }
    }
}

/// A new key that starts signing `ahead` from now.
async fn insert_key(db: &PgPool, ahead: Duration) -> anyhow::Result<()> {
    let mut seed = [0u8; 32];
    rand::rng().fill_bytes(&mut seed);
    let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let kid = uuid::Uuid::now_v7().simple().to_string();
    sqlx::query("INSERT INTO signing_keys (kid, seed, public_key, activates_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))")
        .bind(&kid)
        .bind(&seed[..])
        .bind(&public[..])
        .bind(ahead.as_secs_f64())
        .execute(db)
        .await?;
    Ok(())
}

/// How long a new key is published before it signs, and an old one kept after it stops:
/// both well past the longest token lifetime (15 minutes) and instances' key refetch.
pub const OVERLAP: Duration = Duration::from_secs(3600);

/// One rotation step: start a new key when the signing one is `every` old (and none is
/// waiting), and retire keys that stopped signing more than `OVERLAP` ago. Returns whether
/// anything changed.
pub async fn rotate(db: &PgPool, every: Duration, overlap: Duration) -> anyhow::Result<bool> {
    let (due,): (bool,) = sqlx::query_as(
        "SELECT NOT EXISTS (SELECT 1 FROM signing_keys WHERE NOT retired AND (activates_at > now() OR activates_at > now() - make_interval(secs => $1)))",
    )
    .bind(every.as_secs_f64())
    .fetch_one(db)
    .await?;
    if due {
        insert_key(db, overlap).await?;
        tracing::info!("new signing key published; it signs in {}s", overlap.as_secs());
    }
    // Retired: older than the key that's been signing for at least `overlap`.
    let r = sqlx::query(
        "UPDATE signing_keys SET retired = true WHERE NOT retired AND activates_at <
           (SELECT max(activates_at) FROM signing_keys WHERE NOT retired AND activates_at <= now() - make_interval(secs => $1))",
    )
    .bind(overlap.as_secs_f64())
    .execute(db)
    .await?;
    if r.rows_affected() > 0 {
        tracing::info!("retired {} old signing key(s)", r.rows_affected());
    }
    Ok(due || r.rows_affected() > 0)
}

/// Runs rotation and keeps `keys` current (including pending keys turning active).
pub async fn rotate_loop(db: PgPool, keys: std::sync::Arc<Keys>) {
    let days: f64 = std::env::var("KEY_ROTATE_DAYS").ok().and_then(|v| v.parse().ok()).unwrap_or(90.0);
    let mut tick = tokio::time::interval(Duration::from_secs(300));
    loop {
        tick.tick().await;
        if days > 0.0
            && let Err(e) = rotate(&db, Duration::from_secs_f64(days * 86400.0), OVERLAP).await
        {
            tracing::warn!("rotating signing keys: {e:#}");
        }
        if let Err(e) = keys.reload(&db).await {
            tracing::warn!("reloading signing keys: {e:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize)]
    struct Claims {
        iss: String,
        aud: String,
        sub: String,
        exp: u64,
    }

    #[test]
    fn signs_and_verifies_through_the_published_jwk() {
        let mut seed = [0u8; 32];
        rand::rng().fill_bytes(&mut seed);
        let keys = Keys { keys: RwLock::new(vec![key("k1".into(), &seed, true).unwrap()]) };
        let exp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 60;
        let token = keys.sign(&Claims { iss: "https://id".into(), aud: "a".into(), sub: "u".into(), exp }).unwrap();

        let c: Claims = keys.verify(&token, "https://id", "a").unwrap();
        assert_eq!(c.sub, "u");
        assert!(keys.verify::<Claims>(&token, "https://id", "other").is_none(), "wrong audience");
        assert!(keys.verify::<Claims>(&token, "https://evil", "a").is_none(), "wrong issuer");

        // What an instance does: verify using only the JWKS.
        let jwk = &keys.jwks().keys[0];
        let dk = DecodingKey::from_ed_components(&jwk.x).unwrap();
        let mut v = Validation::new(Algorithm::EdDSA);
        v.set_audience(&["a"]);
        assert!(jsonwebtoken::decode::<Claims>(&token, &dk, &v).is_ok());

        let mut tampered = token.clone();
        tampered.pop();
        tampered.push(if token.ends_with('A') { 'B' } else { 'A' });
        assert!(keys.verify::<Claims>(&tampered, "https://id", "a").is_none(), "bad signature");
    }
}
