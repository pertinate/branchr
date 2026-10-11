const KEY = "lastChannel";

export function rememberChannel(guildId: string, channelId: string) {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    m[guildId] = channelId;
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

export function lastChannel(guildId: string): string | undefined {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}")[guildId];
  } catch {
    return undefined;
  }
}
