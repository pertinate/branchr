const EPOCH = 1_735_689_600_000;

/** Milliseconds since unix epoch encoded in a snowflake id. */
export function snowflakeTime(id: string): number {
  return Number(BigInt(id) >> 22n) + EPOCH;
}

export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function nonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
