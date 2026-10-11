<p align="center"><img src="apps/desktop/build/icon.svg" width="96" alt="" /></p>
<h1 align="center">branchr</h1>

<p align="center">Self-hostable voice, video and chat, built for <b>uncapped, low-latency game and desktop streaming</b>. Desktop apps for Linux and Windows.</p>

- **Backend (Rust)**: `api`, an axum REST API and realtime gateway on SQLite; `sfu`, a str0m-based selective forwarding unit for voice, video and streams.
- **Client**: Vite, React, TanStack Router, shadcn/ui and Tailwind v4. It ships as an **Electron AppImage** for Linux and also works as a web app served by the API.
- **Emotes** come from [7TV](https://7tv.app/emotes), [BetterTTV](https://betterttv.com) and [FrankerFaceZ](https://www.frankerfacez.com). You can search 7TV and FFZ, paste a link to any emote, import a 7TV set or user, or import a Twitch channel's emotes from all three. The server only uses each provider's public API and identifies itself honestly (no browser impersonation). That's why BetterTTV has no search there: BTTV emotes come from a Twitch channel import, or from a link plus a name.

```
apps/web        React client (also bundled into the desktop app)
apps/desktop    Electron shell: VA-API, PipeWire capture, Linux stream audio, AppImage
crates/api      REST + WebSocket gateway + SQLite + 7TV proxy, serves the web build
crates/sfu      Media relay (WebRTC SFU)
crates/proto    Wire types shared by Rust services and TypeScript (generated via ts-rs)
packages/protocol  Generated TypeScript types
tests/e2e       Playwright end-to-end tests (chat, voice, streaming, relay, desktop)
```

## Streaming design

Streams go through the SFU relay. The streamer **uploads each quality layer once**, whatever the number of viewers, and the SFU fans frames out. `tests/e2e/relay.spec.ts` checks this: upload is ~1.0 Mbps with 0 viewers and still ~1.0 Mbps with 4.

| Concern | How it's handled |
|---|---|
| No caps | Up to 4K or source resolution, 15–240 fps, any bitrate (default bits-per-pixel heuristic, or custom up to 200 Mbps). |
| CPU on the streamer | Chromium silently drops to **software** encoding for RID simulcast. Instead, each quality layer is its own transceiver, so each gets its own **hardware encoder** (VA-API). Codec "Auto" picks the best hardware-encodable codec. |
| CPU on the server | No transcoding. Frames are forwarded as reference-counted buffers, so per-viewer cost is a pointer copy plus packetization. |
| Viewers on weak links | The SFU runs per-viewer TWCC bandwidth estimation and picks the best layer that fits. Screen shares get budget before cameras. Switching only happens on keyframes and timestamps are rebased, so there are no decoder glitches. Viewers can also pin Source/Medium/Low. |
| Latency | Receivers set `jitterBufferTarget = 0`. The start bitrate is raised so streams start sharp instead of ramping up from 300 kbps. In tests the jitter buffer runs at 12–27 ms on LAN. |
| Scaling cores | The SFU shards rooms across worker threads, one UDP port each. A room's forwarding is lock-free on one thread, and packets are demuxed by source address in O(1). |
| Stream audio on Linux | Chromium can't capture app audio on Linux. The desktop app uses [venmic](https://github.com/Vencord/venmic) to route one app (e.g. the game), or everything except the client itself, into a PipeWire virtual mic. |
| Background throttling | Electron disables renderer backgrounding and timer throttling, so a minimized client keeps encoding. |

**Noise suppression** is open source and runs on-device, like Krisp: [GTCRN](https://github.com/Xiaobin-Rong/gtcrn) runs in an AudioWorklet, through [web-noise-suppressor](https://github.com/sapphi-red/web-noise-suppressor), after the browser's echo cancellation. Measured on 48 kHz input (`tests/e2e/noise.spec.ts`, plus a speech/noise benchmark):

| Mode | Steady hiss removed | Keyboard clicks removed | Speech level change | CPU |
|---|---|---|---|---|
| AI (GTCRN, default) | 22 dB | 53 dB | −0.1 dB | ~7% of a core |
| Standard (browser) | 19 dB | 7 dB | −0.3 dB | ~0 |
| RNNoise (not shipped) | 6.5 dB | 6 dB | 0 dB | ~3% |

Muting suspends the model. **User Settings → Voice → Mic Test** plays your processed mic back so you can compare modes.

Streams are opt-in ("Watch Stream"), so nobody downloads a stream they aren't watching. The **stats overlay** on a stream shows resolution, fps, bitrate, codec, encoder/decoder (HW or SW), jitter buffer, loss, current layer and the bandwidth estimate.

## Performance

The SFU is benchmarked with `crates/loadgen`. It runs one synthetic 60 fps publisher and N receive-only WebRTC viewers in a single process, and frames carry their send time, so latency is measured end to end through the relay:

```sh
cargo run --release -p loadgen -- --sfu ws://host:8090/ws --secret $VOICE_SECRET --viewers 100 --mbps 4 --fps 60 --seconds 30
```

Results for a single room on one SFU (8 workers, loopback, Ryzen desktop):

| Load | Egress | Delivered | Latency p50 / p99 | SFU CPU |
|---|---|---|---|---|
| 100 viewers × 4 Mbps | 408 Mbps | 60 fps all viewers, 0 gaps | 2.3 / 4.9 ms | 0.6 core |
| 20 viewers × 20 Mbps | 408 Mbps | 60 fps all viewers, 0 gaps | 2.5 / 20 ms | 0.4 core |
| 10 viewers × 50 Mbps | 510 Mbps | 60 fps all viewers, 0 gaps | 8.2 / 31 ms | 0.5 core |
| 300 viewers × 4 Mbps | 1.22 Gbps | 60 fps all viewers, 0 gaps | 4.3 / 7.3 ms | 2.2 cores |

On a **2 vCPU / 4 GB VPS** (DigitalOcean Basic AMD), with viewers on the other side of the internet (the latency includes ~56 ms for the two internet legs from publisher to SFU to viewer):

| Load | Egress | Delivered | Latency p50 / p99 | SFU CPU |
|---|---|---|---|---|
| 100 viewers × 4 Mbps | 412 Mbps | 60 fps all viewers, 0 gaps | 64 / 90–167 ms | ~1 vCPU |
| 20 viewers × 20 Mbps | 408 Mbps | 60 fps all viewers, 0 gaps | 67 / 100–149 ms | 0.7 vCPU |

On that VPS the gateway handles 5,000 concurrent sessions, and every message reaches all of them.

Viewers of one room are spread across all worker cores. Outgoing packets go out through `sendmmsg`. The gateway fans a message out to 5,000 connected sessions with p99 under 80 ms (`node tests/load/gateway.mjs http://host:8080 5000`).

## Self-hosting

You need Docker and one public IP with UDP reachable.

```sh
cp .env.example .env        # set PUBLIC_HOST, PUBLIC_IP, VOICE_SECRET (openssl rand -hex 32)
docker compose up -d --build
```

On a VPS (e.g. a DigitalOcean droplet) with automatic HTTPS from Caddy on one hostname, provision and deploy in one step. First point the domain's A record at the VPS (DNS only, not proxied):

```sh
DOMAIN=chat.example.com scripts/deploy-vps.sh root@your-vps
```

This installs Docker, opens 80/443 and the SFU's UDP ports in `ufw`, and serves the client, API and gateway at `https://DOMAIN`, with SFU signaling at `wss://DOMAIN/sfu/ws`.

Without the compose plugin (e.g. Unraid), deploy over SSH:

```sh
PUBLIC_IP=203.0.113.10 scripts/deploy-docker.sh root@your-server
```

Ports: API `8080` (or `8740` via the script), SFU signaling `8090`/`8741`, and media **UDP** with one port per SFU worker (`50000+` / `51000+`).

**HTTPS.** Browsers only allow microphone, camera and screen capture on `https://` (or localhost). Put the API and SFU behind a TLS reverse proxy (Caddy, nginx, Traefik) and set `SFU_URLS=wss://…`. The desktop app works against plain `http://` instances.

Configuration is all through the environment:

| Variable | Service | Default | |
|---|---|---|---|
| `DATABASE_URL` | api | `sqlite://data/discord.db` | SQLite file (WAL mode). |
| `VOICE_SECRET` | both | dev secret | HMAC key for voice tokens; must match. |
| `SFU_URLS` | api | `ws://localhost:8090/ws` | Comma-separated. Channels are spread across SFUs by hash. |
| `WEB_DIR` | api | unset | Serve the web client (set in the Docker image). |
| `OPEN_REGISTRATION` | api | `true` | |
| `SFU_PUBLIC_IP` | sfu | autodetected | IP put in ICE candidates. |
| `SFU_UDP_PORT` / `SFU_WORKERS` | sfu | `50000` / #cores | Worker *i* uses `SFU_UDP_PORT + i`. |
| `SFU_INITIAL_BWE` | sfu | `5000000` | Starting per-viewer estimate (bps). |

## CI/CD

GitHub Actions (`.github/workflows/`):

- **CI** runs on every push and PR. It runs the Rust tests, checks that the generated TypeScript protocol is current, typechecks, and validates the compose files. On `main` it then builds the server image, publishes it to `ghcr.io/<owner>/<repo>`, and deploys it.
- **Deploy** runs `scripts/deploy-image.sh`. It copies the compose files to the server, pulls the new image, restarts, and fails unless the API reports healthy. The server's `.env` and data are left alone. It needs a server already provisioned once with `scripts/deploy-vps.sh`, plus three secrets on the `production` environment (restricted to `main`): `DEPLOY_HOST` (`root@host`), `DEPLOY_SSH_KEY` (a private key authorized on it) and `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan host`). Without them the job is skipped.
- **Branch protection**: a ruleset on `main` requires a PR with the code owner's approval and passing `test`/`e2e` checks, and blocks force-pushes and deletion; repository admins bypass it. Workflow runs from outside contributors' PRs need approval.
- **Desktop** builds the Linux AppImage and the Windows installer and attaches them to the run. Pushing a `v*` tag publishes both as a GitHub release.

## Desktop app (Linux)

```sh
pnpm install
pnpm appimage               # → apps/desktop/release/branchr-<version>-x86_64.AppImage
```

The app enables VA-API encode/decode, PipeWire capture (Wayland portal picker), Ozone/Wayland and zero-copy. **User Settings → Streaming & Performance** shows which codecs your GPU encodes and decodes in hardware. For example, an RX 6950 XT hardware-encodes H.264 and hardware-decodes AV1, HEVC, VP9 and H.264.

## Development

```sh
pnpm install
cargo run -p api            # :8080
cargo run -p sfu            # :8090 + UDP 50000+
pnpm dev                    # Electron + Vite with HMR   (or: pnpm dev:web → http://localhost:5173)

pnpm gen:protocol           # regenerate TS types after changing crates/proto
pnpm test:e2e               # Playwright: starts api, sfu and vite automatically
cargo test --workspace
```

E2E against a deployed instance: media needs a secure origin, so tunnel to localhost first.

```sh
ssh -NL 18740:localhost:8740 root@your-server &
E2E_BASE_URL=http://localhost:18740 pnpm test:e2e
```
