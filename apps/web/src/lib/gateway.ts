import type { ClientOp, ServerEvent } from "@app/protocol";

import { gatewayUrl } from "@/lib/api";
import { useApp } from "@/stores/app";
import { useAuth } from "@/stores/auth";
import { useMessages } from "@/stores/messages";

type Listener = (ev: ServerEvent) => void;

/** Single gateway connection with heartbeats and exponential-backoff reconnects. */
class Gateway {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private wanted = false;
  private awaitingAck = false;
  private listeners = new Set<Listener>();

  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.reconnectTimer);
    this.teardown();
    useApp.getState().setConnection("idle");
  }

  send(op: ClientOp) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(op));
  }

  /** Extra listeners (e.g. voice) that need raw events. */
  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private teardown() {
    clearInterval(this.heartbeat);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private connect() {
    const { serverUrl, token } = useAuth.getState();
    if (!token) return;
    useApp.getState().setConnection(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(gatewayUrl(serverUrl));
    this.ws = ws;
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data) as ServerEvent;
      switch (ev.t) {
        case "HELLO":
          this.send({ op: "identify", d: { token } });
          this.startHeartbeat(ev.d.heartbeatIntervalMs);
          return;
        case "HEARTBEAT_ACK":
          this.awaitingAck = false;
          return;
        case "INVALID_SESSION":
          this.wanted = false;
          useAuth.getState().logout();
          return;
        case "READY":
          this.attempts = 0;
          // Messages may have been missed while disconnected; reload lazily on view.
          useMessages.setState({ channels: {} });
          break;
      }
      useApp.getState().apply(ev);
      for (const l of this.listeners) l(ev);
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => ws.close();
  }

  private startHeartbeat(interval: number) {
    clearInterval(this.heartbeat);
    this.awaitingAck = false;
    this.heartbeat = setInterval(() => {
      if (this.awaitingAck) {
        // Zombie connection: no ack for a whole interval.
        this.ws?.close();
        return;
      }
      this.awaitingAck = true;
      this.send({ op: "heartbeat" });
    }, interval * 0.9);
  }

  private scheduleReconnect() {
    this.teardown();
    if (!this.wanted) return;
    useApp.getState().setConnection("reconnecting");
    const delay = Math.min(30_000, 500 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

export const gateway = new Gateway();

// Reconnect quickly when the network comes back.
window.addEventListener("online", () => {
  if (useAuth.getState().token) {
    gateway.stop();
    gateway.start();
  }
});
