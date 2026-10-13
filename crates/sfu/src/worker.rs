//! Media workers. Each worker owns one UDP socket and a set of peers (assigned by load,
//! not by room), so a single big room is served by every core.
//!
//! Hot path for a published frame:
//!   publisher's worker: socket -> `Rtc::handle_input` -> `MediaData` -> build an
//!   `Arc<Frame>` once -> deliver to local subscribers + hand the same `Arc` to every other
//!   worker that has subscribers of the track.
//!   each worker: layer filter, timestamp rebase, `Writer::write` -> batched `sendmmsg`.
//!
//! A track has one or more quality *layers* identified by `(mid, rid)`, covering both RID
//! simulcast and grouped transceivers (one hardware encoder per layer).

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use proto::Id;
use proto::voice::{LayerPref, PublishTrack, TrackInfo, TrackSource, VoiceClaims, VoiceClientMsg, VoiceServerMsg};
use str0m::bwe::{Bitrate, BweKind};
use str0m::change::SdpOffer;
use str0m::format::{Codec, PayloadParams};
use str0m::media::{Direction, KeyframeRequestKind, MediaData, MediaKind, MediaTime, Mid, Rid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::shared::{LayerKey, Room, RoomPeer, Shared, Track};
use crate::udp::TxBatch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PeerId(pub u64);

/// A media frame from a publisher, shared by reference across workers.
pub struct Frame {
    track: Arc<str>,
    key: LayerKey,
    audio: bool,
    keyframe: bool,
    data: Arc<[u8]>,
    time: MediaTime,
    network_time: Instant,
    params: PayloadParams,
    audio_level: Option<(i8, bool)>,
    layer_name: Option<String>,
}

pub enum Cmd {
    Join { peer: PeerId, user: Id, room: Id, claims: VoiceClaims, out: mpsc::UnboundedSender<VoiceServerMsg> },
    Msg { peer: PeerId, msg: VoiceClientMsg },
    Leave { peer: PeerId },
    /// Another worker's publisher produced a frame we have subscribers for.
    Frame(Arc<Frame>),
    /// A subscriber on another worker needs a keyframe from our publisher.
    Keyframe { peer: PeerId, key: LayerKey, force: bool },
    /// A track went away; drop local subscriptions to it.
    TrackGone { track: Arc<str> },
    /// A track's layers changed; retarget local subscribers.
    TrackLayers { track: Arc<str> },
    /// Remove a peer (e.g. replaced by a newer connection of the same user).
    Kick { peer: PeerId, reason: String },
}

pub fn spawn(index: usize, config: &Config, shared: Arc<Shared>, rx: mpsc::UnboundedReceiver<Cmd>) -> anyhow::Result<()> {
    let port = config.udp_port + index as u16;
    // Advertising loopback (local runs): bind it too, so replies leave from the candidate's own
    // address. On 0.0.0.0 a peer probing from its LAN address would get answers sourced from that
    // address instead, which ICE ignores.
    let ip = if config.public_ip.is_loopback() { config.public_ip } else { [0, 0, 0, 0].into() };
    let bind = SocketAddr::new(ip, port);
    let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, Some(socket2::Protocol::UDP))?;
    // Big buffers absorb keyframe bursts of high bitrate streams.
    let _ = socket.set_recv_buffer_size(16 << 20);
    let _ = socket.set_send_buffer_size(16 << 20);
    socket.set_nonblocking(true)?;
    socket.bind(&bind.into())?;
    let std_socket: std::net::UdpSocket = socket.into();

    let public = SocketAddr::new(config.public_ip, config.public_udp_port + index as u16);
    let initial_bwe = config.initial_bwe_bps;
    std::thread::Builder::new().name(format!("sfu-worker-{index}")).spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("worker runtime");
        rt.block_on(async move {
            let socket = UdpSocket::from_std(std_socket).expect("tokio udp socket");
            Worker::new(index, shared, socket, public, initial_bwe).run(rx).await;
        });
    })?;
    Ok(())
}

const KEYFRAME_THROTTLE: Duration = Duration::from_millis(300);
const LAYER_TICK: Duration = Duration::from_millis(500);
const SPEAK_TICK: Duration = Duration::from_millis(100);
const SPEAK_HOLD: Duration = Duration::from_millis(350);
/// Silent mic audio stops being forwarded this long after the last loud packet (so the ends
/// of words aren't clipped).
const SILENCE_HANGOVER: Duration = Duration::from_millis(500);
/// While silent, one packet in this many still goes out, as Opus DTX would send.
const SILENT_KEEP_EVERY: u32 = 25;
/// RFC 6464 level is -dBov; anything louder than this counts as speech.
const SPEAK_DBOV: i32 = 50;
/// Upgrades need this much headroom to avoid flapping between layers.
const UPGRADE_HEADROOM: f64 = 1.25;
/// After backing off, wait this long before trying a better layer again.
const UPGRADE_COOLDOWN: Duration = Duration::from_secs(4);
/// How long ICE may stay Disconnected before the peer is dropped.
const ICE_GRACE: Duration = Duration::from_secs(15);
/// Don't re-boost the estimate more often than this (lets real congestion signals win).
const BWE_BOOST_INTERVAL: Duration = Duration::from_secs(10);
const MAX_BOOST_BPS: u64 = 200_000_000;
/// Flush queued packets once this many are pending, even mid-batch.
const TX_FLUSH_AT: usize = 512;

/// Layer names from highest to lowest quality; clients publish these names.
const LAYER_ORDER: [&str; 3] = ["h", "m", "l"];

fn layer_rank(n: &str) -> usize {
    LAYER_ORDER.iter().position(|o| *o == n).unwrap_or(LAYER_ORDER.len())
}

struct RateMeter {
    bytes: u64,
    window_start: Instant,
    bps: u64,
}

impl RateMeter {
    fn new(now: Instant) -> Self {
        Self { bytes: 0, window_start: now, bps: 0 }
    }

    /// Returns the new rate when a measurement window completes.
    fn add(&mut self, n: usize, now: Instant) -> Option<u64> {
        self.bytes += n as u64;
        let elapsed = now.duration_since(self.window_start);
        if elapsed < Duration::from_secs(1) {
            return None;
        }
        let sample = (self.bytes as f64 * 8.0 / elapsed.as_secs_f64()) as u64;
        // Light smoothing so a single keyframe doesn't dominate.
        self.bps = if self.bps == 0 { sample } else { (self.bps * 3 + sample) / 4 };
        self.bytes = 0;
        self.window_start = now;
        Some(self.bps)
    }
}

/// Publisher-side bookkeeping for a track owned by a local peer.
struct OwnTrack {
    shared: Arc<Track>,
    rates: HashMap<LayerKey, RateMeter>,
    last_keyframe_req: HashMap<LayerKey, Instant>,
}

struct Sub {
    track: Arc<Track>,
    pref: LayerPref,
    /// Layer currently forwarded.
    current: Option<LayerKey>,
    /// Layer we want; switched to on its next keyframe.
    target: Option<LayerKey>,
    /// Timestamp rebasing so source/layer switches look continuous to the receiver.
    ts_in: u64,
    ts_out: u64,
    last_out: Option<u64>,
    rebase: bool,
    last_downgrade: Option<Instant>,
}

struct Slot {
    kind: MediaKind,
    sub: Option<Sub>,
}

struct Peer {
    user: Id,
    room: Id,
    /// What the voice token lets them publish.
    claims: VoiceClaims,
    rtc: Rtc,
    out: mpsc::UnboundedSender<VoiceServerMsg>,
    /// Publish metadata from the latest offer, keyed by mid, consumed on `MediaAdded`.
    pending_publish: HashMap<String, PublishTrack>,
    tracks: HashMap<Arc<str>, OwnTrack>,
    mid_track: HashMap<Mid, Arc<str>>,
    slots: HashMap<Mid, Slot>,
    next_timeout: Instant,
    estimate_bps: u64,
    last_loud: Option<Instant>,
    /// Silent mic packets in a row (for silence suppression).
    silent_run: u32,
    speaking: bool,
    addrs: Vec<SocketAddr>,
    /// When ICE went Disconnected, if it hasn't recovered yet.
    ice_lost: Option<Instant>,
    /// Last time the bandwidth estimate was jump-started for a single-layer stream.
    bwe_boosted: Option<Instant>,
}

impl Peer {
    fn send(&self, msg: VoiceServerMsg) {
        let _ = self.out.send(msg);
    }
}

/// Where worker time goes; logged every few seconds when `SFU_PROFILE=1`.
#[derive(Default)]
struct Prof {
    enabled: bool,
    since: Option<Instant>,
    cpu_at_start: Duration,
    input: Duration,
    poll: Duration,
    write: Duration,
    send: Duration,
    loops: u64,
    packets_in: u64,
    packets_out: u64,
    drives: u64,
    writes: u64,
    frames_shipped: u64,
    /// Silent mic packets not forwarded.
    silent_dropped: u64,
}

/// CPU time consumed by the calling thread (user + system).
fn thread_cpu_time() -> Duration {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: valid out-pointer; CLOCK_THREAD_CPUTIME_ID is always supported on Linux.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

impl Prof {
    fn report(&mut self, worker: usize, peers: usize, dropped: u64) {
        let Some(since) = self.since else {
            self.since = Some(Instant::now());
            self.cpu_at_start = thread_cpu_time();
            return;
        };
        let wall = since.elapsed();
        if wall < Duration::from_secs(5) {
            return;
        }
        let pct = |d: Duration| d.as_secs_f64() / wall.as_secs_f64() * 100.0;
        let per_s = |n: u64| (n as f64 / wall.as_secs_f64()) as u64;
        tracing::info!(
            "profile w{worker} peers {peers}: cpu {:.1}% ({} loops/s) input {:.1}% poll {:.1}% write {:.1}% send {:.1}% | in {}/s out {}/s drives {}/s writes {}/s shipped {}/s silent-skipped {}/s dropped {}",
            pct(thread_cpu_time().saturating_sub(self.cpu_at_start)),
            per_s(self.loops),
            pct(self.input),
            pct(self.poll),
            pct(self.write),
            pct(self.send),
            per_s(self.packets_in),
            per_s(self.packets_out),
            per_s(self.drives),
            per_s(self.writes),
            per_s(self.frames_shipped),
            per_s(self.silent_dropped),
            dropped,
        );
        *self = Prof { enabled: true, since: Some(Instant::now()), cpu_at_start: thread_cpu_time(), ..Default::default() };
    }
}

macro_rules! timed {
    ($prof:expr, $field:ident, $e:expr) => {{
        if $prof.enabled {
            let t = Instant::now();
            let r = $e;
            $prof.$field += t.elapsed();
            r
        } else {
            $e
        }
    }};
}

struct Worker {
    index: usize,
    shared: Arc<Shared>,
    socket: UdpSocket,
    public: SocketAddr,
    initial_bwe: u64,
    peers: HashMap<PeerId, Peer>,
    addrs: HashMap<SocketAddr, PeerId>,
    /// Track -> local subscriber slots.
    fanout: HashMap<Arc<str>, Vec<(PeerId, Mid)>>,
    dirty: HashSet<PeerId>,
    buf: Vec<u8>,
    tx: TxBatch,
    prof: Prof,
}

impl Worker {
    fn new(index: usize, shared: Arc<Shared>, socket: UdpSocket, public: SocketAddr, initial_bwe: u64) -> Self {
        Self {
            index,
            shared,
            socket,
            public,
            initial_bwe,
            peers: HashMap::new(),
            addrs: HashMap::new(),
            fanout: HashMap::new(),
            dirty: HashSet::new(),
            buf: vec![0; 2000],
            tx: TxBatch::default(),
            prof: Prof { enabled: std::env::var("SFU_PROFILE").is_ok_and(|v| v == "1"), ..Default::default() },
        }
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Cmd>) {
        let mut layer_tick = tokio::time::interval(LAYER_TICK);
        let mut speak_tick = tokio::time::interval(SPEAK_TICK);
        loop {
            let deadline = self
                .peers
                .values()
                .map(|p| p.next_timeout)
                .min()
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(1));
            tokio::select! {
                biased;
                r = self.socket.readable() => {
                    if r.is_ok() {
                        self.read_batch();
                    }
                }
                cmd = rx.recv() => match cmd {
                    Some(cmd) => {
                        self.handle_cmd(cmd);
                        // Drain whatever else is queued (frames arrive in bursts).
                        for _ in 0..256 {
                            match rx.try_recv() {
                                Ok(cmd) => self.handle_cmd(cmd),
                                Err(_) => break,
                            }
                        }
                    }
                    None => return,
                },
                _ = tokio::time::sleep_until(deadline.into()) => {}
                _ = layer_tick.tick() => self.select_layers(),
                _ = speak_tick.tick() => self.update_speaking(),
            }
            self.drive_timeouts();
            self.drive_dirty();
            self.flush();
            if self.prof.enabled {
                self.prof.loops += 1;
                self.prof.report(self.index, self.peers.len(), self.tx.dropped);
            }
        }
    }

    fn flush(&mut self) {
        if self.tx.len() > 0 {
            let n = timed!(self.prof, send, self.tx.flush(&self.socket));
            self.prof.packets_out += n as u64;
        }
    }

    /// Drains the socket (bounded) so bursts are processed before polling outputs.
    fn read_batch(&mut self) {
        for _ in 0..256 {
            self.buf.resize(2000, 0);
            match self.socket.try_recv_from(&mut self.buf) {
                Ok((n, source)) => {
                    let now = Instant::now();
                    let Ok(contents) = self.buf[..n].try_into() else { continue };
                    let input = Input::Receive(now, Receive { proto: Protocol::Udp, source, destination: self.public, contents });
                    let peer_id = match self.addrs.get(&source) {
                        Some(p) => Some(*p),
                        // First contact (or address change): only STUN can introduce a new address.
                        None => self.peers.iter().find(|(_, p)| p.rtc.accepts(&input)).map(|(id, _)| *id),
                    };
                    let Some(peer_id) = peer_id else { continue };
                    let Some(peer) = self.peers.get_mut(&peer_id) else { continue };
                    if !self.addrs.contains_key(&source) {
                        self.addrs.insert(source, peer_id);
                        peer.addrs.push(source);
                    }
                    self.prof.packets_in += 1;
                    if let Err(e) = timed!(self.prof, input, peer.rtc.handle_input(input)) {
                        tracing::debug!(peer = peer_id.0, "input error: {e:?}");
                    }
                    self.dirty.insert(peer_id);
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) => {
                    // ICMP port unreachable etc. surface here on some platforms; ignore.
                    tracing::trace!("udp recv error: {e}");
                    break;
                }
            }
        }
    }

    fn drive_timeouts(&mut self) {
        let now = Instant::now();
        for (id, p) in self.peers.iter_mut() {
            if p.next_timeout <= now {
                let _ = p.rtc.handle_input(Input::Timeout(now));
                self.dirty.insert(*id);
            }
        }
    }

    fn drive_dirty(&mut self) {
        // Forwarding marks subscribers dirty, so loop until quiescent.
        while !self.dirty.is_empty() {
            let batch: Vec<PeerId> = self.dirty.drain().collect();
            for id in batch {
                self.drive(id);
            }
            if self.tx.len() >= TX_FLUSH_AT {
                self.flush();
            }
        }
    }

    /// Polls a peer until it yields a timeout, queueing packets and handling events.
    fn drive(&mut self, id: PeerId) {
        let mut events = Vec::new();
        {
            let Some(peer) = self.peers.get_mut(&id) else { return };
            self.prof.drives += 1;
            let _ = timed!(self.prof, poll, peer.rtc.handle_input(Input::Timeout(Instant::now())));
            let mut spins = 0;
            loop {
                if !peer.rtc.is_alive() {
                    break;
                }
                match timed!(self.prof, poll, peer.rtc.poll_output()) {
                    Ok(Output::Timeout(t)) => {
                        // The pacer asks for an immediate timeout after every packet. Going
                        // back to the (1 ms resolution) event loop would cap each viewer at
                        // one packet per millisecond (~10 Mbps), so service it inline.
                        let now = Instant::now();
                        if t <= now && spins < 4096 {
                            spins += 1;
                            let _ = timed!(self.prof, poll, peer.rtc.handle_input(Input::Timeout(now)));
                            continue;
                        }
                        peer.next_timeout = t;
                        break;
                    }
                    Ok(Output::Transmit(t)) => self.tx.push(t.destination, t.contents.into()),
                    Ok(Output::Event(e)) => events.push(e),
                    Err(e) => {
                        tracing::debug!(peer = id.0, "rtc error: {e:?}");
                        peer.rtc.disconnect();
                        break;
                    }
                }
            }
            if !peer.rtc.is_alive() {
                peer.send(VoiceServerMsg::Error { message: "media connection lost".into() });
                self.remove_peer(id);
                return;
            }
        }
        for e in events {
            self.handle_event(id, e);
        }
    }

    fn handle_event(&mut self, id: PeerId, e: Event) {
        match e {
            Event::IceConnectionStateChange(s) => {
                tracing::info!(peer = id.0, "ice {s:?}");
                // Disconnected is transient by design (e.g. consent checks delayed behind a
                // burst of stream upload); only give up if it doesn't recover.
                if let Some(p) = self.peers.get_mut(&id) {
                    if s == IceConnectionState::Disconnected {
                        p.ice_lost.get_or_insert(Instant::now());
                    } else if s.is_connected() {
                        p.ice_lost = None;
                    }
                }
            }
            Event::Connected => {
                // Subscriptions made before DTLS completed need a fresh keyframe.
                let reqs: Vec<_> = self
                    .peers
                    .get(&id)
                    .map(|p| p.slots.values().filter_map(|s| s.sub.as_ref().and_then(|s| Some((s.track.clone(), s.target?)))).collect())
                    .unwrap_or_default();
                for (track, key) in reqs {
                    self.request_keyframe(&track, key, true);
                }
            }
            Event::MediaAdded(m) => {
                let rids = m.simulcast.map(|s| s.recv.into_iter().map(|l| l.rid).collect()).unwrap_or_default();
                self.media_added(id, m.mid, m.kind, m.direction, rids);
            }
            Event::MediaChanged(m) => {
                let receiving = matches!(m.direction, Direction::RecvOnly | Direction::SendRecv);
                let published = self.peers.get(&id).is_some_and(|p| p.mid_track.contains_key(&m.mid));
                if published && !receiving {
                    self.unpublish_mid(id, m.mid);
                }
            }
            Event::MediaData(d) => self.media_data(id, d),
            Event::KeyframeRequest(req) => {
                let Some(sub) = self.peers.get(&id).and_then(|p| p.slots.get(&req.mid)).and_then(|s| s.sub.as_ref()) else {
                    return;
                };
                if let Some(key) = sub.current.or(sub.target) {
                    let track = sub.track.clone();
                    self.request_keyframe(&track, key, req.kind == KeyframeRequestKind::Fir);
                }
            }
            Event::EgressBitrateEstimate(BweKind::Twcc { estimate, .. }) => {
                if let Some(p) = self.peers.get_mut(&id) {
                    p.estimate_bps = estimate.as_u64();
                }
            }
            _ => {}
        }
    }

    fn handle_cmd(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Join { peer, user, room, claims, out } => self.join(peer, user, room, claims, out),
            Cmd::Leave { peer } => self.remove_peer(peer),
            Cmd::Kick { peer, reason } => {
                if let Some(p) = self.peers.get(&peer) {
                    p.send(VoiceServerMsg::Error { message: reason });
                }
                self.remove_peer(peer);
            }
            Cmd::Frame(f) => self.deliver(&f),
            Cmd::Keyframe { peer, key, force } => self.local_keyframe(peer, key, force),
            Cmd::TrackGone { track } => self.drop_track_subs(&track),
            Cmd::TrackLayers { track } => self.retarget(&track),
            Cmd::Msg { peer, msg } => {
                if !self.peers.contains_key(&peer) {
                    return;
                }
                match msg {
                    VoiceClientMsg::Offer { sdp, publish } => self.offer(peer, sdp, publish),
                    VoiceClientMsg::Subscribe { mid, track_id } => self.subscribe(peer, Mid::from(mid.as_str()), &track_id),
                    VoiceClientMsg::Unsubscribe { mid } => self.unsubscribe(peer, Mid::from(mid.as_str())),
                    VoiceClientMsg::SetLayer { mid, layer } => {
                        if let Some(sub) = self
                            .peers
                            .get_mut(&peer)
                            .and_then(|p| p.slots.get_mut(&Mid::from(mid.as_str())))
                            .and_then(|s| s.sub.as_mut())
                        {
                            sub.pref = layer;
                            sub.last_downgrade = None;
                        }
                        self.select_layers_for(peer);
                    }
                    VoiceClientMsg::Unpublish { mid } => self.unpublish_mid(peer, Mid::from(mid.as_str())),
                    VoiceClientMsg::Join { .. } | VoiceClientMsg::Ping => {}
                }
                self.dirty.insert(peer);
            }
        }
    }

    fn join(&mut self, id: PeerId, user: Id, room_id: Id, claims: VoiceClaims, out: mpsc::UnboundedSender<VoiceServerMsg>) {
        let mut rtc = Rtc::builder()
            .set_ice_lite(true)
            .enable_bwe(Some(Bitrate::bps(self.initial_bwe)))
            // Deep resend buffer: high bitrate streams need NACK coverage for ~1s.
            .set_send_buffer_video(8000)
            .set_reordering_size_video(60)
            .build(Instant::now());
        match Candidate::host(self.public, "udp") {
            Ok(c) => {
                rtc.add_local_candidate(c);
            }
            Err(e) => tracing::error!("bad candidate {}: {e:?}", self.public),
        }

        let (tracks, dups) = {
            let mut rooms = self.shared.rooms.lock();
            let room = rooms.entry(room_id).or_insert_with(Room::default);
            // One connection per user per room: a new one replaces the old (e.g. reconnect).
            let dups: Vec<(PeerId, usize)> = room.peers.iter().filter(|(_, p)| p.user == user).map(|(id, p)| (*id, p.worker)).collect();
            let tracks: Vec<TrackInfo> = room.tracks.values().filter(|t| !dups.iter().any(|d| d.0 == t.owner)).map(|t| t.info()).collect();
            room.peers.insert(id, RoomPeer { user, worker: self.index, out: out.clone() });
            (tracks, dups)
        };
        for (dup, worker) in dups {
            self.shared.send(worker, Cmd::Kick { peer: dup, reason: "replaced by a newer connection".into() });
        }
        let _ = out.send(VoiceServerMsg::Joined { peer_id: id.0.to_string(), tracks });
        self.shared.load[self.index].fetch_add(1, Ordering::Relaxed);
        self.peers.insert(
            id,
            Peer {
                user,
                room: room_id,
                claims,
                rtc,
                out,
                pending_publish: HashMap::new(),
                tracks: HashMap::new(),
                mid_track: HashMap::new(),
                slots: HashMap::new(),
                next_timeout: Instant::now(),
                estimate_bps: self.initial_bwe,
                last_loud: None,
                silent_run: 0,
                speaking: false,
                addrs: Vec::new(),
                ice_lost: None,
                bwe_boosted: None,
            },
        );
        tracing::info!(peer = id.0, user = %user, room = %room_id, worker = self.index, "peer joined");
    }

    fn remove_peer(&mut self, id: PeerId) {
        let Some(peer) = self.peers.get(&id) else { return };
        let mids: Vec<Mid> = peer.mid_track.keys().copied().collect();
        let slots: Vec<Mid> = peer.slots.keys().copied().collect();
        let (room_id, speaking, user) = (peer.room, peer.speaking, peer.user);
        for m in mids {
            self.unpublish_mid(id, m);
        }
        for s in slots {
            self.unsubscribe(id, s);
        }
        if speaking {
            self.shared.broadcast(room_id, Some(id), VoiceServerMsg::Speaking { user_id: user, speaking: false });
        }
        let Some(peer) = self.peers.remove(&id) else { return };
        for a in peer.addrs {
            self.addrs.remove(&a);
        }
        {
            let mut rooms = self.shared.rooms.lock();
            if let Some(room) = rooms.get_mut(&room_id) {
                room.peers.remove(&id);
                if room.peers.is_empty() {
                    rooms.remove(&room_id);
                }
            }
        }
        self.shared.load[self.index].fetch_sub(1, Ordering::Relaxed);
        self.dirty.remove(&id);
        tracing::info!(peer = id.0, "peer left");
    }

    fn offer(&mut self, id: PeerId, sdp: String, publish: Vec<PublishTrack>) {
        let Some(peer) = self.peers.get_mut(&id) else { return };
        for p in publish {
            peer.pending_publish.insert(p.mid.clone(), p);
        }
        let offer = match SdpOffer::from_sdp_string(&sdp) {
            Ok(o) => o,
            Err(e) => {
                peer.send(VoiceServerMsg::Error { message: format!("bad offer: {e}") });
                return;
            }
        };
        match peer.rtc.sdp_api().accept_offer(offer) {
            Ok(answer) => {
                peer.send(VoiceServerMsg::Answer { sdp: answer.to_sdp_string() });
                self.drive(id);
            }
            Err(e) => peer.send(VoiceServerMsg::Error { message: format!("offer rejected: {e}") }),
        }
    }

    fn other_workers(&self, cmd: impl Fn() -> Cmd) {
        for w in 0..self.shared.workers.len() {
            if w != self.index {
                self.shared.send(w, cmd());
            }
        }
    }

    fn media_added(&mut self, id: PeerId, mid: Mid, kind: MediaKind, dir: Direction, rids: Vec<Rid>) {
        let Some(peer) = self.peers.get_mut(&id) else { return };
        match dir {
            // The client sends on this m-line: a published track (or a layer of one).
            Direction::RecvOnly | Direction::SendRecv => {
                let meta = peer.pending_publish.remove(&mid.to_string());
                let source = meta.as_ref().map(|m| m.source).unwrap_or(match kind {
                    MediaKind::Audio => TrackSource::Mic,
                    MediaKind::Video => TrackSource::Camera,
                });
                // Not allowed to send this: it's never forwarded (its packets find no track).
                if !peer.claims.may_publish(source) {
                    tracing::info!(peer = id.0, ?source, "refused a track the voice token doesn't allow");
                    peer.send(VoiceServerMsg::Error { message: format!("you don't have permission to send {}", match source {
                        TrackSource::Mic => "audio here",
                        TrackSource::Camera => "video here",
                        _ => "your screen here",
                    }) });
                    return;
                }
                let group = meta.as_ref().and_then(|m| m.group.clone());
                let track_id: Arc<str> = match &group {
                    Some(g) => format!("{}-g{}", id.0, g),
                    None => format!("{}-{}", id.0, mid),
                }
                .into();
                let new_layers: Vec<(LayerKey, String)> = if rids.is_empty() {
                    let name = meta.and_then(|m| m.layer).unwrap_or_else(|| "h".into());
                    vec![((mid, None), name)]
                } else {
                    rids.iter().map(|r| ((mid, Some(*r)), r.to_string())).collect()
                };
                let existed = peer.tracks.contains_key(&track_id);
                let workers = self.shared.workers.len();
                let (index, user) = (self.index, peer.user);
                let own = peer.tracks.entry(track_id.clone()).or_insert_with(|| OwnTrack {
                    shared: Arc::new(Track {
                        id: track_id.clone(),
                        owner: id,
                        owner_worker: index,
                        user,
                        kind,
                        source,
                        layers: Default::default(),
                        rates: Default::default(),
                        sub_workers: (0..workers).map(|_| Default::default()).collect(),
                    }),
                    rates: HashMap::new(),
                    last_keyframe_req: HashMap::new(),
                });
                {
                    let mut layers = own.shared.layers.lock();
                    layers.extend(new_layers);
                    layers.sort_by_key(|l| layer_rank(&l.1));
                }
                let track = own.shared.clone();
                let room = peer.room;
                peer.mid_track.insert(mid, track_id.clone());
                if existed {
                    self.retarget(&track_id);
                    self.other_workers(|| Cmd::TrackLayers { track: track_id.clone() });
                } else {
                    self.shared.rooms.lock().entry(room).or_default().tracks.insert(track_id.clone(), track.clone());
                }
                let info = track.info();
                tracing::info!(peer = id.0, track = %track_id, %mid, source = ?info.source, layers = ?info.layers, "published");
                self.shared.broadcast(room, Some(id), VoiceServerMsg::TrackAdded { track: info });
            }
            // The client receives on this m-line: a subscription slot.
            Direction::SendOnly => {
                peer.slots.entry(mid).or_insert(Slot { kind, sub: None });
            }
            Direction::Inactive => {}
        }
    }

    fn unpublish_mid(&mut self, id: PeerId, mid: Mid) {
        let Some(peer) = self.peers.get_mut(&id) else { return };
        let Some(track_id) = peer.mid_track.remove(&mid) else { return };
        let Some(own) = peer.tracks.get_mut(&track_id) else { return };
        own.rates.retain(|k, _| k.0 != mid);
        let empty = {
            let mut layers = own.shared.layers.lock();
            layers.retain(|l| l.0.0 != mid);
            own.shared.rates.lock().retain(|k, _| k.0 != mid);
            layers.is_empty()
        };
        let track = own.shared.clone();
        let room = peer.room;
        if empty {
            peer.tracks.remove(&track_id);
            if let Some(r) = self.shared.rooms.lock().get_mut(&room) {
                r.tracks.remove(&track_id);
            }
            self.drop_track_subs(&track_id);
            self.other_workers(|| Cmd::TrackGone { track: track_id.clone() });
            tracing::info!(peer = id.0, track = %track_id, "unpublished");
            self.shared.broadcast(room, Some(id), VoiceServerMsg::TrackRemoved { track_id: track_id.to_string() });
        } else {
            self.retarget(&track_id);
            self.other_workers(|| Cmd::TrackLayers { track: track_id.clone() });
            self.shared.broadcast(room, Some(id), VoiceServerMsg::TrackAdded { track: track.info() });
        }
    }

    fn drop_track_subs(&mut self, track_id: &Arc<str>) {
        let Some(subs) = self.fanout.remove(track_id) else { return };
        for (sp, smid) in subs {
            if let Some(slot) = self.peers.get_mut(&sp).and_then(|p| p.slots.get_mut(&smid))
                && slot.sub.as_ref().is_some_and(|s| &s.track.id == track_id)
            {
                if let Some(sub) = slot.sub.take() {
                    sub.track.sub_workers[self.index].fetch_sub(1, Ordering::Relaxed);
                }
            }
        }
    }

    /// Moves local subscribers off layers that no longer exist.
    fn retarget(&mut self, track_id: &Arc<str>) {
        let Some(subs) = self.fanout.get(track_id) else { return };
        for &(sp, smid) in subs {
            let Some(sub) = self.peers.get_mut(&sp).and_then(|p| p.slots.get_mut(&smid)).and_then(|s| s.sub.as_mut()) else { continue };
            let layers = sub.track.layers.lock();
            let exists = |k: Option<LayerKey>| k.is_some_and(|k| layers.iter().any(|l| l.0 == k));
            let (current_ok, target_ok) = (exists(sub.current), exists(sub.target));
            let first = layers.first().map(|l| l.0);
            drop(layers);
            if !current_ok {
                sub.current = None;
            }
            if !target_ok {
                sub.target = first;
            }
        }
    }

    fn subscribe(&mut self, id: PeerId, mid: Mid, track_id: &str) {
        let Some(peer) = self.peers.get(&id) else { return };
        let track = self.shared.rooms.lock().get(&peer.room).and_then(|r| r.tracks.get(track_id).cloned());
        let Some(track) = track else {
            peer.send(VoiceServerMsg::Error { message: format!("no track {track_id}") });
            return;
        };
        if track.owner == id {
            return;
        }
        let target = {
            let layers = track.layers.lock();
            // Start mid-quality and let the allocator move from there.
            layers.get(layers.len() / 2).or(layers.first()).map(|l| l.0)
        };

        self.unsubscribe(id, mid);
        let peer = self.peers.get_mut(&id).expect("checked");
        // str0m only emits MediaAdded once DTLS is up; a subscribe can arrive before that.
        if !peer.slots.contains_key(&mid)
            && let Some(m) = peer.rtc.media(mid)
            && m.direction() == Direction::SendOnly
        {
            peer.slots.insert(mid, Slot { kind: m.kind(), sub: None });
        }
        let Some(slot) = peer.slots.get_mut(&mid) else {
            peer.send(VoiceServerMsg::Error { message: format!("no slot {mid}") });
            return;
        };
        if slot.kind != track.kind {
            peer.send(VoiceServerMsg::Error { message: "slot kind mismatch".into() });
            return;
        }
        let audio = track.kind == MediaKind::Audio;
        slot.sub = Some(Sub {
            track: track.clone(),
            pref: LayerPref::Auto,
            // Audio has no keyframes: forward immediately.
            current: if audio { target } else { None },
            target,
            ts_in: 0,
            ts_out: 0,
            last_out: None,
            rebase: true,
            last_downgrade: None,
        });
        self.fanout.entry(track.id.clone()).or_default().push((id, mid));
        track.sub_workers[self.index].fetch_add(1, Ordering::Relaxed);
        if !audio {
            if let Some(t) = target {
                self.request_keyframe(&track, t, true);
            }
            self.select_layers_for(id);
        }
    }

    fn unsubscribe(&mut self, id: PeerId, mid: Mid) {
        let Some(sub) = self.peers.get_mut(&id).and_then(|p| p.slots.get_mut(&mid)).and_then(|s| s.sub.take()) else {
            return;
        };
        sub.track.sub_workers[self.index].fetch_sub(1, Ordering::Relaxed);
        if let Some(v) = self.fanout.get_mut(&sub.track.id) {
            v.retain(|s| *s != (id, mid));
            if v.is_empty() {
                self.fanout.remove(&sub.track.id);
            }
        }
    }

    /// Routes a keyframe request to the publisher's worker.
    fn request_keyframe(&mut self, track: &Track, key: LayerKey, force: bool) {
        if track.kind != MediaKind::Video {
            return;
        }
        if track.owner_worker == self.index {
            self.local_keyframe(track.owner, key, force);
        } else {
            self.shared.send(track.owner_worker, Cmd::Keyframe { peer: track.owner, key, force });
        }
    }

    fn local_keyframe(&mut self, pid: PeerId, key: LayerKey, force: bool) {
        let Some(peer) = self.peers.get_mut(&pid) else { return };
        let Some(own) = peer.mid_track.get(&key.0).and_then(|t| peer.tracks.get_mut(t)) else { return };
        let now = Instant::now();
        if !force && own.last_keyframe_req.get(&key).is_some_and(|t| now.duration_since(*t) < KEYFRAME_THROTTLE) {
            return;
        }
        own.last_keyframe_req.insert(key, now);
        if let Some(mut w) = peer.rtc.writer(key.0) {
            let _ = w.request_keyframe(key.1, KeyframeRequestKind::Pli);
            self.dirty.insert(pid);
        }
    }

    /// A local publisher produced a frame: build it once, deliver locally, ship to other workers.
    fn media_data(&mut self, id: PeerId, d: MediaData) {
        let now = Instant::now();
        let key: LayerKey = (d.mid, d.rid);
        let Some(peer) = self.peers.get_mut(&id) else { return };
        let Some(own) = peer.mid_track.get(&d.mid).and_then(|t| peer.tracks.get_mut(t)) else { return };
        if let Some(bps) = own.rates.entry(key).or_insert_with(|| RateMeter::new(now)).add(d.data.len(), now) {
            own.shared.rates.lock().insert(key, bps);
        }
        let track = own.shared.clone();
        let audio = track.kind == MediaKind::Audio;

        if track.source == TrackSource::Mic
            && let Some(level) = d.ext_vals.audio_level
        {
            if (level as i32).abs() < SPEAK_DBOV {
                peer.last_loud = Some(now);
                peer.silent_run = 0;
            } else if peer.last_loud.is_none_or(|t| now.duration_since(t) > SILENCE_HANGOVER) {
                // Silence suppression: browsers send 50 packets/s of silence; in a big call
                // that's most of the SFU's work, and nobody hears it.
                peer.silent_run = peer.silent_run.wrapping_add(1);
                if peer.silent_run % SILENT_KEEP_EVERY != 1 {
                    self.prof.silent_dropped += 1;
                    return;
                }
            }
        }
        if !d.contiguous && !audio {
            self.local_keyframe(id, key, false);
        }

        let keyframe = d.is_keyframe();
        // One fixup per frame, shared by every subscriber on every worker.
        let data = match (keyframe, d.params.spec().codec) {
            (true, Codec::H264) => match crate::h264::reorder_parameter_sets(&d.data) {
                Some(fixed) => Arc::<[u8]>::from(fixed),
                None => d.data.clone(),
            },
            _ => d.data.clone(),
        };
        let frame = Arc::new(Frame {
            track: track.id.clone(),
            key,
            audio,
            keyframe,
            data,
            time: d.time,
            network_time: d.network_time,
            params: d.params,
            audio_level: d.ext_vals.audio_level.map(|l| (l, d.ext_vals.voice_activity.unwrap_or(false))),
            layer_name: track.layer_name(key),
        });
        for w in 0..self.shared.workers.len() {
            if w != self.index && track.has_subscribers_on(w) {
                self.prof.frames_shipped += 1;
                self.shared.send(w, Cmd::Frame(frame.clone()));
            }
        }
        if track.has_subscribers_on(self.index) {
            self.deliver(&frame);
        }
    }

    /// Forwards a frame to this worker's subscribers of its track.
    fn deliver(&mut self, f: &Frame) {
        let Some(subs) = self.fanout.get(&f.track) else { return };
        let mut switched = Vec::new();
        for &(sp, smid) in subs {
            let Some(sp_peer) = self.peers.get_mut(&sp) else { continue };
            let Some(sub) = sp_peer.slots.get_mut(&smid).and_then(|s| s.sub.as_mut()) else { continue };

            // Switch layers only on a keyframe of the target so the decoder never breaks.
            if sub.target == Some(f.key) && sub.current != Some(f.key) && (f.keyframe || f.audio) {
                sub.current = Some(f.key);
                sub.rebase = true;
                if f.layer_name.is_some() {
                    switched.push((sp, smid));
                }
            }
            if sub.current != Some(f.key) {
                continue;
            }

            let t = f.time.numer();
            if sub.rebase {
                // Continue one frame after whatever was last sent on this slot.
                let step = if f.time.frequency().get() == 90_000 { 3000 } else { 960 };
                sub.ts_in = t;
                sub.ts_out = sub.last_out.map(|l| l + step).unwrap_or(t);
                sub.rebase = false;
            }
            let out_t = sub.ts_out.wrapping_add(t.wrapping_sub(sub.ts_in));
            sub.last_out = Some(out_t);
            let out_time = MediaTime::new(out_t, f.time.frequency());

            let Some(writer) = sp_peer.rtc.writer(smid) else { continue };
            let Some(pt) = writer.match_params(f.params) else { continue };
            let writer = match f.audio_level {
                Some((level, vad)) => writer.audio_level(level, vad),
                None => writer,
            };
            self.prof.writes += 1;
            if let Err(e) = timed!(self.prof, write, writer.write(pt, f.network_time, out_time, f.data.clone())) {
                tracing::debug!(peer = sp.0, "write failed: {e:?}");
            }
            self.dirty.insert(sp);
        }
        for (sp, smid) in switched {
            if let Some(p) = self.peers.get(&sp) {
                p.send(VoiceServerMsg::Layer { mid: smid.to_string(), layer: f.layer_name.clone(), estimate_bps: p.estimate_bps });
            }
        }
    }

    fn select_layers(&mut self) {
        let dead: Vec<PeerId> = self
            .peers
            .iter()
            .filter(|(_, p)| p.ice_lost.is_some_and(|t| t.elapsed() > ICE_GRACE))
            .map(|(id, _)| *id)
            .collect();
        for id in dead {
            tracing::warn!(peer = id.0, "ice did not recover, dropping peer");
            if let Some(p) = self.peers.get(&id) {
                p.send(VoiceServerMsg::Error { message: "media connection lost".into() });
            }
            self.remove_peer(id);
        }
        let ids: Vec<PeerId> = self.peers.keys().copied().collect();
        for id in ids {
            self.select_layers_for(id);
        }
    }

    /// Greedy per-subscriber allocation of the downlink estimate across layered tracks.
    /// Screen shares get first claim on bandwidth, then cameras.
    fn select_layers_for(&mut self, id: PeerId) {
        let Some(peer) = self.peers.get(&id) else { return };
        struct Want {
            slot: Mid,
            track: Arc<Track>,
            layers: Vec<(LayerKey, u64)>,
            pref: LayerPref,
            priority: u8,
            target: Option<LayerKey>,
            last_downgrade: Option<Instant>,
        }
        let mut audio_bps = 0u64;
        let mut fixed_bps = 0u64;
        let mut desired = 0u64;
        let mut wants = Vec::new();
        for (slot, s) in &peer.slots {
            let Some(sub) = &s.sub else { continue };
            let layers: Vec<(LayerKey, u64)> = {
                let rates = sub.track.rates.lock();
                sub.track.layers.lock().iter().map(|l| (l.0, rates.get(&l.0).copied().unwrap_or(0))).collect()
            };
            if sub.track.kind == MediaKind::Audio {
                audio_bps += layers.first().map(|l| l.1).unwrap_or(0).max(40_000);
                continue;
            }
            if layers.len() < 2 {
                fixed_bps += layers.first().map(|l| l.1).unwrap_or(0);
                continue;
            }
            desired += layers.first().map(|l| l.1).unwrap_or(0);
            wants.push(Want {
                slot: *slot,
                track: sub.track.clone(),
                layers,
                pref: sub.pref,
                priority: if sub.track.source == TrackSource::Screen { 0 } else { 1 },
                target: sub.target,
                last_downgrade: sub.last_downgrade,
            });
        }
        let mut budget = (peer.estimate_bps as f64 * 0.9) as i64 - (audio_bps + fixed_bps) as i64;
        wants.sort_by_key(|w| w.priority);

        let now = Instant::now();
        let mut changes = Vec::new();
        for w in &wants {
            let idx_of = |k: Option<LayerKey>| k.and_then(|k| w.layers.iter().position(|l| l.0 == k));
            let pick = match w.pref {
                LayerPref::High => w.layers.first().map(|l| l.0),
                LayerPref::Medium => w.layers.get(w.layers.len() / 2).map(|l| l.0),
                LayerPref::Low => w.layers.last().map(|l| l.0),
                // Every layer flows continuously from the publisher, so this lasts ~1s.
                LayerPref::Auto if w.layers.iter().any(|l| l.1 == 0) => w.target,
                LayerPref::Auto => {
                    let current = idx_of(w.target);
                    let cooling = w.last_downgrade.is_some_and(|t| now.duration_since(t) < UPGRADE_COOLDOWN);
                    let mut choice = w.layers.last().map(|l| l.0);
                    for (i, (key, bps)) in w.layers.iter().enumerate() {
                        let upgrade = current.is_some_and(|c| i < c);
                        if upgrade && cooling {
                            continue;
                        }
                        let need = if upgrade { (*bps as f64 * UPGRADE_HEADROOM) as i64 } else { *bps as i64 };
                        if need <= budget {
                            choice = Some(*key);
                            break;
                        }
                    }
                    choice
                }
            };
            if let Some(k) = pick {
                budget -= w.layers.iter().find(|l| l.0 == k).map(|l| l.1 as i64).unwrap_or(0);
            }
            if pick != w.target {
                let downgrade = w.pref == LayerPref::Auto && idx_of(pick) > idx_of(w.target);
                changes.push((w.slot, w.track.clone(), pick, downgrade));
            }
        }

        let peer = self.peers.get_mut(&id).expect("checked");
        // A single-layer stream can't be downgraded, so a slowly ramping estimate only queues
        // it in the pacer (seconds of delay over real links). Start the estimate at what the
        // stream needs; real congestion still pulls it down.
        let must_carry = (fixed_bps + audio_bps) as f64 * 1.2;
        if fixed_bps > 0
            && (peer.estimate_bps as f64) < must_carry
            && peer.bwe_boosted.is_none_or(|t| now.duration_since(t) > BWE_BOOST_INTERVAL)
        {
            let target = (must_carry as u64).min(MAX_BOOST_BPS);
            peer.rtc.bwe().reset(Bitrate::bps(target));
            peer.estimate_bps = target;
            peer.bwe_boosted = Some(now);
            tracing::debug!(peer = id.0, target, "bwe boosted for single-layer stream");
        }
        // Ask the BWE to probe for what full quality would need.
        peer.rtc.bwe().set_desired_bitrate(Bitrate::bps(((desired + audio_bps + fixed_bps) as f64 * 1.1) as u64));
        let mut kf = Vec::new();
        for (slot, track, pick, downgrade) in changes {
            if let Some(sub) = peer.slots.get_mut(&slot).and_then(|s| s.sub.as_mut()) {
                if downgrade {
                    sub.last_downgrade = Some(now);
                }
                sub.target = pick;
                if let Some(k) = pick {
                    kf.push((track, k));
                }
            }
        }
        for (track, key) in kf {
            self.request_keyframe(&track, key, false);
        }
    }

    fn update_speaking(&mut self) {
        let now = Instant::now();
        let mut changes = Vec::new();
        for p in self.peers.values_mut() {
            let speaking = p.last_loud.is_some_and(|t| now.duration_since(t) < SPEAK_HOLD);
            if speaking != p.speaking {
                p.speaking = speaking;
                changes.push((p.room, p.user, speaking));
            }
        }
        for (room, user, speaking) in changes {
            // Include the speaker so their own UI can show the indicator.
            self.shared.broadcast(room, None, VoiceServerMsg::Speaking { user_id: user, speaking });
        }
    }
}
