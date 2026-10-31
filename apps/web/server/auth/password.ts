import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Passwords are hashed with scrypt (node:crypto), a per-password random salt, and stored as
// "scrypt$N$r$p$salt$hash" with base64url salt and hash, so the cost can be raised later and old
// hashes still verify.

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
// Room for N up to 2^17 at r=8 (128 * N * r bytes), plus slack.
const MAX_MEM = 256 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyLen, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** True when the password matches the stored hash. A malformed hash never matches. Constant-time compare. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (!n || !r || !p || !Number.isInteger(n) || n < 2 || n > 131072 || (n & (n - 1)) !== 0 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  let key: Buffer;
  try {
    key = await derive(password, salt, n, r, p, expected.length);
  } catch {
    return false;
  }
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash of a random password, verified against when the email is unknown so both paths take the same time. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(18).toString("base64url")));
}
