//! A worker owns one UDP socket and every room hashed onto it. All media forwarding for a
//! room happens on a single thread without locks.
//!
//! Hot path per incoming packet:
//!   socket -> addr lookup (O(1)) -> `Rtc::handle_input` -> `MediaData` events ->
//!   for each subscriber: layer filter, timestamp rebase, `Writer::write` (Arc clone).
//!
//! A published *track* is a logical stream with one or more quality *layers*. A layer is
//! identified by `(mid, rid)`, which covers both RID simulcast (one m-line, several rids)
//! and grouped transceivers (several m-lines, each its own encoder, e.g. one hardware
//! encoder session per layer).

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use proto::Id;
use proto::voice::{LayerPref, MediaKind as WireKind, PublishTrack, TrackInfo, TrackSource, VoiceClientMsg, VoiceServerMsg};
use std::sync::Arc;

use str0m::bwe::{Bitrate, BweKind};
use str0m::format::Codec;
use str0m::change::SdpOffer;
use str0m::media::{Direction, KeyframeRequestKind, MediaData, MediaKind, MediaTime, Mid, Rid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

use crate::config::Config;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PeerId(pub u64);

pub enum Cmd {
    Join { peer: PeerId, user: Id, room: Id, out: mpsc::UnboundedSender<VoiceServerMsg> },
    Msg { peer: PeerId, msg: VoiceClientMsg },
    Leave { peer: PeerId },
}

#[derive(Clone)]
pub struct WorkerHandle(mpsc::UnboundedSender<Cmd>);

impl WorkerHandle {
    pub fn send(&self, cmd: Cmd) {
        let _ = self.0.send(cmd);
    }
}

pub fn spawn(index: usize, config: &Config) -> anyhow::Result<WorkerHandle> {
    let port = config.udp_port + index as u16;
    let bind: SocketAddr = ([0, 0, 0, 0], port).into();
    let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, Some(socket2::Protocol::UDP))?;
    // Big buffers absorb keyframe bursts of high bitrate streams.
    let _ = socket.set_recv_buffer_size(16 << 20);
    let _ = socket.set_send_buffer_size(16 << 20);
    socket.set_nonblocking(true)?;
    socket.bind(&bind.into())?;
    let std_socket: std::net::UdpSocket = socket.into();

    let (tx, rx) = mpsc::unbounded_channel();
    let public = SocketAddr::new(config.public_ip, port);
    let initial_bwe = config.initial_bwe_bps;
    std::thread::Builder::new().name(format!("sfu-worker-{index}")).spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("worker runtime");
        rt.block_on(async move {
            let socket = UdpSocket::from_std(std_socket).expect("tokio udp socket");
            Worker::new(socket, public, initial_bwe).run(rx).await;
        });
    })?;
    Ok(WorkerHandle(tx))
}

const KEYFRAME_THROTTLE: Duration = Duration::from_millis(300);
const LAYER_TICK: Duration = Duration::from_millis(500);
const SPEAK_TICK: Duration = Duration::from_millis(100);
const SPEAK_HOLD: Duration = Duration::from_millis(350);
/// RFC 6464 level is -dBov; anything louder than this counts as speech.
const SPEAK_DBOV: i32 = 50;
/// Upgrades need this much headroom to avoid flapping between layers.
const UPGRADE_HEADROOM: f64 = 1.25;
/// After backing off, wait this long before trying a better layer again.
const UPGRADE_COOLDOWN: Duration = Duration::from_secs(4);
/// How long ICE may stay Disconnected before the peer is dropped.
const ICE_GRACE: Duration = Duration::from_secs(15);

/// Layer names from highest to lowest quality; clients publish these names.
const LAYER_ORDER: [&str; 3] = ["h", "m", "l"];

type LayerKey = (Mid, Option<Rid>);

/// Where worker time goes; logged every few seconds when `SFU_PROFILE=1`.
#[derive(Default)]
struct Prof {
    enabled: bool,
    since: Option<Instant>,
    input: Duration,
    poll: Duration,
    write: Duration,
    send: Duration,
    events: Duration,
    cpu_at_start: Duration,
    loops: u64,
    packets_in: u64,
    packets_out: u64,
    drives: u64,
    writes: u64,
}

impl Prof {
    fn report(&mut self) {
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
        tracing::info!(
            "profile {:.0}s: cpu {:.1}% ({} loops/s) input {:.1}% poll {:.1}% write {:.1}% send {:.1}% events {:.1}% | in {}/s out {}/s drives {}/s writes {}/s",
            wall.as_secs_f64(),
            pct(thread_cpu_time().saturating_sub(self.cpu_at_start)),
            self.loops / wall.as_secs(),
            pct(self.input),
            pct(self.poll),
            pct(self.write),
            pct(self.send),
            pct(self.events),
            self.packets_in / wall.as_secs(),
            self.packets_out / wall.as_secs(),
            self.drives / wall.as_secs(),
            self.writes / wall.as_secs(),
        );
        *self = Prof { enabled: true, since: Some(Instant::now()), cpu_at_start: thread_cpu_time(), ..Default::default() };
    }
}

/// CPU time consumed by the calling thread (user + system).
fn thread_cpu_time() -> Duration {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: valid out-pointer; CLOCK_THREAD_CPUTIME_ID is always supported on Linux.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
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

struct RateMeter {
    bytes: u64,
    window_start: Instant,
    bps: u64,
}

impl RateMeter {
    fn new(now: Instant) -> Self {
        Self { bytes: 0, window_start: now, bps: 0 }
    }

    fn add(&mut self, n: usize, now: Instant) {
        self.bytes += n as u64;
        let elapsed = now.duration_since(self.window_start);
        if elapsed >= Duration::from_secs(1) {
            let sample = (self.bytes as f64 * 8.0 / elapsed.as_secs_f64()) as u64;
            // Light smoothing so a single keyframe doesn't dominate.
            self.bps = if self.bps == 0 { sample } else { (self.bps * 3 + sample) / 4 };
            self.bytes = 0;
            self.window_start = now;
        }
    }
}

struct Layer {
    name: String,
    key: LayerKey,
}

struct Track {
    id: String,
    kind: MediaKind,
    source: TrackSource,
    /// Best quality first.
    layers: Vec<Layer>,
    rates: HashMap<LayerKey, RateMeter>,
    last_keyframe_req: HashMap<LayerKey, Instant>,
}

impl Track {
    fn info(&self, user: Id) -> TrackInfo {
        TrackInfo {
            id: self.id.clone(),
            user_id: user,
            kind: if self.kind == MediaKind::Audio { WireKind::Audio } else { WireKind::Video },
            source: self.source,
            layers: if self.layers.len() > 1 { self.layers.iter().map(|l| l.name.clone()).collect() } else { vec![] },
        }
    }

    fn rate(&self, key: LayerKey) -> u64 {
        self.rates.get(&key).map(|r| r.bps).unwrap_or(0)
    }

    fn mids(&self) -> Vec<Mid> {
        let mut m: Vec<Mid> = self.layers.iter().map(|l| l.key.0).collect();
        m.dedup();
        m
    }

    fn sort_layers(&mut self) {
        let rank = |n: &str| LAYER_ORDER.iter().position(|o| *o == n).unwrap_or(LAYER_ORDER.len());
        self.layers.sort_by_key(|l| rank(&l.name));
    }

    fn layer_name(&self, key: LayerKey) -> Option<String> {
        self.layers.iter().find(|l| l.key == key).map(|l| l.name.clone())
    }
}

struct Sub {
    src: (PeerId, String),
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
    rtc: Rtc,
    out: mpsc::UnboundedSender<VoiceServerMsg>,
    /// Publish metadata from the latest offer, keyed by mid, consumed on `MediaAdded`.
    pending_publish: HashMap<String, PublishTrack>,
    tracks: HashMap<String, Track>,
    mid_track: HashMap<Mid, String>,
    slots: HashMap<Mid, Slot>,
    next_timeout: Instant,
    estimate_bps: u64,
    last_loud: Option<Instant>,
    speaking: bool,
    addrs: Vec<SocketAddr>,
    /// When ICE went Disconnected, if it hasn't recovered yet.
    ice_lost: Option<Instant>,
}

impl Peer {
    fn send(&self, msg: VoiceServerMsg) {
        let _ = self.out.send(msg);
    }
}

#[derive(Default)]
struct Room {
    peers: Vec<PeerId>,
    /// track id -> publishing peer
    tracks: HashMap<String, PeerId>,
}

struct Worker {
    socket: UdpSocket,
    public: SocketAddr,
    initial_bwe: u64,
    peers: HashMap<PeerId, Peer>,
    rooms: HashMap<Id, Room>,
    addrs: HashMap<SocketAddr, PeerId>,
    /// Publisher m-line -> subscriber slots. A layered track registers its subscribers on
    /// every one of its m-lines.
    fanout: HashMap<(PeerId, Mid), Vec<(PeerId, Mid)>>,
    dirty: HashSet<PeerId>,
    buf: Vec<u8>,
    prof: Prof,
}

impl Worker {
    fn new(socket: UdpSocket, public: SocketAddr, initial_bwe: u64) -> Self {
        Self {
            socket,
            public,
            initial_bwe,
            peers: HashMap::new(),
            rooms: HashMap::new(),
            addrs: HashMap::new(),
            fanout: HashMap::new(),
            dirty: HashSet::new(),
            buf: vec![0; 2000],
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
                    Some(cmd) => self.handle_cmd(cmd),
                    None => return,
                },
                _ = tokio::time::sleep_until(deadline.into()) => {}
                _ = layer_tick.tick() => self.select_layers(),
                _ = speak_tick.tick() => self.update_speaking(),
            }
            self.drive_timeouts();
            self.drive_dirty();
            if self.prof.enabled {
                self.prof.loops += 1;
                self.prof.report();
            }
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
        }
    }

    /// Polls a peer until it yields a timeout, transmitting packets and handling events.
    fn drive(&mut self, id: PeerId) {
        let mut events = Vec::new();
        {
            let Some(peer) = self.peers.get_mut(&id) else { return };
            self.prof.drives += 1;
            let _ = timed!(self.prof, poll, peer.rtc.handle_input(Input::Timeout(Instant::now())));
            loop {
                if !peer.rtc.is_alive() {
                    break;
                }
                match timed!(self.prof, poll, peer.rtc.poll_output()) {
                    Ok(Output::Timeout(t)) => {
                        peer.next_timeout = t;
                        break;
                    }
                    Ok(Output::Transmit(t)) => {
                        self.prof.packets_out += 1;
                        if let Err(e) = timed!(self.prof, send, self.socket.try_send_to(&t.contents, t.destination))
                            && e.kind() != ErrorKind::WouldBlock
                        {
                            tracing::trace!("udp send error: {e}");
                        }
                    }
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
        let t = Instant::now();
        for e in events {
            self.handle_event(id, e);
        }
        if self.prof.enabled {
            self.prof.events += t.elapsed();
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
                tracing::debug!(peer = id.0, "connected");
                // Subscriptions made before DTLS completed need a fresh keyframe.
                let reqs: Vec<_> = self
                    .peers
                    .get(&id)
                    .map(|p| p.slots.values().filter_map(|s| s.sub.as_ref().and_then(|s| Some((s.src.0, s.target?)))).collect())
                    .unwrap_or_default();
                for (pid, key) in reqs {
                    self.request_keyframe(pid, key, true);
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
                    let pid = sub.src.0;
                    self.request_keyframe(pid, key, req.kind == KeyframeRequestKind::Fir);
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
            Cmd::Join { peer, user, room, out } => self.join(peer, user, room, out),
            Cmd::Leave { peer } => self.remove_peer(peer),
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

    fn join(&mut self, id: PeerId, user: Id, room_id: Id, out: mpsc::UnboundedSender<VoiceServerMsg>) {
        // One connection per user per room: a new one replaces the old (e.g. reconnect).
        let dup: Vec<PeerId> = self
            .rooms
            .get(&room_id)
            .map(|r| r.peers.iter().copied().filter(|p| self.peers.get(p).is_some_and(|p| p.user == user)).collect())
            .unwrap_or_default();
        for d in dup {
            if let Some(p) = self.peers.get(&d) {
                p.send(VoiceServerMsg::Error { message: "replaced by a newer connection".into() });
            }
            self.remove_peer(d);
        }

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

        let room = self.rooms.entry(room_id).or_default();
        let tracks: Vec<TrackInfo> = room
            .tracks
            .iter()
            .filter_map(|(tid, pid)| {
                let p = self.peers.get(pid)?;
                Some(p.tracks.get(tid)?.info(p.user))
            })
            .collect();
        room.peers.push(id);
        let _ = out.send(VoiceServerMsg::Joined { peer_id: id.0.to_string(), tracks });
        self.peers.insert(
            id,
            Peer {
                user,
                room: room_id,
                rtc,
                out,
                pending_publish: HashMap::new(),
                tracks: HashMap::new(),
                mid_track: HashMap::new(),
                slots: HashMap::new(),
                next_timeout: Instant::now(),
                estimate_bps: self.initial_bwe,
                last_loud: None,
                speaking: false,
                addrs: Vec::new(),
                ice_lost: None,
            },
        );
        tracing::info!(peer = id.0, user = %user, room = %room_id, "peer joined");
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
            self.broadcast(room_id, Some(id), VoiceServerMsg::Speaking { user_id: user, speaking: false });
        }
        let Some(peer) = self.peers.remove(&id) else { return };
        for a in peer.addrs {
            self.addrs.remove(&a);
        }
        if let Some(room) = self.rooms.get_mut(&room_id) {
            room.peers.retain(|p| *p != id);
            if room.peers.is_empty() {
                self.rooms.remove(&room_id);
            }
        }
        self.dirty.remove(&id);
        tracing::info!(peer = id.0, "peer left");
    }

    fn broadcast(&self, room: Id, except: Option<PeerId>, msg: VoiceServerMsg) {
        let Some(room) = self.rooms.get(&room) else { return };
        for pid in &room.peers {
            if Some(*pid) != except
                && let Some(p) = self.peers.get(pid)
            {
                p.send(msg.clone());
            }
        }
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
                let group = meta.as_ref().and_then(|m| m.group.clone());
                let track_id = match &group {
                    Some(g) => format!("{}-g{}", id.0, g),
                    None => format!("{}-{}", id.0, mid),
                };
                let new_layers: Vec<Layer> = if rids.is_empty() {
                    let name = meta.and_then(|m| m.layer).unwrap_or_else(|| "h".into());
                    vec![Layer { name, key: (mid, None) }]
                } else {
                    rids.iter().map(|r| Layer { name: r.to_string(), key: (mid, Some(*r)) }).collect()
                };
                let track = peer.tracks.entry(track_id.clone()).or_insert_with(|| Track {
                    id: track_id.clone(),
                    kind,
                    source,
                    layers: vec![],
                    rates: HashMap::new(),
                    last_keyframe_req: HashMap::new(),
                });
                // Existing subscribers of a growing group must also receive the new m-line.
                let existing_mid = track.layers.first().map(|l| l.key.0);
                track.layers.extend(new_layers);
                track.sort_layers();
                let info = track.info(peer.user);
                let room = peer.room;
                peer.mid_track.insert(mid, track_id.clone());
                if let Some(em) = existing_mid
                    && let Some(subs) = self.fanout.get(&(id, em)).cloned()
                {
                    self.fanout.entry((id, mid)).or_default().extend(subs);
                }
                if let Some(r) = self.rooms.get_mut(&room) {
                    r.tracks.insert(track_id.clone(), id);
                }
                tracing::info!(peer = id.0, track = %track_id, %mid, source = ?info.source, layers = ?info.layers, "published");
                self.broadcast(room, Some(id), VoiceServerMsg::TrackAdded { track: info });
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
        let Some(track) = peer.tracks.get_mut(&track_id) else { return };
        track.layers.retain(|l| l.key.0 != mid);
        track.rates.retain(|k, _| k.0 != mid);
        let empty = track.layers.is_empty();
        let best = track.layers.first().map(|l| l.key);
        let info = track.info(peer.user);
        let room = peer.room;
        if empty {
            peer.tracks.remove(&track_id);
        }
        let subs = self.fanout.remove(&(id, mid)).unwrap_or_default();
        for (sp, smid) in subs {
            let Some(slot) = self.peers.get_mut(&sp).and_then(|p| p.slots.get_mut(&smid)) else { continue };
            if empty {
                slot.sub = None;
            } else if let Some(sub) = slot.sub.as_mut() {
                // Retarget subscribers that were on the removed layer.
                if sub.current.is_some_and(|c| c.0 == mid) {
                    sub.current = None;
                }
                if sub.target.is_some_and(|t| t.0 == mid) {
                    sub.target = best;
                }
            }
        }
        if empty {
            if let Some(r) = self.rooms.get_mut(&room) {
                r.tracks.remove(&track_id);
            }
            tracing::info!(peer = id.0, track = %track_id, "unpublished");
            self.broadcast(room, Some(id), VoiceServerMsg::TrackRemoved { track_id });
        } else {
            self.broadcast(room, Some(id), VoiceServerMsg::TrackAdded { track: info });
        }
    }

    fn subscribe(&mut self, id: PeerId, mid: Mid, track_id: &str) {
        let Some(peer) = self.peers.get(&id) else { return };
        let Some(&pid) = self.rooms.get(&peer.room).and_then(|r| r.tracks.get(track_id)) else {
            peer.send(VoiceServerMsg::Error { message: format!("no track {track_id}") });
            return;
        };
        if pid == id {
            return;
        }
        let Some(track) = self.peers.get(&pid).and_then(|p| p.tracks.get(track_id)) else { return };
        let kind = track.kind;
        let mids = track.mids();
        // Start mid-quality and let the allocator move from there.
        let target = track.layers.get(track.layers.len() / 2).or(track.layers.first()).map(|l| l.key);

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
        if slot.kind != kind {
            peer.send(VoiceServerMsg::Error { message: "slot kind mismatch".into() });
            return;
        }
        slot.sub = Some(Sub {
            src: (pid, track_id.to_string()),
            pref: LayerPref::Auto,
            // Audio has no keyframes: forward immediately.
            current: if kind == MediaKind::Audio { target } else { None },
            target,
            ts_in: 0,
            ts_out: 0,
            last_out: None,
            rebase: true,
            last_downgrade: None,
        });
        for m in mids {
            self.fanout.entry((pid, m)).or_default().push((id, mid));
        }
        if kind == MediaKind::Video {
            if let Some(t) = target {
                self.request_keyframe(pid, t, true);
            }
            self.select_layers_for(id);
        }
    }

    fn unsubscribe(&mut self, id: PeerId, mid: Mid) {
        let Some(sub) = self.peers.get_mut(&id).and_then(|p| p.slots.get_mut(&mid)).and_then(|s| s.sub.take()) else {
            return;
        };
        let pid = sub.src.0;
        let mids = self.peers.get(&pid).and_then(|p| p.tracks.get(&sub.src.1)).map(|t| t.mids()).unwrap_or_default();
        for m in mids {
            if let Some(v) = self.fanout.get_mut(&(pid, m)) {
                v.retain(|s| *s != (id, mid));
                if v.is_empty() {
                    self.fanout.remove(&(pid, m));
                }
            }
        }
    }

    fn request_keyframe(&mut self, pid: PeerId, key: LayerKey, force: bool) {
        let Some(peer) = self.peers.get_mut(&pid) else { return };
        let Some(track) = peer.mid_track.get(&key.0).and_then(|t| peer.tracks.get_mut(t)) else { return };
        if track.kind != MediaKind::Video {
            return;
        }
        let now = Instant::now();
        if !force && track.last_keyframe_req.get(&key).is_some_and(|t| now.duration_since(*t) < KEYFRAME_THROTTLE) {
            return;
        }
        track.last_keyframe_req.insert(key, now);
        tracing::debug!(publisher = pid.0, ?key, force, "keyframe request");
        if let Some(mut w) = peer.rtc.writer(key.0) {
            let _ = w.request_keyframe(key.1, KeyframeRequestKind::Pli);
            self.dirty.insert(pid);
        }
    }

    fn media_data(&mut self, id: PeerId, d: MediaData) {
        let now = Instant::now();
        let key: LayerKey = (d.mid, d.rid);
        let Some(peer) = self.peers.get_mut(&id) else { return };
        let Some(track) = peer.mid_track.get(&d.mid).and_then(|t| peer.tracks.get_mut(t)) else { return };
        track.rates.entry(key).or_insert_with(|| RateMeter::new(now)).add(d.data.len(), now);
        let audio = track.kind == MediaKind::Audio;
        let source = track.source;
        let layer_name = (track.layers.len() > 1).then(|| track.layer_name(key)).flatten();

        if source == TrackSource::Mic
            && let Some(level) = d.ext_vals.audio_level
            && (level as i32).abs() < SPEAK_DBOV
        {
            peer.last_loud = Some(now);
        }

        if !d.contiguous && !audio {
            self.request_keyframe(id, key, false);
        }

        let Some(subs) = self.fanout.get(&(id, d.mid)) else { return };
        let is_keyframe = d.is_keyframe();
        // One fixup per frame, shared by every subscriber.
        let data = match (is_keyframe, d.params.spec().codec) {
            (true, Codec::H264) => match crate::h264::reorder_parameter_sets(&d.data) {
                Some(fixed) => Arc::<[u8]>::from(fixed),
                None => d.data.clone(),
            },
            _ => d.data.clone(),
        };
        let mut switched = Vec::new();
        for &(sp, smid) in subs {
            let Some(sp_peer) = self.peers.get_mut(&sp) else { continue };
            let Some(sub) = sp_peer.slots.get_mut(&smid).and_then(|s| s.sub.as_mut()) else { continue };

            // Switch layers only on a keyframe of the target so the decoder never breaks.
            if sub.target == Some(key) && sub.current != Some(key) && (is_keyframe || audio) {
                tracing::debug!(viewer = sp.0, from = ?sub.current, to = ?key, "layer switch");
                sub.current = Some(key);
                sub.rebase = true;
                if layer_name.is_some() {
                    switched.push((sp, smid));
                }
            }
            if sub.current != Some(key) {
                continue;
            }

            let t = d.time.numer();
            if sub.rebase {
                // Continue one frame after whatever was last sent on this slot.
                let step = if d.time.frequency().get() == 90_000 { 3000 } else { 960 };
                sub.ts_in = t;
                sub.ts_out = sub.last_out.map(|l| l + step).unwrap_or(t);
                sub.rebase = false;
            }
            let out_t = sub.ts_out.wrapping_add(t.wrapping_sub(sub.ts_in));
            sub.last_out = Some(out_t);
            let out_time = MediaTime::new(out_t, d.time.frequency());

            let Some(writer) = sp_peer.rtc.writer(smid) else { continue };
            let Some(pt) = writer.match_params(d.params) else { continue };
            let writer = match d.ext_vals.audio_level {
                Some(level) => writer.audio_level(level, d.ext_vals.voice_activity.unwrap_or(false)),
                None => writer,
            };
            self.prof.writes += 1;
            if let Err(e) = timed!(self.prof, write, writer.write(pt, d.network_time, out_time, data.clone())) {
                tracing::debug!(peer = sp.0, "write failed: {e:?}");
            }
            self.dirty.insert(sp);
        }
        for (sp, smid) in switched {
            if let Some(p) = self.peers.get(&sp) {
                p.send(VoiceServerMsg::Layer { mid: smid.to_string(), layer: layer_name.clone(), estimate_bps: p.estimate_bps });
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
            src_peer: PeerId,
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
            let Some(track) = self.peers.get(&sub.src.0).and_then(|p| p.tracks.get(&sub.src.1)) else { continue };
            let layers: Vec<(LayerKey, u64)> = track.layers.iter().map(|l| (l.key, track.rate(l.key))).collect();
            if track.kind == MediaKind::Audio {
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
                src_peer: sub.src.0,
                layers,
                pref: sub.pref,
                priority: if track.source == TrackSource::Screen { 0 } else { 1 },
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
                changes.push((w.slot, w.src_peer, pick, downgrade));
            }
        }

        let peer = self.peers.get_mut(&id).expect("checked");
        // Ask the BWE to probe for what full quality would need.
        peer.rtc.bwe().set_desired_bitrate(Bitrate::bps(((desired + audio_bps + fixed_bps) as f64 * 1.1) as u64));
        let mut kf = Vec::new();
        for (slot, pid, pick, downgrade) in changes {
            if let Some(sub) = peer.slots.get_mut(&slot).and_then(|s| s.sub.as_mut()) {
                if downgrade {
                    sub.last_downgrade = Some(now);
                }
                sub.target = pick;
                if let Some(k) = pick {
                    kf.push((pid, k));
                }
            }
        }
        for (pid, key) in kf {
            self.request_keyframe(pid, key, false);
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
            self.broadcast(room, None, VoiceServerMsg::Speaking { user_id: user, speaking });
        }
    }
}
