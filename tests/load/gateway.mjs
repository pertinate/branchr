// Gateway fan-out load test: N sessions in one guild, measure MESSAGE_CREATE delivery latency.
//   node gateway.mjs http://host:8740 5000
const [base = "http://localhost:8080", nArg = "1000"] = process.argv.slice(2);
const N = Number(nArg);
const ws = base.replace(/^http/, "ws") + "/gateway";
const api = (path, token, body) =>
  fetch(`${base}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

const name = `load_${Date.now().toString(36)}`;
const { token } = await api("/auth/register", null, { username: name, password: "load test password" });
const g = await api("/guilds", token, { name: "Load Test" });
const channel = g.channels.find((c) => c.kind === "text").id;

let ready = 0;
const pending = new Map(); // nonce -> {sent, got}
const clients = [];
const t0 = performance.now();
await new Promise((resolve) => {
  for (let i = 0; i < N; i++) {
    const s = new WebSocket(ws);
    s.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "HELLO") s.send(JSON.stringify({ op: "identify", d: { token } }));
      else if (m.t === "READY" && ++ready === N) resolve();
      else if (m.t === "MESSAGE_CREATE") {
        const p = pending.get(m.d.content);
        if (p) p.lat.push(performance.now() - p.sent);
      }
    };
    s.onerror = () => {};
    clients.push(s);
  }
});
console.log(`${N} sessions identified in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

for (let round = 0; round < 5; round++) {
  const content = `ping ${round}`;
  const p = { sent: performance.now(), lat: [] };
  pending.set(content, p);
  await api(`/channels/${channel}/messages`, token, { content });
  const deadline = performance.now() + 15000;
  while (p.lat.length < N && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  p.lat.sort((a, b) => a - b);
  const q = (x) => p.lat[Math.min(p.lat.length - 1, Math.floor(p.lat.length * x))].toFixed(1);
  console.log(`round ${round}: delivered ${p.lat.length}/${N}  p50 ${q(0.5)}ms  p99 ${q(0.99)}ms  max ${q(1)}ms`);
  await new Promise((r) => setTimeout(r, 300));
}
for (const c of clients) c.close();
process.exit(0);
