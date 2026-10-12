# syntax=docker/dockerfile:1.7
# One image with the Rust services (api, sfu, branchr-id) and the built web client.

FROM node:24-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter web... && pnpm --filter web build

FROM rust:1-bookworm AS rust
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY crates crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p api -p sfu -p id && cp target/release/api target/release/sfu target/release/branchr-id /usr/local/bin/

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=rust /usr/local/bin/api /usr/local/bin/sfu /usr/local/bin/branchr-id /usr/local/bin/
COPY --from=web /src/apps/web/dist /srv/web
ENV WEB_DIR=/srv/web DATABASE_URL=sqlite:///data/discord.db
VOLUME /data
EXPOSE 8080 8090 50000-50015/udp
CMD ["api"]
