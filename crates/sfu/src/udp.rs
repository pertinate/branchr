//! Batched UDP transmit: one `sendmmsg` syscall per batch instead of one `sendto` per packet.

use std::net::SocketAddr;
use std::os::fd::AsRawFd;

use socket2::SockAddr;

const CHUNK: usize = 64;

#[derive(Default)]
pub struct TxBatch {
    packets: Vec<(SockAddr, Vec<u8>)>,
    pub dropped: u64,
}

impl TxBatch {
    pub fn push(&mut self, dest: SocketAddr, data: Vec<u8>) {
        self.packets.push((dest.into(), data));
    }

    pub fn len(&self) -> usize {
        self.packets.len()
    }

    /// Sends everything queued. On a full socket buffer the rest is dropped (RTP recovers
    /// through NACK/keyframes; blocking the worker would be worse).
    pub fn flush(&mut self, socket: &impl AsRawFd) -> usize {
        let fd = socket.as_raw_fd();
        let mut sent_total = 0;
        for chunk in self.packets.chunks(CHUNK) {
            let mut iovs: Vec<libc::iovec> = chunk
                .iter()
                .map(|(_, d)| libc::iovec { iov_base: d.as_ptr() as *mut _, iov_len: d.len() })
                .collect();
            let mut msgs: Vec<libc::mmsghdr> = chunk
                .iter()
                .zip(iovs.iter_mut())
                .map(|((addr, _), iov)| {
                    // SAFETY: zeroed msghdr is a valid "empty" header.
                    let mut hdr: libc::msghdr = unsafe { std::mem::zeroed() };
                    hdr.msg_name = addr.as_ptr() as *mut _;
                    hdr.msg_namelen = addr.len();
                    hdr.msg_iov = iov as *mut _;
                    hdr.msg_iovlen = 1;
                    libc::mmsghdr { msg_hdr: hdr, msg_len: 0 }
                })
                .collect();
            let mut off = 0;
            while off < msgs.len() {
                // SAFETY: msgs/iovs/addrs outlive the call; lengths are consistent.
                let n = unsafe { libc::sendmmsg(fd, msgs[off..].as_mut_ptr(), (msgs.len() - off) as u32, libc::MSG_DONTWAIT) };
                if n <= 0 {
                    let err = std::io::Error::last_os_error();
                    if err.raw_os_error() == Some(libc::EINTR) {
                        continue;
                    }
                    // EAGAIN or a per-destination error (e.g. ICMP unreachable): skip one packet.
                    if err.raw_os_error() != Some(libc::EAGAIN) && err.raw_os_error() != Some(libc::EWOULDBLOCK) {
                        tracing::trace!("sendmmsg: {err}");
                        off += 1;
                        continue;
                    }
                    self.dropped += (msgs.len() - off) as u64;
                    break;
                }
                off += n as usize;
                sent_total += n as usize;
            }
        }
        self.packets.clear();
        sent_total
    }
}
