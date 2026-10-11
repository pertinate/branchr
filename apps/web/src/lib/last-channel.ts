/** The channel last open in each server, per instance. */
const key = (instance: string) => `lastChannel:${instance}`;

export function rememberChannel(instance: string, guildId: string, channelId: string) {
  try {
    const m = JSON.parse(localStorage.getItem(key(instance)) ?? "{}");
    m[guildId] = channelId;
    localStorage.setItem(key(instance), JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

export function lastChannel(instance: string, guildId: string): string | undefined {
  try {
    return JSON.parse(localStorage.getItem(key(instance)) ?? "{}")[guildId];
  } catch {
    return undefined;
  }
}
