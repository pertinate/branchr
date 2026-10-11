// Stands in for Discord's OAuth so branchr ID sign-in can be tested end to end.
// Authorizing approves at once as one fixed user.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8071);
const user = { id: "424242424242424242", username: "e2e_nelly", global_name: "E2E Nelly", avatar: null };

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/oauth2/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "good");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }).end();
  } else if (url.pathname === "/api/oauth2/token" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "mock", token_type: "Bearer" }));
  } else if (url.pathname === "/api/users/@me") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(user));
  } else if (url.pathname === "/health") {
    res.end("ok");
  } else {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1");
