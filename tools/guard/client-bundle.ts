// Secrets in the client bundle (PLAN §10.2, §10.3). Everything under .next/static is public, so
// a server-only variable name there means server code was bundled for the browser, and a UUID-shaped
// id there may be a Qloo entity id, which stays on the server (R8, D51).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isBinary, scanWithRules, type Finding, type TextRule } from "./finding";
import type { ScanResult } from "./no-qloo-data";

export const SERVER_ONLY_ENV = [
  "QLOO_API_KEY",
  "ANTHROPIC_API_KEY",
  "DATABASE_URL",
  "TURNSTILE_SECRET_KEY",
  "SESSION_HMAC_SECRET",
  "IP_HASH_SALT",
  "ADMIN_TOKEN",
  "JUDGE_CODE",
  "SEC_USER_AGENT",
  "CENSUS_API_KEY",
  "OSM_USER_AGENT",
] as const;

/**
 * UUID-shaped ids that are never Qloo entity ids: the nil and max UUIDs libraries carry as constants.
 * Anything else UUID-shaped in the client bundle is treated as a possible entity id (R8, D51).
 */
const uuidOf = (digit: string): string => [8, 4, 4, 4, 12].map((n) => digit.repeat(n)).join("-");
const NON_ENTITY_UUIDS: ReadonlySet<string> = new Set([uuidOf("0"), uuidOf("f")]);

const RULES: readonly TextRule[] = [
  {
    id: "bundle-secret",
    pattern: /sk-ant-/g,
    message: "Anthropic key prefix in the client bundle",
  },
  {
    id: "bundle-secret",
    // The ledger's "copy as curl" shows the shell placeholder $QLOO_API_KEY (PLAN §5.1), so a name
    // directly after `$` or `${` is a placeholder, not a leak.
    pattern: new RegExp(`(?<![\\w$])(?<!\\$\\{)(?:${SERVER_ONLY_ENV.join("|")})(?!\\w)`, "g"),
    message: "server-only environment variable name in the client bundle",
  },
  {
    id: "bundle-secret",
    pattern: /postgres(?:ql)?:\/\//gi,
    message: "Postgres connection string in the client bundle",
  },
  {
    id: "bundle-secret",
    pattern: /x-api-key["'`]?[ \t]*[:=,][ \t]*["'`]?([A-Za-z0-9_-]{12,})/gi,
    message: "X-Api-Key header with a literal value in the client bundle",
    accept: (m) => /\d/.test(m[1] ?? ""),
  },
  {
    id: "bundle-entity-id",
    // R8 (D51): Qloo entity ids stay on the server, so none may be compiled into a page. A UUID inside a
    // URL path (a library's doc image link, ".../assets/<uuid>") is a link, not data.
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    message: "UUID-shaped id (a Qloo entity id?) in the client bundle",
    accept: (m, text) => !NON_ENTITY_UUIDS.has(m[0].toLowerCase()) && text[m.index - 1] !== "/",
  },
];

export function scanBundleText(file: string, text: string): Finding[] {
  return scanWithRules(file, text, RULES);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

/** Scans a built static directory. Paths in findings are relative to `root`. */
export function scanBundleDir(dir: string, root: string): ScanResult {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDir) throw new Error(`bundle directory not found: ${dir} (run \`pnpm build\` first)`);

  const files = walk(dir);
  const findings: Finding[] = [];
  for (const full of files) {
    const content = readFileSync(full);
    if (isBinary(content)) continue;
    const rel = path.relative(root, full).split(path.sep).join("/");
    findings.push(...scanBundleText(rel, content.toString("utf8")));
  }
  return { findings, scanned: files.length };
}
