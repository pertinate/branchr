// Stands in for 7TV, FrankerFaceZ and BetterTTV so emote tests don't depend on public APIs.
// The API reaches it through EMOTE_PROVIDERS_URL; browsers get CDN images from helpers.ts.
import { createServer } from "node:http";
import { crc32, deflateSync } from "node:zlib";

const port = Number(process.env.PORT ?? 18072);
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

/** A solid-colour PNG, decodable for real (link preview pictures get resized). */
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([88, 101, 242]))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A page with OpenGraph tags, for link previews. */
const page = `<!doctype html><html><head><title>Fallback</title>
<meta property="og:site_name" content="Mock Site">
<meta property="og:title" content="A page worth sharing">
<meta property="og:description" content="Everything you&#39;d want to know.">
<meta property="og:image" content="/preview/pic.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#3ba55c">
</head><body>hi</body></html>`;

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
  if (p === "/preview/page") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  if (p === "/preview/pic.png") return res.writeHead(200, { "content-type": "image/png" }).end(png(640, 360));
  if (p === "/health") return res.end("ok");
  res.writeHead(404).end();
}).listen(port, "127.0.0.1");
