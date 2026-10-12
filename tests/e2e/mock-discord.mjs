// Stands in for Discord's OAuth so branchr ID sign-in can be tested end to end.
// Authorizing approves at once, as the default user or one set with POST /next-user, or
// (without touching other tests running in parallel) as the user in the browser's
// `mock_discord_user` cookie, carried through the code and access token.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 18071);
const defaultUser = { id: "424242424242424242", username: "e2e_nelly", global_name: "E2E Nelly", avatar: null };
let user = defaultUser;

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/oauth2/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    const cookie = /(?:^|;\s*)mock_discord_user=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    back.searchParams.set("code", cookie ? `u.${Buffer.from(decodeURIComponent(cookie)).toString("base64url")}` : "good");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }).end();
  } else if (url.pathname === "/api/oauth2/token" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const code = new URLSearchParams(body).get("code") ?? "";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: code.startsWith("u.") ? code : "mock", token_type: "Bearer" }));
    });
  } else if (url.pathname === "/api/users/@me") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const who = token.startsWith("u.") ? { avatar: null, ...JSON.parse(Buffer.from(token.slice(2), "base64url").toString()) } : user;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(who));
  } else if (url.pathname === "/next-user" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      user = body ? { avatar: null, ...JSON.parse(body) } : defaultUser;
      res.end("ok");
    });
  } else if (url.pathname === "/health") {
    res.end("ok");
  } else {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1");
