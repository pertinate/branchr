//! The gateway's self-signed certificate, and a connector that trusts exactly that one.

use std::path::Path;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, ring};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};

pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(ring::default_provider())
}

pub fn fingerprint(cert: &[u8]) -> String {
    Sha256::digest(cert).iter().map(|b| format!("{b:02x}")).collect()
}

/// Loads the gateway's certificate from `dir`, making one the first time.
pub fn load_or_create(dir: &Path) -> anyhow::Result<(CertificateDer<'static>, PrivateKeyDer<'static>)> {
    let (cert_path, key_path) = (dir.join("cert.der"), dir.join("key.der"));
    if !cert_path.exists() {
        std::fs::create_dir_all(dir)?;
        let made = rcgen::generate_simple_self_signed(vec![crate::proto::SERVER_NAME.to_string()])?;
        // Key first, then the certificate by rename: whoever renames first wins, and a reader
        // never sees a certificate without its key. A loser's pair is dropped.
        let tmp = format!("{}", std::process::id());
        let (key_tmp, cert_tmp) = (dir.join(format!("key.der.{tmp}")), dir.join(format!("cert.der.{tmp}")));
        std::fs::write(&key_tmp, made.signing_key.serialize_der())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&key_tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::write(&cert_tmp, made.cert.der())?;
        if std::fs::hard_link(&key_tmp, &key_path).is_ok() {
            std::fs::rename(&cert_tmp, &cert_path)?;
        } else {
            let _ = std::fs::remove_file(&cert_tmp);
        }
        let _ = std::fs::remove_file(&key_tmp);
        // Another process may still be between its key and certificate.
        for _ in 0..50 {
            if cert_path.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    let cert = CertificateDer::from(std::fs::read(&cert_path)?);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(std::fs::read(&key_path)?));
    Ok((cert, key))
}

/// Accepts only the certificate with this fingerprint (signatures still checked).
#[derive(Debug)]
pub struct Pinned {
    fp: String,
    provider: Arc<CryptoProvider>,
}

impl Pinned {
    pub fn new(fp: &str) -> Arc<Self> {
        Arc::new(Self { fp: fp.to_ascii_lowercase(), provider: provider() })
    }
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(&self, end: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        if fingerprint(end) == self.fp {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("relay certificate doesn't match the token's fingerprint".into()))
        }
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// Transport settings both ends use: keepalives well inside the idle timeout, room for media.
pub fn transport() -> Arc<quinn::TransportConfig> {
    let mut t = quinn::TransportConfig::default();
    t.keep_alive_interval(Some(std::time::Duration::from_secs(5)));
    t.max_idle_timeout(Some(std::time::Duration::from_secs(20).try_into().expect("idle timeout")));
    t.max_concurrent_bidi_streams(4096u32.into());
    t.datagram_receive_buffer_size(Some(8 << 20));
    t.datagram_send_buffer_size(8 << 20);
    Arc::new(t)
}
