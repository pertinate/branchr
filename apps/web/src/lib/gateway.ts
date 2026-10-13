import type { ClientOp, ServerEvent } from "@app/protocol";

import { toast } from "sonner";

import { gatewayUrl } from "@/lib/api";
import { type Instance, activeInstance, instances } from "@/lib/instances";
import { shownStatus, useMyStatus } from "@/stores/ui";

type Listener = (ev: ServerEvent) => void;

/** One instance's gateway connection, with heartbeats and exponential-backoff reconnects. */
export class Gateway {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private wanted = false;
  private awaitingAck = false;
  private listeners = new Set<Listener>();

  constructor(private inst: Instance) {}

  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.inst.app.getState().setConnection("idle");
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
    const { serverUrl, token } = this.inst.auth.getState();
    if (!token) return;
    this.inst.app.getState().setConnection(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(gatewayUrl(serverUrl));
    this.ws = ws;
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data) as ServerEvent;
      switch (ev.t) {
        case "HELLO":
          {
            const s = useMyStatus.getState();
            this.send({ op: "identify", d: { token, status: shownStatus(s), custom: s.custom || null } });
          }
          this.startHeartbeat(ev.d.heartbeatIntervalMs);
          return;
        case "HEARTBEAT_ACK":
          this.awaitingAck = false;
          return;
        case "INVALID_SESSION":
          this.wanted = false;
          toast.error(`Logged out of ${new URL(serverUrl).host}`, { description: "Your session there ended. Log in again to reconnect." });
          this.inst.auth.getState().logout();
          return;
        case "READY":
          this.attempts = 0;
          // Messages may have been missed while disconnected; reload lazily on view.
          this.inst.messages.setState({ channels: {} });
          break;
      }
      this.inst.app.getState().apply(ev);
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
    this.inst.app.getState().setConnection("reconnecting");
    const delay = Math.min(30_000, 500 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

/** The active instance's gateway (the one on screen). */
export const gateway = {
  send: (op: ClientOp) => activeInstance().gateway.send(op),
};

// Reconnect quickly when the network comes back.
window.addEventListener("online", () => {
  for (const i of instances()) {
    if (!i.auth.getState().token) continue;
    i.gateway.stop();
    i.gateway.start();
  }
});
