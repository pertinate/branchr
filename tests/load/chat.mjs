// Chat throughput: N users in one guild, all on the gateway; each sends a burst of PER
// messages (mixing @user, @here and plain). Measures send latency and fan-out.
//   node chat.mjs http://host:8080          (USERS=50 PER=10 MENTIONS=1)
const BASE = process.argv[2] ?? "http://localhost:8080";
const N = +(process.env.USERS ?? 50), PER = +(process.env.PER ?? 10), MENTIONS = process.env.MENTIONS !== "0";
const run = Date.now().toString(36);
async function api(method, path, token, body) {
  for (;;) {
    const r = await fetch(BASE + "/api" + path, { method, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 200)); continue; }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }
}
const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1);
const users = [];
for (let i = 0; i < N; i++) users.push({ name: `b${i}_${run}`, ...(await api("POST", "/auth/register", null, { username: `b${i}_${run}`, password: "correct horse battery", displayName: `B${i}` })) });
const created = await api("POST", "/guilds", users[0].token, { name: "bench" }); const g = created.guild ?? created;
const inv = await api("POST", `/guilds/${g.id}/invites`, users[0].token);
for (const u of users.slice(1)) await api("POST", `/invites/${inv.code}`, u.token);
// Gateway sessions.
const sent = new Map(); const delivery = []; let delivered = 0; let channel;
await Promise.all(users.map((u) => new Promise((res) => {
  const ws = new WebSocket(BASE.replace("http", "ws") + "/gateway");
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.t === "HELLO") ws.send(JSON.stringify({ op: "identify", d: { token: u.token } }));
    else if (ev.t === "READY") { channel ??= ev.d.guilds.find((x) => x.guild.id === g.id).channels.find((c) => c.kind === "text").id; res(); }
    else if (ev.t === "MESSAGE_CREATE") { const t0 = sent.get(ev.d.nonce); if (t0) delivery.push(performance.now() - t0); delivered++; }
  };
  u.ws = ws;
})));
const sendLat = []; const t0 = performance.now();
await Promise.all(users.map(async (u, i) => {
  for (let k = 0; k < PER; k++) {
    const nonce = `${i}-${k}`;
    const other = users[(i + k + 1) % N].name;
    const content = MENTIONS ? (k % 10 === 9 ? `@here round ${k}` : k % 2 ? `hey @${other} look at this` : `plain message ${k}`) : `plain message ${k} from ${i}`;
    const s = performance.now(); sent.set(nonce, s);
    await api("POST", `/channels/${channel}/messages`, u.token, { content, nonce });
    sendLat.push(performance.now() - s);
  }
}));
const want = N * PER * N;
while (delivered < want && performance.now() - t0 < 30000) await new Promise((s) => setTimeout(s, 20));
const secs = (performance.now() - t0) / 1000;
console.log(JSON.stringify({ mentions: MENTIONS, users: N, messages: N * PER, secs: secs.toFixed(2), msgsPerSec: (N * PER / secs).toFixed(0), deliveries: `${delivered}/${want}`, deliveriesPerSec: (delivered / secs).toFixed(0), sendMs: { p50: pct(sendLat, 0.5), p99: pct(sendLat, 0.99) }, fanoutMs: { p50: pct(delivery, 0.5), p99: pct(delivery, 0.99) } }));
for (const u of users) u.ws.close();
process.exit(0);
