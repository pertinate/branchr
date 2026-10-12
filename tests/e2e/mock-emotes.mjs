// Stands in for 7TV, FrankerFaceZ and BetterTTV so emote tests don't depend on public APIs.
// The API reaches it through EMOTE_PROVIDERS_URL; browsers get CDN images from helpers.ts.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8072);
const file = (name, width, height) => ({ name, width, height });
const stv = [
  { id: "01GB2S7R7N000A5SMX0Q1Z2C8V", name: "catJAM", animated: true, host: { files: [file("1x.webp", 28, 28)] }, owner: { display_name: "e2e" } },
  { id: "01F6MQ5ZCR0009BYV1JEZD7JK8", name: "OMEGALUL", animated: false, host: { files: [file("1x.webp", 32, 32)] }, owner: { username: "e2e" } },
];
const ffz = [{ id: 128054, name: "OMEGALUL", width: 32, height: 32, owner: { display_name: "e2e" } }];

/** A WebP header (VP8X, animated, 28x28): enough for the server to read size and animation. */
function webp() {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0);
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8);
  b.write("VP8X", 12);
  b.writeUInt32LE(10, 16);
  b[20] = 0x02;
  b.writeUIntLE(27, 24, 3);
  b.writeUIntLE(27, 27, 3);
  return b;
}

const json = (res, v, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
const matches = (name, q) => name.toLowerCase().includes(String(q ?? "").toLowerCase());

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const p = url.pathname;
  if (p === "/7tv/gql" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body || "{}").variables?.q;
      json(res, { data: { emotes: { items: stv.filter((e) => matches(e.name, q)) } } });
    });
    return;
  }
  let m;
  if ((m = p.match(/^\/7tv\/emotes\/(\w+)$/))) {
    const e = stv.find((x) => x.id === m[1]);
    return e ? json(res, e) : json(res, { error: "not found" }, 404);
  }
  if (p === "/ffz/emotes") return json(res, { emoticons: ffz.filter((e) => matches(e.name, url.searchParams.get("q"))) });
  if ((m = p.match(/^\/ffz\/emote\/(\d+)$/))) {
    const e = ffz.find((x) => String(x.id) === m[1]);
    return e ? json(res, { emote: e }) : json(res, { error: "not found" }, 404);
  }
  if (/^\/bttv-cdn\/\w+\/1x\.webp$/.test(p)) return res.writeHead(200, { "content-type": "image/webp" }).end(webp());
  if (p === "/health") return res.end("ok");
  res.writeHead(404).end();
}).listen(port, "127.0.0.1");
