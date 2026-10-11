//! Wire types shared between the API, the SFU and (via ts-rs) the web client.
//!
//! Run `cargo test -p proto --features ts` to regenerate `packages/protocol/src/generated`.

pub mod gateway;
pub mod id;
pub mod models;
pub mod voice;

pub use id::Id;

#[cfg(test)]
mod export {
    //! `cargo test -p proto --features ts` writes TypeScript bindings via ts-rs.
}
