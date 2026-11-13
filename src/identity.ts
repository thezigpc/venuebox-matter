import { randomInt } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJson } from "./store.js";

/**
 * The node's onboarding secret: setup passcode and discriminator. Generated once and kept in
 * /data. Never log or report the passcode on its own; only the QR / manual code while pairing
 * is open.
 */
export interface Identity {
  passcode: number;
  discriminator: number;
}

/** Matter Core spec 5.1.7.1: passcodes that SHALL NOT be used (plus 20202021, the SDK default). */
const FORBIDDEN = new Set([
  0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999,
  12345678, 87654321, 20202021,
]);

export function isAllowedPasscode(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 99999998 && !FORBIDDEN.has(p);
}

export function randomPasscode(rand: (min: number, max: number) => number = randomInt): number {
  for (;;) {
    const p = rand(1, 99999999); // [1, 99999998]
    if (isAllowedPasscode(p)) return p;
  }
}

export function randomDiscriminator(rand: (min: number, max: number) => number = randomInt): number {
  return rand(0, 4096); // 12 bits
}

export function newIdentity(): Identity {
  return { passcode: randomPasscode(), discriminator: randomDiscriminator() };
}

const file = (dataDir: string) => join(dataDir, "identity.json");

/** Loads the identity from /data, creating it on first start. */
export function loadIdentity(dataDir: string): Identity {
  const stored = readJson<Identity>(file(dataDir));
  if (
    stored &&
    isAllowedPasscode(stored.passcode) &&
    Number.isInteger(stored.discriminator) &&
    stored.discriminator >= 0 &&
    stored.discriminator < 4096
  ) {
    return stored;
  }
  const id = newIdentity();
  writeJson(file(dataDir), id);
  return id;
}

/** A factory reset: a brand-new passcode and discriminator. */
export function resetIdentity(dataDir: string): Identity {
  const id = newIdentity();
  writeJson(file(dataDir), id);
  return id;
}
