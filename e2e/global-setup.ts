import type { FullConfig } from "@playwright/test";

/**
 * The pages the specs open, compiled once here in order: a fresh dev server compiles each route on its
 * first request, and four workers asking at once would spend their navigation timeouts on it. None of
 * these GETs previews or runs (/ask has no ?q=); the two bad ids compile /run/[id] and /r/[id] and
 * answer 404.
 */
const WARM_UP = [
  "/",
  "/ask",
  "/briefs",
  "/how-it-works",
  "/method",
  "/status",
  "/d",
  "/dev/ask",
  "/dev/brief?sample=brand-health",
  "/dev/brief?job=brand_health",
  "/dev/brief?job=site_selection",
  "/dev/working?state=start",
  "/dev/ui",
  "/dev/figures",
  "/run/smoke-warm-up",
  "/r/smoke-warm-up",
] as const;

/** Long enough for a cold compile of the brief page with its chart and map chunks. */
const WARM_UP_TIMEOUT_MS = 180_000;

/**
 * Fails the smoke at once, with what to do, when no server answers at the base URL, or it answers but is
 * not ready for another reason than its database: the smoke never starts one. Then warms the routes.
 * Health and the pages are read only; no Qloo or model call.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL;
  if (!base) throw new Error("playwright.config.ts sets no baseURL");
  const health = new URL("/api/health", base).toString();
  let res: Response;
  try {
    res = await fetch(health, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`No server answers at ${base}. Start the dev server first (pnpm dev), or point SMOKE_BASE_URL at one.`, { cause: err });
  }
  if (!res.ok) {
    // 503 with the database down is a server that still serves every page and the dev samples: the specs
    // that need a stored run skip with that reason. Any other answer is a server that is not ready.
    const body = (await res.json().catch(() => null)) as { db?: { ok?: boolean } } | null;
    if (res.status !== 503 || body?.db?.ok !== false) throw new Error(`${health} answered ${res.status}: the server is up but not ready.`);
    console.warn(`${health}: the database is not reachable; the test run and its permalink will skip (pnpm db:up).`);
  }

  for (const path of WARM_UP) {
    // The status is the specs' to check, with a better message; only a server that stops answering fails here.
    try {
      const page = await fetch(new URL(path, base), { signal: AbortSignal.timeout(WARM_UP_TIMEOUT_MS) });
      await page.arrayBuffer();
    } catch (err) {
      throw new Error(`${path} did not answer within ${WARM_UP_TIMEOUT_MS / 1000} s while warming up.`, { cause: err });
    }
  }
}
