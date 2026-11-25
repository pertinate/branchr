export const dynamic = "force-dynamic";

/** Runtime settings for the web app: the hub it opens unless told otherwise. */
export function GET() {
  const config = { defaultHub: process.env.DEFAULT_HUB ?? "" };
  return new Response(`window.__BRANCHR__ = ${JSON.stringify(config)};\n`, {
    headers: { "content-type": "text/javascript", "cache-control": "no-cache" },
  });
}
