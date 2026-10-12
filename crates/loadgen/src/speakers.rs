//! A big voice call: N peers each publish an audio track (Opus-sized packets, 50/s, carrying
//! their send time) and subscribe to everyone else's. Reports delivered packets against
//! what's expected, and end-to-end latency through the SFU.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use std::sync::Mutex;
use proto::Id;
use proto::voice::{PublishTrack, TrackSource, VoiceClaims, VoiceClientMsg, VoiceServerMsg};
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, Frequency, MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::{Args, local_ip_for, now_unix};

const PACKET: Duration = Duration::from_millis(20);
const PAYLOAD: usize = 80; // ~32 kbps, a typical Opus voice frame

#[derive(Default)]
struct Stats {
    received: AtomicU64,
    /// Packets from talking speakers (these must all arrive).
    received_talking: AtomicU64,
    connected: AtomicU64,
    /// Streams fully subscribed (a peer hearing another).
    subscribed: AtomicU64,
    latency: Mutex<Vec<u32>>,
}

pub async fn run(a: &Args) -> anyhow::Result<()> {
    let n = a.speakers;
    let talking = a.talking.unwrap_or(n).min(n);
    println!("room {} | {n} speakers ({talking} talking) | {} streams | {}s", a.room, n * (n - 1), a.seconds);
    let stats = Arc::new(Stats::default());
    let epoch = Instant::now();
    let local_ip = local_ip_for(&a.sfu);
    for i in 0..n {
        let token = proto::voice::token::sign(
            a.secret.as_bytes(),
            &VoiceClaims { user_id: Id(2000 + i as i64), guild_id: Id(1), channel_id: Id(a.room), exp: now_unix() + 3600, deny_speak: false, deny_video: false, deny_stream: false },
        );
        let (sfu, stats) = (a.sfu.clone(), stats.clone());
        let loud = i < talking;
        tokio::spawn(async move {
            if let Err(e) = speaker(sfu, token, local_ip, n, loud, stats, epoch).await {
                eprintln!("speaker {i}: {e:#}");
            }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let start = Instant::now();
    let mut last = Instant::now();
    let mut steady = Vec::new();
    while start.elapsed() < Duration::from_secs(a.seconds) {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let dt = last.elapsed().as_secs_f64();
        last = Instant::now();
        let got = stats.received.swap(0, Ordering::Relaxed) as f64;
        // Every packet from a talker must reach the other n-1 people.
        let got_talking = stats.received_talking.swap(0, Ordering::Relaxed) as f64;
        let expected = (talking * (n - 1)) as f64 * (1.0 / PACKET.as_secs_f64()) * dt;
        let mut lat = std::mem::take(&mut *stats.latency.lock().unwrap());
        lat.sort_unstable();
        let q = |p: f64| lat.get(((lat.len() as f64 * p) as usize).min(lat.len().saturating_sub(1))).map(|v| *v as f64 / 1000.0).unwrap_or(f64::NAN);
        println!(
            "t={:>3}s connected {}/{n} streams {}/{} | speech delivered {:.1}% | received {:.0} pkt/s | latency p50 {:.1}ms p99 {:.1}ms",
            start.elapsed().as_secs(),
            stats.connected.load(Ordering::Relaxed),
            stats.subscribed.load(Ordering::Relaxed),
            n * (n - 1),
            got_talking / expected * 100.0,
            got / dt,
            q(0.5),
            q(0.99)
        );
        if start.elapsed() > Duration::from_secs(10) {
            steady.push((got_talking / expected * 100.0, q(0.5), q(0.99)));
        }
    }
    if !steady.is_empty() {
        let worst = steady.iter().map(|s| s.0).fold(f64::INFINITY, f64::min);
        let p99 = steady.iter().map(|s| s.2).fold(0.0, f64::max);
        let p50 = steady.iter().map(|s| s.1).sum::<f64>() / steady.len() as f64;
        println!("SUMMARY speakers={n} talking={talking} streams={} worst_speech_delivered={worst:.1}% p50_ms={p50:.1} worst_p99_ms={p99:.1}", n * (n - 1));
    }
    std::process::exit(0);
}

async fn speaker(sfu: String, token: String, local_ip: IpAddr, n: usize, loud: bool, stats: Arc<Stats>, epoch: Instant) -> anyhow::Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(&sfu).await?;
    let (mut ws_tx, mut ws_rx) = ws.split();
    let to_text = |m: &VoiceClientMsg| Message::Text(serde_json::to_string(m).unwrap().into());
    ws_tx.send(to_text(&VoiceClientMsg::Join { token })).await?;

    let socket = UdpSocket::bind((local_ip, 0)).await?;
    let local = socket.local_addr()?;
    let mut rtc = Rtc::builder().build(Instant::now());
    rtc.add_local_candidate(Candidate::host(local, "udp")?);
    let mut api = rtc.sdp_api();
    let send_mid = api.add_media(MediaKind::Audio, Direction::SendOnly, Some("mic".into()), None, None);
    // A receive slot for everyone else.
    let mut free: Vec<Mid> = (1..n).map(|_| api.add_media(MediaKind::Audio, Direction::RecvOnly, None, None, None)).collect();
    let (offer, pending) = api.apply().expect("offer");
    let mut pending: Option<SdpPendingOffer> = Some(pending);
    let publish = vec![PublishTrack { mid: send_mid.to_string(), source: TrackSource::Mic, group: None, layer: None }];
    ws_tx.send(to_text(&VoiceClientMsg::Offer { sdp: offer.to_sdp_string(), publish })).await?;

    let (sig_tx, mut sig_rx) = mpsc::unbounded_channel::<VoiceServerMsg>();
    tokio::spawn(async move {
        while let Some(Ok(m)) = ws_rx.next().await {
            if let Message::Text(t) = m
                && let Ok(msg) = serde_json::from_str::<VoiceServerMsg>(&t)
            {
                let _ = sig_tx.send(msg);
            }
        }
    });
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<VoiceClientMsg>();
    tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if ws_tx.send(Message::Text(serde_json::to_string(&m).unwrap().into())).await.is_err() {
                break;
            }
        }
    });

    let mut my_peer: Option<String> = None;
    let mut taken: HashMap<String, Mid> = HashMap::new();
    let mut subscribe = |track: &proto::voice::TrackInfo, my_peer: &Option<String>, free: &mut Vec<Mid>| {
        // Our own track's id starts with our peer id.
        let mine = my_peer.as_ref().is_some_and(|p| track.id.starts_with(&format!("{p}-")));
        if track.source != TrackSource::Mic || mine || taken.contains_key(&track.id) {
            return;
        }
        if let Some(mid) = free.pop() {
            taken.insert(track.id.clone(), mid);
            stats.subscribed.fetch_add(1, Ordering::Relaxed);
            let _ = out_tx.send(VoiceClientMsg::Subscribe { mid: mid.to_string(), track_id: track.id.clone() });
        }
    };

    let mut buf = vec![0u8; 2000];
    let mut connected = false;
    let mut next = Instant::now();
    let mut seq: u64 = 0;
    loop {
        let timeout = loop {
            match rtc.poll_output()? {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    let _ = socket.try_send_to(&t.contents, t.destination);
                }
                Output::Event(Event::Connected) => {
                    connected = true;
                    stats.connected.fetch_add(1, Ordering::Relaxed);
                }
                Output::Event(Event::MediaData(d)) if d.data.len() >= 9 => {
                    stats.received.fetch_add(1, Ordering::Relaxed);
                    if d.data[8] == 1 {
                        stats.received_talking.fetch_add(1, Ordering::Relaxed);
                    }
                    let sent = u64::from_le_bytes(d.data[..8].try_into().unwrap());
                    let now = epoch.elapsed().as_micros() as u64;
                    let mut lat = stats.latency.lock().unwrap();
                    // A sample of latencies is plenty.
                    if lat.len() < 200_000 {
                        lat.push(now.saturating_sub(sent) as u32);
                    }
                }
                Output::Event(_) => {}
            }
        };
        if connected && Instant::now() >= next {
            next += PACKET;
            if Instant::now() > next + PACKET * 5 {
                next = Instant::now() + PACKET;
            }
            let mut payload = vec![0u8; PAYLOAD];
            payload[..8].copy_from_slice(&(epoch.elapsed().as_micros() as u64).to_le_bytes());
            payload[8] = loud as u8;
            seq += 1;
            let pt = rtc.writer(send_mid).and_then(|w| w.payload_params().find(|p| p.spec().codec == Codec::Opus).map(|p| p.pt()));
            if let (Some(pt), Some(w)) = (pt, rtc.writer(send_mid)) {
                // The audio level a browser puts on each packet: speech, or silence.
                let w = if loud { w.audio_level(-20, true) } else { w.audio_level(-127, false) };
                let _ = w.write(pt, Instant::now(), MediaTime::new(seq * 960, Frequency::FORTY_EIGHT_KHZ), payload);
            }
            continue;
        }
        let wake = if connected { timeout.min(next) } else { timeout };
        tokio::select! {
            r = socket.recv_from(&mut buf) => {
                let (len, source) = r?;
                if let Ok(contents) = buf[..len].try_into() {
                    rtc.handle_input(Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: local, contents }))?;
                }
            }
            msg = sig_rx.recv() => {
                let Some(msg) = msg else { anyhow::bail!("signaling closed") };
                match msg {
                    VoiceServerMsg::Answer { sdp } => {
                        if let Some(p) = pending.take() {
                            rtc.sdp_api().accept_answer(p, SdpAnswer::from_sdp_string(&sdp)?)?;
                        }
                    }
                    VoiceServerMsg::Joined { peer_id, tracks } => {
                        my_peer = Some(peer_id);
                        for t in &tracks {
                            subscribe(t, &my_peer, &mut free);
                        }
                    }
                    VoiceServerMsg::TrackAdded { track } => subscribe(&track, &my_peer, &mut free),
                    VoiceServerMsg::Error { message } => eprintln!("sfu error: {message}"),
                    _ => {}
                }
            }
            _ = tokio::time::sleep_until(wake.into()) => {}
        }
        rtc.handle_input(Input::Timeout(Instant::now()))?;
    }
}
