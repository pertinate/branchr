import "server-only";

const env = (k: string) => process.env[k] || undefined;

/** Read per call, so a build never needs the secrets. */
export function config() {
  const publicUrl = (env("PUBLIC_URL") ?? "https://branchr.us").replace(/\/+$/, "");
  return {
    /** Where this service is reached: the tokens' issuer and the base of the Discord redirect. */
    publicUrl,
    discordClientId: env("DISCORD_CLIENT_ID"),
    discordClientSecret: env("DISCORD_CLIENT_SECRET"),
    // Overridable so tests can stand in for Discord.
    discordApi: env("DISCORD_API") ?? "https://discord.com/api",
    discordAuthorize: env("DISCORD_AUTHORIZE") ?? "https://discord.com/oauth2/authorize",
    /** Exact redirect URIs clients may ask for. */
    redirects: (env("ALLOWED_REDIRECTS") ?? `branchr://auth/callback,${publicUrl}/app/,${publicUrl}/account`)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    keyRotateDays: Number(env("KEY_ROTATE_DAYS") ?? 90),
  };
}
