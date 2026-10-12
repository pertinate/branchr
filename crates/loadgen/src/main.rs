//! SFU load generator: one synthetic publisher and N receive-only viewers in one process.
//!
//! Frames carry their send time, so viewers measure true end-to-end latency through the
//! relay. Nothing is decoded, so a single machine can drive hundreds of viewers.
//!
//!   loadgen --sfu ws://host:8741/ws --secret $VOICE_SECRET --viewers 100 --mbps 4 --fps 60 --seconds 60

use std::net::{IpAddr, UdpSocket as StdUdp};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::{SinkExt, StreamExt};
use proto::Id;
use proto::voice::{PublishTrack, TrackSource, VoiceClaims, VoiceClientMsg, VoiceServerMsg};
use rand::RngCore;
use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, MediaKind, MediaTime};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

struct Args {
    sfu: String,
    secret: String,
    viewers: usize,
    mbps: f64,
    fps: u32,
    seconds: u64,
    room: i64,
}

fn args() -> Args {
    let mut a = Args { sfu: "ws://127.0.0.1:8090/ws".into(), secret: "dev-voice-secret".into(), viewers: 10, mbps: 4.0, fps: 60, seconds: 30, room: 0 };
    let v: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < v.len() {
        let val = v[i + 1].clone();
        match v[i].as_str() {
            "--sfu" => a.sfu = val,
            "--secret" => a.secret = val,
            "--viewers" => a.viewers = val.parse().expect("viewers"),
            "--mbps" => a.mbps = val.parse().expect("mbps"),
            "--fps" => a.fps = val.parse().expect("fps"),
            "--seconds" => a.seconds = val.parse().expect("seconds"),
            "--room" => a.room = val.parse().expect("room"),
            other => panic!("unknown arg {other}"),
        }
        i += 2;
    }
    if a.room == 0 {
        a.room = (now_unix() as i64) << 22;
    }
    a
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

#[derive(Default)]
struct Stats {
    frames: AtomicU64,
    bytes: AtomicU64,
    gaps: AtomicU64,
    connected: AtomicU64,
    /// Latency samples in microseconds (reset each report).
    latency: Mutex<Vec<u32>>,
    per_viewer_frames: Mutex<Vec<u64>>,
}

/// Local address the OS would use to reach `remote` (no packets sent).
fn local_ip_for(remote: &str) -> IpAddr {
    let host = remote.trim_start_matches("ws://").trim_start_matches("wss://").split('/').next().unwrap();
    let host = host.split(':').next().unwrap();
    let s = StdUdp::bind("0.0.0.0:0").unwrap();
    s.connect((host, 9)).unwrap();
    s.local_addr().unwrap().ip()
}

enum Role {
    Publisher { mbps: f64, fps: u32 },
    Viewer { index: usize },
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    // ring and aws-lc are both linked; pick aws-lc (same as str0m) for wss:// signaling.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let a = args();
    let stats = Arc::new(Stats::default());
    stats.per_viewer_frames.lock().unwrap().resize(a.viewers, 0);
    let epoch = Instant::now();
    println!("room {} | {} viewers | {:.1} Mbps @ {} fps | {}s", a.room, a.viewers, a.mbps, a.fps, a.seconds);

    let token = |user: i64| {
        proto::voice::token::sign(
            a.secret.as_bytes(),
            &VoiceClaims { user_id: Id(user), guild_id: Id(1), channel_id: Id(a.room), exp: now_unix() + 3600, deny_speak: false, deny_video: false, deny_stream: false },
        )
    };

    let local_ip = local_ip_for(&a.sfu);
    tokio::spawn(peer(a.sfu.clone(), token(1), local_ip, Role::Publisher { mbps: a.mbps, fps: a.fps }, stats.clone(), epoch));
    tokio::time::sleep(Duration::from_secs(2)).await;
    for i in 0..a.viewers {
        tokio::spawn(peer(a.sfu.clone(), token(1000 + i as i64), local_ip, Role::Viewer { index: i }, stats.clone(), epoch));
        // Stagger joins a little like real users.
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let start = Instant::now();
    let mut last = Instant::now();
    let mut totals = Vec::new();
    while start.elapsed() < Duration::from_secs(a.seconds) {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let dt = last.elapsed().as_secs_f64();
        last = Instant::now();
        let frames = stats.frames.swap(0, Ordering::Relaxed);
        let bytes = stats.bytes.swap(0, Ordering::Relaxed);
        let gaps = stats.gaps.swap(0, Ordering::Relaxed);
        let mut lat = std::mem::take(&mut *stats.latency.lock().unwrap());
        lat.sort_unstable();
        let q = |p: f64| lat.get(((lat.len() as f64 * p) as usize).min(lat.len().saturating_sub(1))).map(|v| *v as f64 / 1000.0).unwrap_or(f64::NAN);
        let per: Vec<u64> = std::mem::replace(&mut *stats.per_viewer_frames.lock().unwrap(), vec![0; a.viewers]);
        let min_fps = per.iter().copied().min().unwrap_or(0) as f64 / dt;
        let connected = stats.connected.load(Ordering::Relaxed);
        let avg_fps = frames as f64 / dt / a.viewers.max(1) as f64;
        println!(
            "t={:>3}s viewers {}/{} | fps avg {:.1} min {:.1} | egress {:.0} Mbps | latency p50 {:.1}ms p99 {:.1}ms max {:.1}ms | gaps {}",
            start.elapsed().as_secs(),
            connected.saturating_sub(1),
            a.viewers,
            avg_fps,
            min_fps,
            bytes as f64 * 8.0 / dt / 1e6,
            q(0.5),
            q(0.99),
            q(1.0),
            gaps
        );
        if start.elapsed() > Duration::from_secs(10) {
            totals.push((avg_fps, min_fps, q(0.99)));
        }
    }
    if !totals.is_empty() {
        let worst_min = totals.iter().map(|t| t.1).fold(f64::INFINITY, f64::min);
        let avg = totals.iter().map(|t| t.0).sum::<f64>() / totals.len() as f64;
        let worst_p99 = totals.iter().map(|t| t.2).fold(0.0, f64::max);
        println!("SUMMARY viewers={} avg_fps={:.1} worst_viewer_fps={:.1} worst_p99_ms={:.1}", a.viewers, avg, worst_min, worst_p99);
    }
    std::process::exit(0);
}

async fn peer(sfu: String, token: String, local_ip: IpAddr, role: Role, stats: Arc<Stats>, epoch: Instant) {
    if let Err(e) = run_peer(sfu, token, local_ip, &role, stats, epoch).await {
        eprintln!("peer error: {e:#}");
    }
}

async fn run_peer(sfu: String, token: String, local_ip: IpAddr, role: &Role, stats: Arc<Stats>, epoch: Instant) -> anyhow::Result<()> {
    let (ws, _) = tokio_tungstenite::connect_async(&sfu).await?;
    let (mut ws_tx, mut ws_rx) = ws.split();
    let send = |m: &VoiceClientMsg| Message::Text(serde_json::to_string(m).unwrap().into());
    ws_tx.send(send(&VoiceClientMsg::Join { token })).await?;

    let socket = UdpSocket::bind((local_ip, 0)).await?;
    let local = socket.local_addr()?;
    let mut rtc = Rtc::builder().set_send_buffer_video(4000).build(Instant::now());
    rtc.add_local_candidate(Candidate::host(local, "udp")?);

    let mut api = rtc.sdp_api();
    let mid = match role {
        Role::Publisher { .. } => api.add_media(MediaKind::Video, Direction::SendOnly, Some("load".into()), None, None),
        Role::Viewer { .. } => api.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None),
    };
    let (offer, pending) = api.apply().expect("offer");
    let mut pending: Option<SdpPendingOffer> = Some(pending);
    let publish = match role {
        Role::Publisher { .. } => vec![PublishTrack { mid: mid.to_string(), source: TrackSource::Screen, group: None, layer: None }],
        Role::Viewer { .. } => vec![],
    };
    ws_tx.send(send(&VoiceClientMsg::Offer { sdp: offer.to_sdp_string(), publish })).await?;

    // Signaling messages are forwarded to the media loop.
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

    let mut buf = vec![0u8; 2000];
    let mut connected = false;
    let mut subscribed = false;
    let (frame_bytes, frame_interval) = match role {
        Role::Publisher { mbps, fps } => ((mbps * 1e6 / 8.0 / *fps as f64) as usize, Duration::from_secs_f64(1.0 / *fps as f64)),
        Role::Viewer { .. } => (0, Duration::from_secs(3600)),
    };
    let mut noise = vec![0u8; frame_bytes.max(64)];
    rand::rng().fill_bytes(&mut noise);
    let mut next_frame = Instant::now();
    let mut frame_no: u64 = 0;
    let mut want_keyframe = true;
    let mut last_keyframe = Instant::now();
    let mut last_seq_frame: Option<u64> = None;

    loop {
        // Drain outputs.
        let timeout = loop {
            match rtc.poll_output()? {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    let _ = socket.try_send_to(&t.contents, t.destination);
                }
                Output::Event(e) => match e {
                    Event::Connected => {
                        connected = true;
                        stats.connected.fetch_add(1, Ordering::Relaxed);
                    }
                    Event::KeyframeRequest(_) => want_keyframe = true,
                    Event::MediaData(d) => {
                        if let Role::Viewer { index } = role {
                            stats.frames.fetch_add(1, Ordering::Relaxed);
                            stats.bytes.fetch_add(d.data.len() as u64, Ordering::Relaxed);
                            stats.per_viewer_frames.lock().unwrap()[*index] += 1;
                            if !d.contiguous {
                                stats.gaps.fetch_add(1, Ordering::Relaxed);
                            }
                            if d.data.len() >= 26 {
                                let sent = u64::from_le_bytes(d.data[10..18].try_into().unwrap());
                                let n = u64::from_le_bytes(d.data[18..26].try_into().unwrap());
                                let now = epoch.elapsed().as_micros() as u64;
                                stats.latency.lock().unwrap().push(now.saturating_sub(sent) as u32);
                                if let Some(prev) = last_seq_frame
                                    && n > prev + 1
                                {
                                    stats.gaps.fetch_add(1, Ordering::Relaxed);
                                }
                                last_seq_frame = Some(n);
                            }
                        }
                    }
                    _ => {}
                },
            }
        };

        // Publisher: emit frames on schedule.
        if let Role::Publisher { .. } = role
            && connected
            && Instant::now() >= next_frame
        {
            next_frame += frame_interval;
            if Instant::now() > next_frame + frame_interval * 5 {
                next_frame = Instant::now() + frame_interval; // fell behind; don't burst
            }
            let key = want_keyframe || last_keyframe.elapsed() > Duration::from_secs(2);
            if key {
                want_keyframe = false;
                last_keyframe = Instant::now();
            }
            let size = if key { frame_bytes * 4 } else { frame_bytes }.max(64);
            let mut frame = Vec::with_capacity(size);
            // VP8 frame tag (+ keyframe start code and 1920x1080), then send time + frame number.
            if key {
                frame.extend_from_slice(&[0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38, 0x04]);
            } else {
                frame.extend_from_slice(&[0x11, 0x02, 0x00, 0, 0, 0, 0, 0, 0, 0]);
            }
            frame.extend_from_slice(&(epoch.elapsed().as_micros() as u64).to_le_bytes());
            frame.extend_from_slice(&frame_no.to_le_bytes());
            while frame.len() < size {
                let take = (size - frame.len()).min(noise.len());
                frame.extend_from_slice(&noise[..take]);
            }
            frame_no += 1;
            let pt = rtc.writer(mid).and_then(|w| w.payload_params().find(|p| p.spec().codec == Codec::Vp8).map(|p| p.pt()));
            if let (Some(pt), Some(w)) = (pt, rtc.writer(mid)) {
                let rtp_time = MediaTime::from_90khz(frame_no * (90_000 / 60));
                let _ = w.write(pt, Instant::now(), rtp_time, frame);
            }
            continue;
        }

        let wake = if matches!(role, Role::Publisher { .. }) && connected { timeout.min(next_frame) } else { timeout };
        tokio::select! {
            r = socket.recv_from(&mut buf) => {
                let (n, source) = r?;
                if let Ok(contents) = buf[..n].try_into() {
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
                    VoiceServerMsg::Joined { tracks, .. } => {
                        if let Some(t) = tracks.iter().find(|t| t.source == TrackSource::Screen) && !subscribed {
                            subscribed = true;
                            let _ = out_tx.send(VoiceClientMsg::Subscribe { mid: mid.to_string(), track_id: t.id.clone() });
                        }
                    }
                    VoiceServerMsg::TrackAdded { track } if track.source == TrackSource::Screen && !subscribed => {
                        subscribed = true;
                        let _ = out_tx.send(VoiceClientMsg::Subscribe { mid: mid.to_string(), track_id: track.id });
                    }
                    VoiceServerMsg::Error { message } => eprintln!("sfu error: {message}"),
                    _ => {}
                }
            }
            _ = tokio::time::sleep_until(wake.into()) => {}
        }
        rtc.handle_input(Input::Timeout(Instant::now()))?;
    }
}
