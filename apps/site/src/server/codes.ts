//! Codes people read off a log or a page and type: no 0/O or 1/I/L.
import "server-only";

import { createHash, randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const hash = (s: string) => createHash("sha256").update(s).digest();

const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

/** `XXXX-XXXX`, shown by a hub for its owner to enter. */
export const claimCode = () => `${group()}-${group()}`;

/** Case, spaces and the dash don't matter. */
export function normalizeClaimCode(code: string): string {
  const c = code.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** `BRS-XXXX-XXXX-XXXX-XXXX`: long enough not to guess. */
export const setupCode = () => `BRS-${group()}-${group()}-${group()}-${group()}`;
