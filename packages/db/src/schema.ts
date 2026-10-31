// Postgres schema (PLAN §3.2, SPEC §3.2 "Persistence schema"). Postgres is the only store (D3).
// jsonb payloads are typed loosely here on purpose: @ct/contracts owns their shapes and callers
// validate with zod at the edges.
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const RUN_STATUSES = [
  "queued",
  "needs_input",
  "running",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "refused",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_MODES = ["live", "economy"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const RUN_LANES = ["public", "judge"] as const;
export type RunLane = (typeof RUN_LANES)[number];

/** What a visitor follows (PLAN Part 10, §2.4): a brand, a place or a question. Mirrors @ct/contracts FollowKind. */
export const FOLLOW_KINDS = ["brand", "place", "question"] as const;
export type FollowKindName = (typeof FOLLOW_KINDS)[number];

export const CACHE_STATUSES = ["hit", "miss", "stale", "coalesced", "reused"] as const;
export type CacheStatus = (typeof CACHE_STATUSES)[number];

/** Canonical (qloo_cache) or redacted (qloo_calls) query parameters, one string per key. */
export type QlooParams = Record<string, string>;

/** The public data sources (PLAN §5.2): SEC EDGAR, the US Census Bureau and OpenStreetMap (Overpass API). */
export const PUBLIC_SOURCES = ["sec", "census", "osm"] as const;
export type PublicSourceName = (typeof PUBLIC_SOURCES)[number];

/** Where an evidence bundle's data came from. */
export const EVIDENCE_SOURCES = ["qloo", ...PUBLIC_SOURCES] as const;
export type EvidenceSourceName = (typeof EVIDENCE_SOURCES)[number];

/** Canonical (public_cache) or redacted (public_calls) query parameters, never an API key. */
export type PublicParams = Record<string, string>;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

export const runs = pgTable(
  "runs",
  {
    // Caller may supply its own id (e.g. a short permalink id); otherwise the database assigns one.
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),

    question: text("question").notNull(),
    // Answer-cache key (D26): normalised question + pins + mode.
    questionHash: text("question_hash").notNull(),
    pillar: text("pillar"),
    job: text("job"),
    intent: jsonb("intent").$type<unknown>(),
    pins: jsonb("pins").$type<unknown>(),

    mode: text("mode").$type<RunMode>().notNull().default("live"),
    isShowcase: boolean("is_showcase").notNull().default(false),
    showcaseSlug: text("showcase_slug"),
    showcaseOrder: integer("showcase_order"),
    parentRunId: text("parent_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "set null",
    }),

    ipHash: text("ip_hash"),
    lane: text("lane").$type<RunLane>().notNull().default("public"),
    model: text("model"),
    effort: text("effort"),

    wallMs: integer("wall_ms"),
    llmUsd: doublePrecision("llm_usd").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    qlooNetwork: integer("qloo_network").notNull().default(0),
    qlooCached: integer("qloo_cached").notNull().default(0),

    report: jsonb("report").$type<unknown>(),
    validation: jsonb("validation").$type<unknown>(),
    ghost: jsonb("ghost").$type<unknown>(),
    // Full model transcript for debugging. Never served to clients.
    transcript: jsonb("transcript").$type<unknown>(),
    error: jsonb("error").$type<unknown>(),

    // Cancellation is a database flag polled by the run loop, so it survives across instances
    // and does not depend on in-memory state (SPEC §3.2).
    cancelRequestedAt: tstz("cancel_requested_at"),
    // When the run left the queue and started (markStarted). Null for a run that never started (queue
    // timeout, cancel or shutdown while queued): such runs count toward no visitor or global cap.
    startedAt: tstz("started_at"),
  },
  (t) => [
    check(
      "runs_status_check",
      sql`${t.status} IN (${sql.raw(RUN_STATUSES.map((s) => `'${s}'`).join(", "))})`,
    ),
    // Answer cache: latest run for a hash with a given status inside the window.
    index("runs_answer_cache_idx").on(t.questionHash, t.status, t.createdAt),
    index("runs_status_created_idx").on(t.status, t.createdAt),
    index("runs_ip_created_idx").on(t.ipHash, t.createdAt),
    index("runs_parent_idx").on(t.parentRunId),
    index("runs_showcase_idx").on(t.showcaseSlug, t.showcaseOrder).where(sql`${t.isShowcase}`),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: tstz("ts").notNull().defaultNow(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
  },
  // The primary key index serves SSE resume and replay reads (run_id = ? AND seq > ? ORDER BY seq).
  (t) => [primaryKey({ name: "run_events_pk", columns: [t.runId, t.seq] })],
);

/** E# evidence bundles: one skill call, one or more Qloo calls, or SEC or Census calls (one source per bundle). */
export const evidence = pgTable(
  "evidence",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
    skill: text("skill").notNull(),
    // qloo, sec or census; rows written before Part 9 are Qloo bundles.
    source: text("source").$type<EvidenceSourceName>().notNull().default("qloo"),
    purpose: text("purpose"),
    status: text("status"),
    qlooCallIds: textArray("qloo_call_ids"),
    cached: boolean("cached").notNull().default(false),
    requestIds: textArray("request_ids"),
    // Kit envelope: provenance.requests[{method, path, query}] (SPEC §5.1 Ledger).
    provenance: jsonb("provenance").$type<unknown>(),
    summary: text("summary"),
    flags: textArray("flags"),
    // Results the quality gate dropped before any metric was computed.
    qualityGateDrops: integer("quality_gate_drops").notNull().default(0),
  },
  (t) => [primaryKey({ name: "evidence_pk", columns: [t.runId, t.id] })],
);

/** M# metrics computed by QUANT. */
export const metrics = pgTable(
  "metrics",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    subjectRefs: textArray("subject_refs"),
    // Null when the metric is UNAVAILABLE.
    value: doublePrecision("value"),
    display: text("display"),
    unit: text("unit"),
    badge: text("badge").notNull(),
    formulaId: text("formula_id"),
    evidenceIds: textArray("evidence_ids"),
    n: integer("n"),
    conf: doublePrecision("conf"),
    // NoValueReason; set exactly when the badge is UNAVAILABLE.
    reason: text("reason"),
    // Comparator (CITY | PEERS | BASELINE | WITHIN_CALL), or null.
    comparator: text("comparator"),
    // TrendWindow {start, end} of a STALE metric (CHECKER V8), or null.
    window: jsonb("window").$type<unknown>(),
    // Reporting period or vintage of an SEC or Census metric (CHECKER V11), or null.
    period: text("period"),
  },
  (t) => [primaryKey({ name: "metrics_pk", columns: [t.runId, t.id] })],
);

/** D# datasets: full exhibit payloads for the UI, never sent to the model. */
export const datasets = pgTable(
  "datasets",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    bytes: integer("bytes").notNull().default(0),
  },
  (t) => [primaryKey({ name: "datasets_pk", columns: [t.runId, t.id] })],
);

/** F# findings from the code detectors that drive ANALYST turn 2. */
export const findings = pgTable(
  "findings",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
    kind: text("kind").notNull(),
    severity: text("severity"),
    text: text("text").notNull(),
    metricIds: textArray("metric_ids"),
    suggestion: jsonb("suggestion").$type<unknown>(),
  },
  (t) => [primaryKey({ name: "findings_pk", columns: [t.runId, t.id] })],
);

/**
 * L2 Qloo response cache. Rows hold Qloo data, so this table is never dumped into git (D29).
 * origin_run_id has no foreign key: the cache outlives runs and is copied between environments.
 */
export const qlooCache = pgTable(
  "qloo_cache",
  {
    // sha256 hex of "v1|GET|" + path + "?" + canonical query string.
    key: text("key").primaryKey(),
    path: text("path").notNull(),
    params: jsonb("params").$type<QlooParams>().notNull(),
    status: integer("status").notNull(),
    body: bytea("body").notNull(),
    requestId: text("request_id"),
    fetchedAt: tstz("fetched_at").notNull().defaultNow(),
    // Null for pinned entries (D25).
    expiresAt: tstz("expires_at"),
    pinned: boolean("pinned").notNull().default(false),
    hits: integer("hits").notNull().default(0),
    lastHitAt: tstz("last_hit_at"),
    originRunId: text("origin_run_id"),
  },
  (t) => [index("qloo_cache_expires_idx").on(t.expiresAt)],
);

/** One row per network or cache event. run_id has no foreign key: tools and probes log calls too. */
export const qlooCalls = pgTable(
  "qloo_calls",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    ts: tstz("ts").notNull().defaultNow(),
    env: text("env").notNull(),
    tag: text("tag"),
    runId: text("run_id"),
    path: text("path").notNull(),
    filterType: text("filter_type"),
    params: jsonb("params").$type<QlooParams>().notNull(),
    cacheKey: text("cache_key"),
    cacheStatus: text("cache_status").$type<CacheStatus>().notNull(),
    // Null for cache hits that never reached the network.
    httpStatus: integer("http_status"),
    ms: integer("ms"),
    requestId: text("request_id"),
    monthRemaining: integer("month_remaining"),
    error: text("error"),
  },
  (t) => [
    index("qloo_calls_ts_idx").on(t.ts),
    index("qloo_calls_run_idx").on(t.runId, t.ts),
    index("qloo_calls_tag_ts_idx").on(t.tag, t.ts),
  ],
);

/**
 * L2 cache for SEC EDGAR and US Census responses (PLAN §5.2), the counterpart of qloo_cache. Rows hold
 * fetched public data and are never dumped into git (D29). The key never includes an API key.
 */
export const publicCache = pgTable(
  "public_cache",
  {
    // sha256 hex of "pd-v1|GET|" + source + "|" + path + "?" + canonical query string (no key).
    key: text("key").primaryKey(),
    source: text("source").$type<PublicSourceName>().notNull(),
    path: text("path").notNull(),
    params: jsonb("params").$type<PublicParams>().notNull(),
    status: integer("status").notNull(),
    // gzip of the response body.
    body: bytea("body").notNull(),
    // PublicCallMeta.reference: CIK, Census dataset and vintage, or mock-<hash>.
    reference: text("reference"),
    fetchedAt: tstz("fetched_at").notNull().defaultNow(),
    // Null for pinned entries (Census vintages).
    expiresAt: tstz("expires_at"),
    pinned: boolean("pinned").notNull().default(false),
    hits: integer("hits").notNull().default(0),
    lastHitAt: tstz("last_hit_at"),
    originRunId: text("origin_run_id"),
  },
  (t) => [index("public_cache_expires_idx").on(t.expiresAt)],
);

/**
 * One row per SEC or Census network or cache event. Kept apart from qloo_calls so public calls never
 * count toward the Qloo caps or the Qloo health figures. run_id has no foreign key.
 */
export const publicCalls = pgTable(
  "public_calls",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    ts: tstz("ts").notNull().defaultNow(),
    env: text("env").notNull(),
    tag: text("tag"),
    runId: text("run_id"),
    source: text("source").$type<PublicSourceName>().notNull(),
    path: text("path").notNull(),
    params: jsonb("params").$type<PublicParams>().notNull(),
    cacheKey: text("cache_key"),
    cacheStatus: text("cache_status").$type<CacheStatus>().notNull(),
    // Null for cache hits that never reached the network.
    httpStatus: integer("http_status"),
    ms: integer("ms"),
    reference: text("reference"),
    error: text("error"),
  },
  (t) => [
    index("public_calls_ts_idx").on(t.ts),
    index("public_calls_run_idx").on(t.runId, t.ts),
    index("public_calls_source_ts_idx").on(t.source, t.ts),
  ],
);

/** Daily counters (Qloo fresh calls, LLM USD, runs). Global counters use lane "all". */
export const usageDaily = pgTable(
  "usage_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    metric: text("metric").notNull(),
    lane: text("lane").notNull().default("all"),
    value: doublePrecision("value").notNull().default(0),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "usage_daily_pk", columns: [t.day, t.metric, t.lane] })],
);

/** Per-IP daily counters; ip_hash is a salted hash, never the raw address. */
export const ipUsage = pgTable(
  "ip_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    ipHash: text("ip_hash").notNull(),
    runs: integer("runs").notNull().default(0),
    qlooCalls: integer("qloo_calls").notNull().default(0),
    llmUsd: doublePrecision("llm_usd").notNull().default(0),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "ip_usage_pk", columns: [t.day, t.ipHash] })],
);

/** Mode, kill switches, quota snapshot, metro locality ids, last success. */
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

/**
 * Following (PLAN Part 10, §2.4, §3.2): what one visitor follows, with what a re-run needs and the
 * latest note. visitor_key is a salted hash, never a raw address or cookie value. No change alerts:
 * the page shows the latest note and a re-run, nothing else.
 */
export const follows = pgTable(
  "follows",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    visitorKey: text("visitor_key").notNull(),
    kind: text("kind").$type<FollowKindName>().notNull(),
    // Stable per kind (@ct/contracts followSubjectKey): one row per visitor, kind and subject.
    subjectKey: text("subject_key").notNull(),
    label: text("label").notNull(),
    // What a re-run starts: the question, and the job and metro it was read as (null when none).
    question: text("question").notNull(),
    job: text("job"),
    metro: text("metro"),
    latestRunId: text("latest_run_id").references(() => runs.id, { onDelete: "set null" }),
    // A re-run that stopped at the picker (needs_input) and waits for the visitor's pick; cleared when
    // the picked run completes and becomes latest_run_id.
    pendingRunId: text("pending_run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: tstz("created_at").notNull().defaultNow(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("follows_kind_check", sql`${t.kind} IN (${sql.raw(FOLLOW_KINDS.map((k) => `'${k}'`).join(", "))})`),
    uniqueIndex("follows_visitor_subject_uq").on(t.visitorKey, t.kind, t.subjectKey),
    index("follows_visitor_created_idx").on(t.visitorKey, t.createdAt),
    index("follows_latest_run_idx").on(t.latestRunId),
  ],
);

/** The side context calls' kinds (R4, R5): "What AI knows (not verified)" and "From the web". */
export const CONTEXT_KINDS = ["ai", "web"] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/**
 * Cache of the side context blocks (R4, R5, D25: AI 7 days, web 24 hours). Only ok and empty blocks are
 * stored. Rows hold model and web text, never Qloo data. key = sha256 of the question, job, subject, place,
 * kind and model (agent side/cache).
 */
export const contextCache = pgTable(
  "context_cache",
  {
    key: text("key").primaryKey(),
    kind: text("kind").$type<ContextKind>().notNull(),
    model: text("model").notNull(),
    body: jsonb("body").$type<unknown>().notNull(),
    usd: numeric("usd", { precision: 10, scale: 6, mode: "number" }).notNull().default(0),
    createdAt: tstz("created_at").notNull().defaultNow(),
    expiresAt: tstz("expires_at").notNull(),
  },
  (t) => [
    check("context_cache_kind_check", sql`${t.kind} IN (${sql.raw(CONTEXT_KINDS.map((k) => `'${k}'`).join(", "))})`),
    index("context_cache_expires_idx").on(t.expiresAt),
  ],
);

/**
 * One row per use of a code-only feature (screener, brand profile): what it actually spent, so /method can
 * show measured medians beside the plan figures (Part 10 open issue).
 */
export const featureUses = pgTable(
  "feature_uses",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    feature: text("feature").notNull(),
    ts: tstz("ts").notNull().defaultNow(),
    qlooNetwork: integer("qloo_network").notNull(),
    qlooCached: integer("qloo_cached").notNull(),
    publicCalls: integer("public_calls").notNull().default(0),
    llmUsd: numeric("llm_usd", { precision: 10, scale: 6, mode: "number" }).notNull().default(0),
    ms: integer("ms").notNull(),
  },
  (t) => [index("feature_uses_feature_ts_idx").on(t.feature, t.ts)],
);

/** Showcase mention → pinned Qloo entity. Entity ids live only here, never in git (D29). */
export const showcasePins = pgTable(
  "showcase_pins",
  {
    slug: text("slug").notNull(),
    mention: text("mention").notNull(),
    entityId: text("entity_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    pinnedAt: tstz("pinned_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "showcase_pins_pk", columns: [t.slug, t.mention] })],
);

/**
 * Accounts: one row per person. email is stored lowercased and trimmed (unique). password_hash is
 * "scrypt$N$r$p$salt$hash" (base64url salt and hash); the plain password is never stored.
 */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()::text`),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

/** Signed-in sessions. id is the SHA-256 (hex) of the cookie token; the token itself is never stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: tstz("created_at").notNull().defaultNow(),
    expiresAt: tstz("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type RunEventRow = typeof runEvents.$inferSelect;
export type NewRunEventRow = typeof runEvents.$inferInsert;
export type EvidenceRow = typeof evidence.$inferSelect;
export type MetricRow = typeof metrics.$inferSelect;
export type DatasetRow = typeof datasets.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
export type QlooCacheRow = typeof qlooCache.$inferSelect;
export type QlooCallRow = typeof qlooCalls.$inferSelect;
export type PublicCacheRow = typeof publicCache.$inferSelect;
export type PublicCallRow = typeof publicCalls.$inferSelect;
export type UsageDailyRow = typeof usageDaily.$inferSelect;
export type IpUsageRow = typeof ipUsage.$inferSelect;
export type KvRow = typeof kv.$inferSelect;
export type ShowcasePinRow = typeof showcasePins.$inferSelect;
export type FollowRow = typeof follows.$inferSelect;
export type ContextCacheRow = typeof contextCache.$inferSelect;
export type FeatureUseRow = typeof featureUses.$inferSelect;
export type NewFollowRow = typeof follows.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
