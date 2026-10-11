//! Ed25519 signing keys for the JWTs branchr ID issues, published as a JWKS so instances
//! can verify tokens without calling back here.

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
    encoding: EncodingKey,
    decoding: DecodingKey,
    public: [u8; 32],
}

pub struct Keys {
    /// Newest first; the first one signs.
    keys: Vec<Key>,
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

fn key(kid: String, seed: &[u8]) -> anyhow::Result<Key> {
    let seed: [u8; 32] = seed.try_into().map_err(|_| anyhow::anyhow!("signing key {kid}: bad seed"))?;
    let sk = SigningKey::from_bytes(&seed);
    let der = sk.to_pkcs8_der().map_err(|e| anyhow::anyhow!("signing key {kid}: {e}"))?;
    let public = sk.verifying_key().to_bytes();
    Ok(Key { kid, encoding: EncodingKey::from_ed_der(der.as_bytes()), decoding: DecodingKey::from_ed_der(&public), public })
}

impl Keys {
    /// Loads the active keys, creating the first one on a fresh database.
    pub async fn load(db: &PgPool) -> anyhow::Result<Self> {
        let mut rows: Vec<(String, Vec<u8>)> =
            sqlx::query_as("SELECT kid, seed FROM signing_keys WHERE NOT retired ORDER BY created_at DESC").fetch_all(db).await?;
        if rows.is_empty() {
            let mut seed = [0u8; 32];
            rand::rng().fill_bytes(&mut seed);
            let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
            let kid = uuid::Uuid::now_v7().simple().to_string();
            sqlx::query("INSERT INTO signing_keys (kid, seed, public_key) VALUES ($1, $2, $3)")
                .bind(&kid)
                .bind(&seed[..])
                .bind(&public[..])
                .execute(db)
                .await?;
            // Another replica may have raced us; take whatever is newest.
            rows = sqlx::query_as("SELECT kid, seed FROM signing_keys WHERE NOT retired ORDER BY created_at DESC").fetch_all(db).await?;
        }
        let keys = rows.into_iter().map(|(kid, seed)| key(kid, &seed)).collect::<anyhow::Result<Vec<_>>>()?;
        Ok(Self { keys })
    }

    pub fn sign<T: Serialize>(&self, claims: &T) -> anyhow::Result<String> {
        let k = &self.keys[0];
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(k.kid.clone());
        Ok(jsonwebtoken::encode(&header, claims, &k.encoding)?)
    }

    /// Verifies a token we issued, for `audience`.
    pub fn verify<T: DeserializeOwned>(&self, token: &str, issuer: &str, audience: &str) -> Option<T> {
        let kid = jsonwebtoken::decode_header(token).ok()?.kid?;
        let k = self.keys.iter().find(|k| k.kid == kid)?;
        let mut v = Validation::new(Algorithm::EdDSA);
        v.set_issuer(&[issuer]);
        v.set_audience(&[audience]);
        jsonwebtoken::decode::<T>(token, &k.decoding, &v).ok().map(|d| d.claims)
    }

    pub fn jwks(&self) -> Jwks {
        Jwks {
            keys: self
                .keys
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
        let keys = Keys { keys: vec![key("k1".into(), &seed).unwrap()] };
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
