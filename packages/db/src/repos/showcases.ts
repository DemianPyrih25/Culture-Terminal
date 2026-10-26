import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Queryable } from "../client";
import { qlooCache, qlooCalls, type Run, type RunStatus, runs, type ShowcasePinRow, showcasePins } from "../schema";
import { lockRun } from "./runs";

/**
 * Curated showcases (PLAN §9, SPEC §9): which stored run each config/showcases.json slug opens, and the
 * entities each showcase pins (showcase_pins). A slug has at most one pinned run; entity ids live only
 * here, never in git (D29).
 */

/** A slug as config/showcases.json writes them: lower-case words joined by hyphens. */
export const SHOWCASE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function checkSlug(what: string, slug: string): void {
  if (!SHOWCASE_SLUG.test(slug)) throw new RangeError(`${what}: not a showcase slug: "${slug}"`);
}

/** Serialises every pin and unpin of one slug until the transaction ends, so a slug never ends up with two runs. */
async function lockSlug(tx: Queryable, slug: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`showcase:${slug}`}, 0))`);
}

/** A pinned showcase: the run a slug opens. */
export interface PinnedShowcase {
  slug: string;
  /** Position on the launchpad (the config order), or null. */
  order: number | null;
  runId: string;
  question: string;
  status: RunStatus;
  createdAt: Date;
  parentRunId: string | null;
}

const PINNED = {
  slug: runs.showcaseSlug,
  order: runs.showcaseOrder,
  runId: runs.id,
  question: runs.question,
  status: runs.status,
  createdAt: runs.createdAt,
  parentRunId: runs.parentRunId,
};

type PinnedRow = Omit<PinnedShowcase, "slug"> & { slug: string | null };

/** is_showcase rows always carry a slug (pinShowcaseRun writes both); a row without one is not listed. */
const withSlug = (rows: PinnedRow[]): PinnedShowcase[] => rows.flatMap((r) => (r.slug === null ? [] : [{ ...r, slug: r.slug }]));

/** Every pinned showcase, in launchpad order, then by slug. */
export async function listPinnedShowcases(db: Queryable): Promise<PinnedShowcase[]> {
  const rows = await db
    .select(PINNED)
    .from(runs)
    .where(eq(runs.isShowcase, true))
    .orderBy(sql`${runs.showcaseOrder} asc nulls last`, asc(runs.showcaseSlug), desc(runs.createdAt));
  return withSlug(rows);
}

/** The run the slug opens, or undefined when none is pinned. */
export async function getPinnedShowcase(db: Queryable, slug: string): Promise<PinnedShowcase | undefined> {
  const rows = await db
    .select(PINNED)
    .from(runs)
    .where(and(eq(runs.isShowcase, true), eq(runs.showcaseSlug, slug)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return withSlug(rows)[0];
}

export interface PinShowcaseInput {
  slug: string;
  runId: string;
  /** Position on the launchpad (the config order), or null. */
  order: number | null;
  /**
   * A new question_hash, for a run a dev tool stored under its own prefix that becomes a web agent run
   * (showcase prewarm adopts the run it recorded). Omitted keeps the run's own.
   */
  questionHash?: string;
}

export interface PinShowcaseResult {
  /** The run as pinned. */
  run: Run;
  /** Runs that held the slug before and no longer do. */
  replaced: string[];
  /** The slug the run was pinned under before, when it was another one; that slug is left without a run. */
  movedFrom: string | null;
}

/**
 * Checks the run before it is pinned, inside the pinning transaction with the run's row locked; a throw
 * aborts the pin and propagates. `tx` reads within the same transaction (e.g. a chain's parent runs).
 */
export type PinVerifier = (run: Run, tx: Queryable) => void | Promise<void>;

/**
 * Pins the run as the slug's showcase (is_showcase, showcase_slug, showcase_order) and unpins any
 * other run that held the slug, in one transaction. Returns undefined when the run does not exist.
 */
export async function pinShowcaseRun(db: Queryable, input: PinShowcaseInput, verify?: PinVerifier): Promise<PinShowcaseResult | undefined> {
  const { slug, runId, order, questionHash } = input;
  checkSlug("pinShowcaseRun", slug);
  if (order !== null && (!Number.isInteger(order) || order < 1 || order > 2_147_483_647)) {
    throw new RangeError(`pinShowcaseRun: order must be a positive int4 or null, got ${order}`);
  }
  if (questionHash !== undefined && questionHash.trim() === "") throw new RangeError("pinShowcaseRun: questionHash must not be empty");
  return db.transaction(async (tx) => {
    // The slug before the run, in every transaction that takes both, so two pins never wait on each other.
    await lockSlug(tx, slug);
    const before = await lockRun(tx, runId);
    if (!before) return undefined;
    await verify?.(before, tx);
    const cleared = await tx
      .update(runs)
      .set({ isShowcase: false, showcaseSlug: null, showcaseOrder: null, updatedAt: sql`now()` })
      .where(and(eq(runs.showcaseSlug, slug), ne(runs.id, runId)))
      .returning({ id: runs.id });
    const [run] = await tx
      .update(runs)
      .set({ isShowcase: true, showcaseSlug: slug, showcaseOrder: order, ...(questionHash !== undefined ? { questionHash } : {}), updatedAt: sql`now()` })
      .where(eq(runs.id, runId))
      .returning();
    if (!run) throw new Error(`pinShowcaseRun: run ${runId} vanished while locked`);
    const movedFrom = before.isShowcase && before.showcaseSlug !== null && before.showcaseSlug !== slug ? before.showcaseSlug : null;
    return { run, replaced: cleared.map((r) => r.id), movedFrom };
  });
}

/** What pinRunCacheEntries found and pinned. */
export interface PinnedCacheEntries {
  /** Distinct cache keys in the run's call log. */
  keys: number;
  /** Cached rows pinned; a key whose row is gone (never stored, or deleted) is not counted. */
  pinned: number;
}

/**
 * Pins every cached Qloo answer the run used (the cache keys in its qloo_calls rows), so none of them
 * expires (D25) and a live re-run of the showcase is answered from the cache. Unpinning a showcase
 * leaves them pinned: another showcase may share a key.
 */
export async function pinRunCacheEntries(db: Queryable, runId: string): Promise<PinnedCacheEntries> {
  const logged = await db
    .selectDistinct({ key: qlooCalls.cacheKey })
    .from(qlooCalls)
    .where(and(eq(qlooCalls.runId, runId), isNotNull(qlooCalls.cacheKey)));
  const keys = logged.flatMap((r) => (r.key === null ? [] : [r.key]));
  let pinned = 0;
  // A run makes tens of calls; chunks keep a statement's bind parameters far below Postgres' cap.
  for (let i = 0; i < keys.length; i += 1000) {
    const rows = await db
      .update(qlooCache)
      .set({ pinned: true, expiresAt: null })
      .where(inArray(qlooCache.key, keys.slice(i, i + 1000)))
      .returning({ key: qlooCache.key });
    pinned += rows.length;
  }
  return { keys: keys.length, pinned };
}

/** Unpins whatever run the slug opens. Returns the ids of the runs unpinned (none when nothing was pinned). */
export async function unpinShowcase(db: Queryable, slug: string): Promise<string[]> {
  checkSlug("unpinShowcase", slug);
  return db.transaction(async (tx) => {
    await lockSlug(tx, slug);
    const rows = await tx
      .update(runs)
      .set({ isShowcase: false, showcaseSlug: null, showcaseOrder: null, updatedAt: sql`now()` })
      .where(eq(runs.showcaseSlug, slug))
      .returning({ id: runs.id });
    return rows.map((r) => r.id);
  });
}

// Pinned entities (showcase_pins) ---------------------------------------------------------------------

/** One mention of a showcase question and the Qloo entity it resolves to. */
export interface ShowcasePinInput {
  /** The mention as the question names it, e.g. "Brand Alpha". */
  mention: string;
  entityId: string;
  /** The entity's name in Qloo. */
  name: string;
  /** Its entity type (contracts EntityType). */
  type: string;
}

/**
 * Replaces the slug's pins with these, in one transaction: a pin not listed is removed. Returns how
 * many were stored. Mentions must be distinct and every field non-empty.
 */
export async function replaceShowcasePins(db: Queryable, slug: string, pins: readonly ShowcasePinInput[]): Promise<number> {
  checkSlug("replaceShowcasePins", slug);
  const seen = new Set<string>();
  const rows = pins.map((p) => {
    const row = { slug, mention: p.mention.trim(), entityId: p.entityId.trim(), name: p.name.trim(), type: p.type.trim() };
    if (row.mention === "" || row.entityId === "" || row.name === "" || row.type === "") {
      throw new RangeError(`replaceShowcasePins: every field of a pin must be non-empty (mention "${row.mention}")`);
    }
    if (seen.has(row.mention)) throw new RangeError(`replaceShowcasePins: mention "${row.mention}" is listed twice`);
    seen.add(row.mention);
    return row;
  });
  return db.transaction(async (tx) => {
    await lockSlug(tx, slug);
    await tx.delete(showcasePins).where(eq(showcasePins.slug, slug));
    if (rows.length === 0) return 0;
    const inserted = await tx.insert(showcasePins).values(rows).returning({ mention: showcasePins.mention });
    return inserted.length;
  });
}

/** The slug's pins, or every slug's when omitted, by slug then mention. */
export async function listShowcasePins(db: Queryable, slug?: string): Promise<ShowcasePinRow[]> {
  const query = db.select().from(showcasePins);
  const filtered = slug === undefined ? query : query.where(eq(showcasePins.slug, slug));
  return filtered.orderBy(asc(showcasePins.slug), asc(showcasePins.mention));
}
