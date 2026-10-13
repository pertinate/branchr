//! Forwarding one HTTP request (and a WebSocket upgrade, if it becomes one) to a sender.

use std::convert::Infallible;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;

pub type Body = BoxBody<Bytes, hyper::Error>;

pub fn text(status: StatusCode, msg: &'static str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from_static(msg.as_bytes())).map_err(|e: Infallible| match e {}).boxed());
    *r.status_mut() = status;
    r
}

/// Sends `req` with `send` and returns the response; when both sides agree to upgrade
/// (WebSockets), splices the two upgraded connections together.
pub async fn forward<F, Fut>(mut req: Request<Incoming>, send: F) -> Response<Body>
where
    F: FnOnce(Request<Incoming>) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Response<Incoming>>>,
{
    let wants_upgrade = req.headers().contains_key(hyper::header::UPGRADE);
    let downstream = wants_upgrade.then(|| hyper::upgrade::on(&mut req));
    let mut resp = match send(req).await {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!("forwarding: {e:#}");
            return text(StatusCode::BAD_GATEWAY, "branch unreachable");
        }
    };
    if resp.status() == StatusCode::SWITCHING_PROTOCOLS
        && let Some(down) = downstream
    {
        let up = hyper::upgrade::on(&mut resp);
        tokio::spawn(async move {
            if let (Ok(down), Ok(up)) = (down.await, up.await) {
                let _ = tokio::io::copy_bidirectional(&mut TokioIo::new(down), &mut TokioIo::new(up)).await;
            }
        });
    }
    resp.map(|b| b.boxed())
}
