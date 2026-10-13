//! How the internet sees a hub: `/ip` and `/probe`. Needs `TEST_DATABASE_URL`; skipped without it.

mod common;

use common::*;

#[tokio::test]
async fn ip_echo_and_udp_probe() {
    let Some(h) = Harness::new().await else { return };
    let ip = h.http.get(format!("{}/ip", h.base)).send().await.unwrap().text().await.unwrap();
    assert_eq!(ip, "127.0.0.1");

    // A stand-in voice server that answers probes, and a port nobody listens on.
    let sfu = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let open = sfu.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut buf = [0u8; 64];
        while let Ok((n, from)) = sfu.recv_from(&mut buf).await {
            if buf[..n].starts_with(b"BRANCHR-PROBE") {
                let _ = sfu.send_to(&buf[..n], from).await;
            }
        }
    });
    let closed = { tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port() };
    let r: serde_json::Value = h.http.post(format!("{}/probe", h.base)).json(&serde_json::json!({ "ports": [open, closed] })).send().await.unwrap().json().await.unwrap();
    assert_eq!(r["ip"], "127.0.0.1");
    assert_eq!(r["reachable"], serde_json::json!([open]));

    let r = h.http.post(format!("{}/probe", h.base)).json(&serde_json::json!({ "ports": (2000..2020).collect::<Vec<u16>>() })).send().await.unwrap();
    assert_eq!(r.status(), reqwest::StatusCode::BAD_REQUEST, "too many ports");
    h.finish().await;
}
