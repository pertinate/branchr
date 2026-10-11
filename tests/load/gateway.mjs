// Gateway fan-out load test: N sessions in one guild, measure MESSAGE_CREATE delivery latency.
//   node gateway.mjs https://host 5000          (RAMP=connections per 100ms, default 250)
const [base = "http://localhost:8080", nArg = "1000"] = process.argv.slice(2);
const N = Number(nArg);
const RAMP = Number(process.env.RAMP) || 250;
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
let failed = 0;
const errors = new Map();
const pending = new Map(); // content -> {sent, lat}
const clients = [];
const t0 = performance.now();
await new Promise((resolve) => {
  const done = () => ready + failed >= N && resolve();
  setTimeout(resolve, 120_000);
  let i = 0;
  // Ramp up in batches like real users arriving, not one N-connection burst.
  const batch = () => {
    for (let b = 0; b < RAMP && i < N; b++, i++) {
      const s = new WebSocket(ws);
      let identified = false;
      s.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === "HELLO") s.send(JSON.stringify({ op: "identify", d: { token } }));
        else if (m.t === "READY") {
          identified = true;
          ready++;
          done();
        } else if (m.t === "MESSAGE_CREATE") {
          const p = pending.get(m.d.content);
          if (p) p.lat.push(performance.now() - p.sent);
        }
      };
      s.onclose = (e) => {
        if (!identified) {
          failed++;
          errors.set(e.code, (errors.get(e.code) ?? 0) + 1);
          done();
        }
      };
      clients.push(s);
    }
    if (i < N) setTimeout(batch, 100);
  };
  batch();
});
console.log(`${ready}/${N} sessions identified in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (failed) console.log(`connect failures: ${failed} (close codes ${JSON.stringify(Object.fromEntries(errors))})`);

for (let round = 0; round < 5; round++) {
  const content = `ping ${round}`;
  const p = { sent: performance.now(), lat: [] };
  pending.set(content, p);
  await api(`/channels/${channel}/messages`, token, { content });
  const deadline = performance.now() + 15000;
  while (p.lat.length < ready && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  p.lat.sort((a, b) => a - b);
  const q = (x) => (p.lat.length ? p.lat[Math.min(p.lat.length - 1, Math.floor(p.lat.length * x))].toFixed(1) : "n/a");
  console.log(`round ${round}: delivered ${p.lat.length}/${ready}  p50 ${q(0.5)}ms  p99 ${q(0.99)}ms  max ${q(1)}ms`);
  await new Promise((r) => setTimeout(r, 300));
}
for (const c of clients) c.close();
process.exit(0);
