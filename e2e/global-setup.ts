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
  "/following",
  "/screener",
  "/dev/ask",
  "/dev/brief?sample=brand-health",
  "/dev/brief?job=brand_health",
  "/dev/brief?job=site_selection",
  "/dev/brief?job=tenant_mix",
  "/dev/brief?job=area_profile",
  "/dev/working?state=start",
  "/dev/ui",
  "/dev/figures",
  "/run/smoke-warm-up",
  "/r/smoke-warm-up",
] as const;

/** The parts of GET /api/health the setup reads. */
interface HealthBody {
  db?: { ok?: boolean };
  qloo?: { env?: string } | null;
  llm?: { configured?: boolean };
}

/** Long enough for a cold compile of the brief page with its chart and map chunks. */
const WARM_UP_TIMEOUT_MS = 180_000;

/**
 * Fails the smoke at once, with what to do, when no server answers at the base URL, or it answers but is
 * not ready for another reason than its database. Warns when the server has live keys: the spend guard
 * still blocks every preview, run and screen a page sends, and the specs that would call Qloo another way
 * skip (support.ts liveServer). Then warms the routes. Health and the pages are read only; no Qloo or
 * model call.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const base = config.projects[0]?.use.baseURL;
  if (!base) throw new Error("playwright.config.ts sets no baseURL");
  const health = new URL("/api/health", base).toString();
  let res: Response;
  try {
    res = await fetch(health, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`No server answers at ${base}. Run the smoke without SMOKE_BASE_URL to let it start a mock dev server, or start that server first.`, { cause: err });
  }
  const body = (await res.json().catch(() => null)) as HealthBody | null;
  if (!res.ok) {
    // 503 with the database down is a server that still serves every page and the dev samples: the specs
    // that need a stored run skip with that reason. Any other answer is a server that is not ready.
    if (res.status !== 503 || body?.db?.ok !== false) throw new Error(`${health} answered ${res.status}: the server is up but not ready.`);
    console.warn(`${health}: the database is not reachable; the test run and its permalink will skip (pnpm db:up).`);
  }
  if (body?.qloo?.env !== "mock" || body.llm?.configured !== false) {
    console.warn(
      `${base} is not a mock server (Qloo ${body?.qloo?.env ?? "unknown"}, model ${body?.llm?.configured === false ? "off" : "configured"}): ` +
        "the profile and the screener API checks will skip. Let the smoke start its own server (no SMOKE_BASE_URL) to run them.",
    );
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
