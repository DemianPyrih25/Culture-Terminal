import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/**
 * The visitor's address (SPEC §10.3). With CLIENT_IP_HEADER set (e.g. cf-connecting-ip on Render,
 * whose Cloudflare edge overwrites it), that header's first value; else the right-most
 * X-Forwarded-For entry, which the host's edge appends, so a visitor cannot choose it by sending the
 * header themselves. GET /api/admin/ip shows what the host sends. Null without one (local dev,
 * tests), where no per-visitor limit applies.
 */
export function clientIp(request: Request | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const header = env.CLIENT_IP_HEADER?.trim().toLowerCase() ?? "";
  if (header !== "") {
    const first = request?.headers.get(header)?.split(",")[0]?.trim() ?? "";
    return first === "" ? null : first;
  }
  const entries = request?.headers.get("x-forwarded-for")?.split(",") ?? [];
  const last = entries.at(-1)?.trim() ?? "";
  return last === "" ? null : last;
}

/** The key clientKey signs with: from IP_HASH_SALT, else made at startup (the keys then change on a restart). */
export function clientKeySecret(salt: string | null | undefined): Buffer {
  const trimmed = salt?.trim() ?? "";
  return trimmed !== "" ? createHash("sha256").update(`ct-ip|${trimmed}`).digest() : randomBytes(32);
}

/** An IPv6 address (net.isIPv6, zone id removed) as its 8 groups. */
function ipv6Groups(ip: string): number[] {
  let text = ip;
  let tail: number[] = [];
  // A dotted IPv4 tail (::ffff:203.0.113.9) is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    tail = [(a << 8) | b, (c << 8) | d];
    text = text.slice(0, dotted.index);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const [head = "", rest] = text.split("::");
  if (rest === undefined) return [...groups(head), ...tail];
  const before = groups(head);
  const after = [...groups(rest), ...tail];
  return [...before, ...Array<number>(Math.max(0, 8 - before.length - after.length)).fill(0), ...after];
}

/**
 * The part of an address that names one visitor: an IPv4 address as it is (an IPv4-mapped IPv6
 * address as its IPv4), an IPv6 address as its /64, which one subscriber holds whole and can rotate
 * through at will. Anything else, as given.
 */
export function visitorAddress(ip: string): string {
  const bare = ip.trim().toLowerCase();
  if (isIPv4(bare)) return bare;
  const address = bare.split("%")[0] ?? "";
  if (!isIPv6(address)) return bare;
  const g = ipv6Groups(address);
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    const [hi = 0, lo = 0] = g.slice(6);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
}

/**
 * The visitor as its runs record it (runs.ip_hash) and the per-visitor limits count it: an HMAC of
 * its visitorAddress, so no address is kept or logged. Null without an address.
 */
export function clientKey(request: Request | undefined, secret: Buffer): string | null {
  const ip = clientIp(request);
  return ip === null ? null : createHmac("sha256", secret).update(visitorAddress(ip)).digest("base64url").slice(0, 22);
}
