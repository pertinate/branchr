//! branchr-relay: reach a branch running at home through a public gateway, like Plex's relay.
//!
//!   branchr-relay serve                                   on the gateway (the droplet)
//!   branchr-relay add <name> <host|-> <udp-base> <ports> on the gateway: allow a hub, print its token
//!                                                         (it's at https://<gateway>/h/<name>/, and at <host> too if given)
//!   branchr-relay connect                                 next to the branch (RELAY_TOKEN=...)

mod agent;
mod http;
mod proto;
mod server;
mod tls;

use std::path::PathBuf;

use rand::RngCore;

fn var(k: &str, default: &str) -> String {
    std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.into())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = PathBuf::from(var("RELAY_DIR", "relay-data"));
    match args.first().map(String::as_str) {
        Some("serve") => server::serve(dir, var("RELAY_QUIC", "0.0.0.0:7443").parse()?, var("RELAY_HTTP", "127.0.0.1:8800").parse()?).await,
        Some("add") => {
            let [_, name, host, base, ports] = &args[..] else {
                anyhow::bail!("usage: branchr-relay add <name> <host> <udp-base> <udp-ports>");
            };
            let (base, ports): (u16, u16) = (base.parse()?, ports.parse()?);
            let (cert, _) = tls::load_or_create(&dir)?;
            let mut raw = [0u8; 32];
            rand::rng().fill_bytes(&mut raw);
            let secret: String = raw.iter().map(|b| format!("{b:02x}")).collect();
            let mut branches = server::load_branches(&dir)?;
            branches.retain(|b| b.name != *name);
            let host = if host == "-" { String::new() } else { host.to_lowercase() };
            let name = &name.to_lowercase();
            if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                anyhow::bail!("a hub name is letters, digits and dashes (it goes in the address)");
            }
            if let Some(b) = branches.iter().find(|b| !host.is_empty() && b.host.eq_ignore_ascii_case(&host)) {
                anyhow::bail!("{host} already belongs to branch {}", b.name);
            }
            if let Some(b) = branches.iter().find(|b| base < b.udp_base + b.udp_ports && b.udp_base < base + ports) {
                anyhow::bail!("UDP {base}..{} overlaps branch {}", base + ports, b.name);
            }
            branches.push(server::Branch { name: name.clone(), secret_hash: server::hash(&secret), host: host.clone(), udp_base: base, udp_ports: ports });
            server::save_branches(&dir, &branches)?;
            let relay = var("RELAY_PUBLIC", "branchr.us:7443");
            let gateway = relay.rsplit_once(':').map_or(relay.as_str(), |(h, _)| h).to_string();
            let token = proto::Token { relay, name: name.clone(), secret, fp: tls::fingerprint(&cert) };
            println!("{}", token.encode());
            let also = if host.is_empty() { String::new() } else { format!(" and https://{host}") };
            eprintln!("allowed hub {name} at https://{gateway}/h/{name}/{also}, media on UDP {base}..{}; give the token above to its connector (RELAY_TOKEN)", base + ports - 1);
            Ok(())
        }
        Some("connect") => {
            let token = proto::Token::decode(&std::env::var("RELAY_TOKEN").map_err(|_| anyhow::anyhow!("set RELAY_TOKEN"))?)?;
            let targets = agent::Targets {
                api: var("RELAY_API", "http://127.0.0.1:8080"),
                sfu: var("RELAY_SFU", "http://127.0.0.1:8090"),
                sfu_udp: var("RELAY_SFU_UDP", "127.0.0.1:50000").parse()?,
            };
            agent::run(token, targets).await
        }
        _ => {
            eprintln!("usage: branchr-relay serve | add <name> <host> <udp-base> <udp-ports> | connect");
            std::process::exit(2);
        }
    }
}
