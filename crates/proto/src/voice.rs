//! Voice/video signaling protocol (client <-> SFU over WebSocket, JSON text frames).
//!
//! The client is always the SDP offerer, so there is never glare. Receiving is done
//! through recvonly transceivers ("slots") that the client pre-allocates; a slot is
//! pointed at a published track with `Subscribe`, which needs no renegotiation.

use serde::{Deserialize, Serialize};

use crate::Id;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum VoiceClientMsg {
    Join {
        token: String,
    },
    /// SDP offer. `publish` describes sendonly m-lines that appear for the first time.
    Offer {
        sdp: String,
        publish: Vec<PublishTrack>,
    },
    Subscribe {
        mid: String,
        #[serde(rename = "trackId")]
        track_id: String,
    },
    Unsubscribe {
        mid: String,
    },
    /// Preferred simulcast layer for a subscribed slot.
    SetLayer {
        mid: String,
        layer: LayerPref,
    },
    /// Stop publishing a track (the client also stops the transceiver).
    Unpublish {
        mid: String,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum VoiceServerMsg {
    Joined {
        #[serde(rename = "peerId")]
        peer_id: String,
        tracks: Vec<TrackInfo>,
    },
    Answer {
        sdp: String,
    },
    /// A track was published, or an existing track's layers changed (upsert by id).
    TrackAdded {
        track: TrackInfo,
    },
    TrackRemoved {
        #[serde(rename = "trackId")]
        track_id: String,
    },
    /// Voice activity changed for a user (derived from the RFC 6464 audio level extension).
    Speaking {
        #[serde(rename = "userId")]
        user_id: Id,
        speaking: bool,
    },
    /// The simulcast layer actually forwarded to a slot changed.
    Layer {
        mid: String,
        layer: Option<String>,
        /// Estimated downlink bandwidth for this peer in bits/s.
        #[serde(rename = "estimateBps")]
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        estimate_bps: u64,
    },
    Pong,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct PublishTrack {
    pub mid: String,
    pub source: TrackSource,
    /// m-lines sharing a group form one logical track whose layers are separately encoded
    /// transceivers. This keeps each layer on its own (hardware) encoder, which RID
    /// simulcast can't do in Chromium.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub group: Option<String>,
    /// Layer name within the group: "h", "m" or "l".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub layer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct TrackInfo {
    pub id: String,
    pub user_id: Id,
    pub kind: MediaKind,
    pub source: TrackSource,
    /// Quality layers available, best first (empty when there's only one).
    pub layers: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum TrackSource {
    Mic,
    Camera,
    Screen,
    ScreenAudio,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum MediaKind {
    Audio,
    Video,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub enum LayerPref {
    /// Pick the best layer that fits the estimated bandwidth.
    #[default]
    Auto,
    High,
    Medium,
    Low,
}

/// Claims carried in the voice token the API issues and the SFU verifies.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VoiceClaims {
    pub user_id: Id,
    pub guild_id: Id,
    pub channel_id: Id,
    /// Unix seconds.
    pub exp: u64,
}

#[cfg(feature = "token")]
pub mod token {
    //! `base64url(json claims) "." base64url(hmac_sha256(secret, json claims))`
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    use super::VoiceClaims;

    fn mac(secret: &[u8], data: &[u8]) -> Vec<u8> {
        let mut m = Hmac::<Sha256>::new_from_slice(secret).expect("hmac accepts any key size");
        m.update(data);
        m.finalize().into_bytes().to_vec()
    }

    pub fn sign(secret: &[u8], claims: &VoiceClaims) -> String {
        let body = serde_json::to_vec(claims).expect("claims serialize");
        format!("{}.{}", B64.encode(&body), B64.encode(mac(secret, &body)))
    }

    pub fn verify(secret: &[u8], token: &str, now_unix: u64) -> Option<VoiceClaims> {
        let (body, sig) = token.split_once('.')?;
        let body = B64.decode(body).ok()?;
        let sig = B64.decode(sig).ok()?;
        let mut m = Hmac::<Sha256>::new_from_slice(secret).ok()?;
        m.update(&body);
        m.verify_slice(&sig).ok()?;
        let claims: VoiceClaims = serde_json::from_slice(&body).ok()?;
        (claims.exp > now_unix).then_some(claims)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::Id;

        #[test]
        fn roundtrip() {
            let c = VoiceClaims { user_id: Id(1), guild_id: Id(2), channel_id: Id(3), exp: 100 };
            let t = sign(b"secret", &c);
            assert_eq!(verify(b"secret", &t, 50), Some(c.clone()));
            assert_eq!(verify(b"other", &t, 50), None);
            assert_eq!(verify(b"secret", &t, 150), None);
        }
    }
}
