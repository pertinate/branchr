//! A worker owns one UDP socket and every room hashed onto it. All media forwarding for a
//! room happens on a single thread without locks.
//!
//! Hot path per incoming packet:
//!   socket -> addr lookup (O(1)) -> `Rtc::handle_input` -> `MediaData` events ->
//!   for each subscriber: layer filter, timestamp rebase, `Writer::write` (Arc clone).

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use proto::Id;
use proto::voice::{LayerPref, MediaKind as WireKind, PublishTrack, TrackInfo, TrackSource, VoiceClientMsg, VoiceServerMsg};
use str0m::bwe::{Bitrate, BweKind};
use str0m::change::SdpOffer;
use str0m::media::{Direction, KeyframeRequestKind, MediaData, MediaKind, Mid, Rid};
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

/// Simulcast rids from highest to lowest quality; clients publish these names.
const LAYER_ORDER: [&str; 3] = ["h", "m", "l"];

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

struct Published {
    id: String,
    kind: MediaKind,
    source: TrackSource,
    rids: Vec<Rid>,
    rates: HashMap<Option<Rid>, RateMeter>,
    last_keyframe_req: HashMap<Option<Rid>, Instant>,
}

impl Published {
    fn info(&self, user: Id) -> TrackInfo {
        TrackInfo {
            id: self.id.clone(),
            user_id: user,
            kind: if self.kind == MediaKind::Audio { WireKind::Audio } else { WireKind::Video },
            source: self.source,
            layers: self.rids.iter().map(|r| r.to_string()).collect(),
        }
    }

    fn rate(&self, rid: Option<Rid>) -> u64 {
        self.rates.get(&rid).map(|r| r.bps).unwrap_or(0)
    }

    /// Available layers, best first.
    fn layers_desc(&self) -> Vec<Rid> {
        let mut v: Vec<Rid> = LAYER_ORDER.iter().map(|s| Rid::from(*s)).filter(|r| self.rids.contains(r)).collect();
        // Unknown rid names still work, just without an ordering guarantee.
        let extra: Vec<Rid> = self.rids.iter().filter(|r| !v.contains(r)).copied().collect();
        v.extend(extra);
        v
    }
}

struct Sub {
    src: (PeerId, Mid),
    pref: LayerPref,
    /// Layer currently forwarded (None for non-simulcast sources).
    current: Option<Rid>,
    /// Layer we want; switched to on its next keyframe.
    target: Option<Rid>,
    waiting_keyframe: bool,
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
    /// Sources announced in the latest offer, keyed by mid, consumed on `MediaAdded`.
    pending_publish: HashMap<String, TrackSource>,
    published: HashMap<Mid, Published>,
    slots: HashMap<Mid, Slot>,
    next_timeout: Instant,
    estimate_bps: u64,
    last_loud: Option<Instant>,
    speaking: bool,
    addrs: Vec<SocketAddr>,
}

impl Peer {
    fn send(&self, msg: VoiceServerMsg) {
        let _ = self.out.send(msg);
    }
}

#[derive(Default)]
struct Room {
    peers: Vec<PeerId>,
    tracks: HashMap<String, (PeerId, Mid)>,
}

struct Worker {
    socket: UdpSocket,
    public: SocketAddr,
    initial_bwe: u64,
    peers: HashMap<PeerId, Peer>,
    rooms: HashMap<Id, Room>,
    addrs: HashMap<SocketAddr, PeerId>,
    /// Publisher track -> subscriber slots.
    fanout: HashMap<(PeerId, Mid), Vec<(PeerId, Mid)>>,
    dirty: HashSet<PeerId>,
    buf: Vec<u8>,
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
                    if let Err(e) = peer.rtc.handle_input(input) {
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
            let _ = peer.rtc.handle_input(Input::Timeout(Instant::now()));
            loop {
                if !peer.rtc.is_alive() {
                    break;
                }
                match peer.rtc.poll_output() {
                    Ok(Output::Timeout(t)) => {
                        peer.next_timeout = t;
                        break;
                    }
                    Ok(Output::Transmit(t)) => {
                        if let Err(e) = self.socket.try_send_to(&t.contents, t.destination)
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
        for e in events {
            self.handle_event(id, e);
        }
    }

    fn handle_event(&mut self, id: PeerId, e: Event) {
        match e {
            Event::IceConnectionStateChange(s) => {
                tracing::debug!(peer = id.0, "ice {s:?}");
                if s == IceConnectionState::Disconnected
                    && let Some(p) = self.peers.get_mut(&id)
                {
                    p.rtc.disconnect();
                    self.dirty.insert(id);
                }
            }
            Event::Connected => {
                tracing::debug!(peer = id.0, "connected");
                // Subscriptions made before DTLS completed need a fresh keyframe.
                let srcs: Vec<_> = self
                    .peers
                    .get(&id)
                    .map(|p| p.slots.values().filter_map(|s| s.sub.as_ref().map(|s| (s.src, s.target))).collect())
                    .unwrap_or_default();
                for (src, rid) in srcs {
                    self.request_keyframe(src, rid, true);
                }
            }
            Event::MediaAdded(m) => self.media_added(id, m.mid, m.kind, m.direction, m.simulcast.map(|s| s.recv.into_iter().map(|l| l.rid).collect())),
            Event::MediaChanged(m) => {
                let receiving = matches!(m.direction, Direction::RecvOnly | Direction::SendRecv);
                let is_published = self.peers.get(&id).is_some_and(|p| p.published.contains_key(&m.mid));
                if is_published && !receiving {
                    self.unpublish(id, m.mid);
                }
            }
            Event::MediaData(d) => self.media_data(id, d),
            Event::KeyframeRequest(req) => {
                let Some(sub) = self.peers.get(&id).and_then(|p| p.slots.get(&req.mid)).and_then(|s| s.sub.as_ref()) else {
                    return;
                };
                let (src, rid) = (sub.src, sub.current.or(sub.target));
                self.request_keyframe(src, rid, req.kind == KeyframeRequestKind::Fir);
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
                        if let Some(sub) = self.peers.get_mut(&peer).and_then(|p| p.slots.get_mut(&Mid::from(mid.as_str())))
                            .and_then(|s| s.sub.as_mut())
                        {
                            sub.pref = layer;
                        }
                        self.select_layers_for(peer);
                    }
                    VoiceClientMsg::Unpublish { mid } => self.unpublish(peer, Mid::from(mid.as_str())),
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
            .values()
            .filter_map(|(pid, mid)| {
                let p = self.peers.get(pid)?;
                Some(p.published.get(mid)?.info(p.user))
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
                published: HashMap::new(),
                slots: HashMap::new(),
                next_timeout: Instant::now(),
                estimate_bps: self.initial_bwe,
                last_loud: None,
                speaking: false,
                addrs: Vec::new(),
            },
        );
        tracing::info!(peer = id.0, user = %user, room = %room_id, "peer joined");
    }

    fn remove_peer(&mut self, id: PeerId) {
        let Some(peer) = self.peers.get(&id) else { return };
        let mids: Vec<Mid> = peer.published.keys().copied().collect();
        let slots: Vec<Mid> = peer.slots.keys().copied().collect();
        let room_id = peer.room;
        let speaking = peer.speaking;
        let user = peer.user;
        for m in mids {
            self.unpublish(id, m);
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
            peer.pending_publish.insert(p.mid, p.source);
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
                // Process MediaAdded now so a Subscribe right after this offer finds its slot.
                self.drive(id);
            }
            Err(e) => peer.send(VoiceServerMsg::Error { message: format!("offer rejected: {e}") }),
        }
    }

    fn media_added(&mut self, id: PeerId, mid: Mid, kind: MediaKind, dir: Direction, rids: Option<Vec<Rid>>) {
        let Some(peer) = self.peers.get_mut(&id) else { return };
        match dir {
            // The client sends on this m-line: it's a published track.
            Direction::RecvOnly | Direction::SendRecv => {
                let source = peer.pending_publish.remove(&mid.to_string()).unwrap_or(match kind {
                    MediaKind::Audio => TrackSource::Mic,
                    MediaKind::Video => TrackSource::Camera,
                });
                let track = Published {
                    id: format!("{}-{}", id.0, mid),
                    kind,
                    source,
                    rids: rids.unwrap_or_default(),
                    rates: HashMap::new(),
                    last_keyframe_req: HashMap::new(),
                };
                let info = track.info(peer.user);
                let room = peer.room;
                peer.published.insert(mid, track);
                if let Some(r) = self.rooms.get_mut(&room) {
                    r.tracks.insert(info.id.clone(), (id, mid));
                }
                tracing::info!(peer = id.0, track = %info.id, source = ?info.source, layers = ?info.layers, "published");
                self.broadcast(room, Some(id), VoiceServerMsg::TrackAdded { track: info });
            }
            // The client receives on this m-line: a subscription slot.
            Direction::SendOnly => {
                peer.slots.entry(mid).or_insert(Slot { kind, sub: None });
            }
            Direction::Inactive => {}
        }
    }

    fn unpublish(&mut self, id: PeerId, mid: Mid) {
        let Some(peer) = self.peers.get_mut(&id) else { return };
        let Some(track) = peer.published.remove(&mid) else { return };
        let room = peer.room;
        if let Some(r) = self.rooms.get_mut(&room) {
            r.tracks.remove(&track.id);
        }
        if let Some(subs) = self.fanout.remove(&(id, mid)) {
            for (sp, smid) in subs {
                if let Some(slot) = self.peers.get_mut(&sp).and_then(|p| p.slots.get_mut(&smid)) {
                    slot.sub = None;
                }
            }
        }
        tracing::info!(peer = id.0, track = %track.id, "unpublished");
        self.broadcast(room, Some(id), VoiceServerMsg::TrackRemoved { track_id: track.id });
    }

    fn subscribe(&mut self, id: PeerId, mid: Mid, track_id: &str) {
        let Some(peer) = self.peers.get(&id) else { return };
        let Some(&src) = self.rooms.get(&peer.room).and_then(|r| r.tracks.get(track_id)) else {
            peer.send(VoiceServerMsg::Error { message: format!("no track {track_id}") });
            return;
        };
        if src.0 == id {
            return;
        }
        let Some(track) = self.peers.get(&src.0).and_then(|p| p.published.get(&src.1)) else { return };
        let (kind, layers) = (track.kind, track.layers_desc());
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
        let old = slot.sub.take().map(|s| (s.src, s.last_out));
        // Start mid-quality (if simulcast) and let the allocator move from there.
        let target = layers.get(layers.len() / 2).copied().or(layers.first().copied());
        slot.sub = Some(Sub {
            src,
            pref: LayerPref::Auto,
            current: None,
            target,
            waiting_keyframe: kind == MediaKind::Video,
            ts_in: 0,
            ts_out: 0,
            last_out: old.and_then(|o| o.1),
            rebase: true,
            last_downgrade: None,
        });
        if let Some((old_src, _)) = old {
            if let Some(v) = self.fanout.get_mut(&old_src) {
                v.retain(|s| *s != (id, mid));
            }
        }
        self.fanout.entry(src).or_default().push((id, mid));
        if kind == MediaKind::Video {
            self.request_keyframe(src, target, true);
            self.select_layers_for(id);
        }
    }

    fn unsubscribe(&mut self, id: PeerId, mid: Mid) {
        let Some(sub) = self.peers.get_mut(&id).and_then(|p| p.slots.get_mut(&mid)).and_then(|s| s.sub.take()) else {
            return;
        };
        if let Some(v) = self.fanout.get_mut(&sub.src) {
            v.retain(|s| *s != (id, mid));
            if v.is_empty() {
                self.fanout.remove(&sub.src);
            }
        }
    }

    fn request_keyframe(&mut self, (pid, mid): (PeerId, Mid), rid: Option<Rid>, force: bool) {
        let Some(peer) = self.peers.get_mut(&pid) else { return };
        let Some(track) = peer.published.get_mut(&mid) else { return };
        if track.kind != MediaKind::Video {
            return;
        }
        let now = Instant::now();
        if !force && track.last_keyframe_req.get(&rid).is_some_and(|t| now.duration_since(*t) < KEYFRAME_THROTTLE) {
            return;
        }
        track.last_keyframe_req.insert(rid, now);
        if let Some(mut w) = peer.rtc.writer(mid) {
            let _ = w.request_keyframe(rid, KeyframeRequestKind::Pli);
            self.dirty.insert(pid);
        }
    }

    fn media_data(&mut self, id: PeerId, d: MediaData) {
        let now = Instant::now();
        let Some(peer) = self.peers.get_mut(&id) else { return };
        let Some(track) = peer.published.get_mut(&d.mid) else { return };
        track.rates.entry(d.rid).or_insert_with(|| RateMeter::new(now)).add(d.data.len(), now);
        let simulcast = !track.rids.is_empty();
        let source = track.source;

        if source == TrackSource::Mic
            && let Some(level) = d.ext_vals.audio_level
            && (level as i32).abs() < SPEAK_DBOV
        {
            peer.last_loud = Some(now);
        }

        if !d.contiguous {
            self.request_keyframe((id, d.mid), d.rid, false);
        }

        let Some(subs) = self.fanout.get(&(id, d.mid)) else { return };
        let is_keyframe = d.is_keyframe();
        let mut switched = Vec::new();
        for &(sp, smid) in subs {
            let Some(sp_peer) = self.peers.get_mut(&sp) else { continue };
            let Some(sub) = sp_peer.slots.get_mut(&smid).and_then(|s| s.sub.as_mut()) else { continue };

            if simulcast {
                if sub.target != sub.current && d.rid == sub.target && is_keyframe {
                    sub.current = sub.target;
                    sub.rebase = true;
                    sub.waiting_keyframe = false;
                    switched.push((sp, smid, sub.current));
                }
                if d.rid != sub.current {
                    continue;
                }
            } else if sub.waiting_keyframe {
                if !is_keyframe {
                    continue;
                }
                sub.waiting_keyframe = false;
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
            let out_time = str0m::media::MediaTime::new(out_t, d.time.frequency());

            let Some(writer) = sp_peer.rtc.writer(smid) else { continue };
            let Some(pt) = writer.match_params(d.params) else { continue };
            let writer = if d.ext_vals.audio_level.is_some() {
                writer.audio_level(d.ext_vals.audio_level.unwrap_or(-127), d.ext_vals.voice_activity.unwrap_or(false))
            } else {
                writer
            };
            if let Err(e) = writer.write(pt, d.network_time, out_time, d.data.clone()) {
                tracing::debug!(peer = sp.0, "write failed: {e:?}");
            }
            self.dirty.insert(sp);
        }
        for (sp, smid, rid) in switched {
            if let Some(p) = self.peers.get(&sp) {
                p.send(VoiceServerMsg::Layer {
                    mid: smid.to_string(),
                    layer: rid.map(|r| r.to_string()),
                    estimate_bps: p.estimate_bps,
                });
            }
        }
    }

    fn select_layers(&mut self) {
        let ids: Vec<PeerId> = self.peers.keys().copied().collect();
        for id in ids {
            self.select_layers_for(id);
        }
    }

    /// Greedy per-subscriber allocation of the downlink estimate across simulcast tracks.
    /// Screen shares get first claim on bandwidth, then cameras.
    fn select_layers_for(&mut self, id: PeerId) {
        let Some(peer) = self.peers.get(&id) else { return };
        struct Want {
            mid: Mid,
            src: (PeerId, Mid),
            layers: Vec<(Rid, u64)>,
            pref: LayerPref,
            priority: u8,
            current_target: Option<Rid>,
            last_downgrade: Option<Instant>,
        }
        let mut audio_bps = 0u64;
        let mut wants = Vec::new();
        let mut desired = 0u64;
        for (mid, slot) in &peer.slots {
            let Some(sub) = &slot.sub else { continue };
            let Some(track) = self.peers.get(&sub.src.0).and_then(|p| p.published.get(&sub.src.1)) else { continue };
            if track.kind == MediaKind::Audio {
                audio_bps += track.rate(None).max(40_000);
                continue;
            }
            if track.rids.is_empty() {
                desired += track.rate(None);
                continue;
            }
            let layers: Vec<(Rid, u64)> = track.layers_desc().into_iter().map(|r| (r, track.rate(Some(r)))).collect();
            desired += layers.first().map(|l| l.1).unwrap_or(0);
            wants.push(Want {
                mid: *mid,
                src: sub.src,
                layers,
                pref: sub.pref,
                priority: if track.source == TrackSource::Screen { 0 } else { 1 },
                current_target: sub.target,
                last_downgrade: sub.last_downgrade,
            });
        }
        let estimate = peer.estimate_bps;
        let mut budget = (estimate as f64 * 0.9) as i64 - audio_bps as i64;
        wants.sort_by_key(|w| w.priority);

        let now = Instant::now();
        let mut changes = Vec::new();
        for w in &wants {
            let pick = match w.pref {
                LayerPref::High => w.layers.first().map(|l| l.0),
                LayerPref::Medium => w.layers.get(w.layers.len() / 2).map(|l| l.0),
                LayerPref::Low => w.layers.last().map(|l| l.0),
                // All layers flow continuously from the publisher, so this only lasts ~1s.
                LayerPref::Auto if w.layers.iter().any(|l| l.1 == 0) => w.current_target,
                LayerPref::Auto => {
                    let current_idx = w.current_target.and_then(|t| w.layers.iter().position(|l| l.0 == t));
                    let mut choice = w.layers.last().map(|l| l.0);
                    for (i, (rid, bps)) in w.layers.iter().enumerate() {
                        let is_upgrade = current_idx.is_some_and(|c| i < c);
                        // Don't climb back up right after backing off.
                        let cooling = w.last_downgrade.is_some_and(|t| now.duration_since(t) < Duration::from_secs(4));
                        if is_upgrade && cooling {
                            continue;
                        }
                        let need = if is_upgrade { (*bps as f64 * UPGRADE_HEADROOM) as i64 } else { *bps as i64 };
                        if need <= budget {
                            choice = Some(*rid);
                            break;
                        }
                    }
                    choice
                }
            };
            if let Some(rid) = pick {
                budget -= w.layers.iter().find(|l| l.0 == rid).map(|l| l.1 as i64).unwrap_or(0);
            }
            if pick != w.current_target {
                changes.push((w.mid, w.src, pick, w.current_target, w.layers.clone()));
            }
        }

        let peer = self.peers.get_mut(&id).expect("checked");
        // Ask the BWE to probe for what full quality would need.
        peer.rtc.bwe().set_desired_bitrate(Bitrate::bps(((desired + audio_bps) as f64 * 1.1) as u64));
        let mut kf = Vec::new();
        for (mid, src, pick, old, layers) in changes {
            if let Some(sub) = peer.slots.get_mut(&mid).and_then(|s| s.sub.as_mut()) {
                let idx = |r: Option<Rid>| r.and_then(|r| layers.iter().position(|l| l.0 == r));
                if idx(pick) > idx(old) {
                    sub.last_downgrade = Some(now);
                }
                sub.target = pick;
                kf.push((src, pick));
            }
        }
        for (src, rid) in kf {
            self.request_keyframe(src, rid, false);
        }
    }

    fn update_speaking(&mut self) {
        let now = Instant::now();
        let mut changes = Vec::new();
        for (id, p) in self.peers.iter_mut() {
            let speaking = p.last_loud.is_some_and(|t| now.duration_since(t) < SPEAK_HOLD);
            if speaking != p.speaking {
                p.speaking = speaking;
                changes.push((*id, p.room, p.user, speaking));
            }
        }
        for (id, room, user, speaking) in changes {
            // Include the speaker so their own UI can show the indicator.
            self.broadcast(room, None, VoiceServerMsg::Speaking { user_id: user, speaking });
            let _ = id;
        }
    }
}
