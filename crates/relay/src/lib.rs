//! branchr-relay as a library: the gateway (`server`) and the connector (`agent`), which a
//! hub's api can run itself (`RELAY=branchr.us`).

pub mod agent;
mod http;
pub mod proto;
pub mod server;
pub mod tls;
