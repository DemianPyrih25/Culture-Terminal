// Pure checks on the schema and the committed migrations; no database needed.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { type DrizzleSnapshotJSON, generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import { defaultMigrationsFolder, resolveMigrationsFolder } from "../src/migrate";
import * as schema from "../src/schema";
import { ANSWER_CACHE_WINDOW_MS } from "../src/repos/runs";

const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
const byName = new Map(tables.map((t) => [getTableConfig(t).name, getTableConfig(t)]));

function primaryKeyOf(name: string): string[] {
  const cfg = byName.get(name);
  if (!cfg) throw new Error(`no table ${name}`);
  const composite = cfg.primaryKeys[0];
  if (composite) return composite.columns.map((c) => c.name);
  return cfg.columns.filter((c) => c.primary).map((c) => c.name);
}

describe("schema", () => {
  it("defines exactly the 19 tables of PLAN §3.2 (public data from Part 9, follows from Part 10, context_cache and feature_uses from Part 11, users and sessions for accounts)", () => {
    expect([...byName.keys()].sort()).toEqual(
      [
        "context_cache",
        "datasets",
        "evidence",
        "feature_uses",
        "findings",
        "follows",
        "ip_usage",
        "kv",
        "metrics",
        "public_cache",
        "public_calls",
        "qloo_cache",
        "qloo_calls",
        "run_events",
        "runs",
        "sessions",
        "showcase_pins",
        "usage_daily",
        "users",
      ].sort(),
    );
  });

  it("uses the primary keys the access patterns rely on", () => {
    expect(primaryKeyOf("runs")).toEqual(["id"]);
    expect(primaryKeyOf("run_events")).toEqual(["run_id", "seq"]);
    for (const ledger of ["evidence", "metrics", "datasets", "findings"]) {
      expect(primaryKeyOf(ledger)).toEqual(["run_id", "id"]);
    }
    expect(primaryKeyOf("qloo_cache")).toEqual(["key"]);
    expect(primaryKeyOf("qloo_calls")).toEqual(["id"]);
    expect(primaryKeyOf("public_cache")).toEqual(["key"]);
    expect(primaryKeyOf("public_calls")).toEqual(["id"]);
    expect(primaryKeyOf("usage_daily")).toEqual(["day", "metric", "lane"]);
    expect(primaryKeyOf("ip_usage")).toEqual(["day", "ip_hash"]);
    expect(primaryKeyOf("kv")).toEqual(["key"]);
    expect(primaryKeyOf("showcase_pins")).toEqual(["slug", "mention"]);
    expect(primaryKeyOf("follows")).toEqual(["id"]);
  });

  it("indexes the answer cache, cache expiry and the call log", () => {
    const indexCols = (table: string) =>
      Object.fromEntries(
        (byName.get(table)?.indexes ?? []).map((i) => [
          i.config.name,
          i.config.columns.map((c) => ("name" in c ? c.name : "?")),
        ]),
      );
    expect(indexCols("runs")["runs_answer_cache_idx"]).toEqual(["question_hash", "status", "created_at"]);
    expect(indexCols("qloo_cache")["qloo_cache_expires_idx"]).toEqual(["expires_at"]);
    expect(indexCols("qloo_calls")["qloo_calls_ts_idx"]).toEqual(["ts"]);
    expect(indexCols("qloo_calls")["qloo_calls_run_idx"]).toEqual(["run_id", "ts"]);
    expect(indexCols("public_cache")["public_cache_expires_idx"]).toEqual(["expires_at"]);
    expect(indexCols("public_calls")["public_calls_ts_idx"]).toEqual(["ts"]);
    expect(indexCols("public_calls")["public_calls_run_idx"]).toEqual(["run_id", "ts"]);
    expect(indexCols("public_calls")["public_calls_source_ts_idx"]).toEqual(["source", "ts"]);
  });

  it("keeps the 72-hour answer-cache window of D26", () => {
    expect(ANSWER_CACHE_WINDOW_MS).toBe(72 * 3600 * 1000);
  });
});

describe("committed migrations", () => {
  const folder = defaultMigrationsFolder();
  const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };

  it("resolve to the package's drizzle/ folder unless MIGRATIONS_DIR is set", () => {
    expect(path.basename(folder)).toBe("drizzle");
    expect(path.basename(path.dirname(folder))).toBe("db");
    expect(resolveMigrationsFolder({} as NodeJS.ProcessEnv)).toBe(folder);
    expect(resolveMigrationsFolder({ MIGRATIONS_DIR: "/srv/migrations" } as NodeJS.ProcessEnv)).toBe(
      path.resolve("/srv/migrations"),
    );
  });

  it("have one SQL file per journal entry", () => {
    const sqlFiles = readdirSync(folder).filter((f) => f.endsWith(".sql")).sort();
    expect(sqlFiles).toEqual(journal.entries.map((e) => `${e.tag}.sql`).sort());
    expect(journal.entries[0]?.tag).toBe("0000_init");
  });

  function latestSnapshot(): DrizzleSnapshotJSON {
    const last = journal.entries.at(-1);
    if (!last) throw new Error("empty journal");
    const file = path.join(folder, "meta", `${String(last.idx).padStart(4, "0")}_snapshot.json`);
    return JSON.parse(readFileSync(file, "utf8")) as DrizzleSnapshotJSON;
  }

  // drizzle-kit's own diff, as `pnpm db:generate` runs it: types, nullability, defaults, foreign
  // keys, checks and index columns all count, not only names.
  it("are up to date with schema.ts (drizzle-kit finds nothing to generate)", async () => {
    const snapshot = latestSnapshot();
    const current = generateDrizzleJson(schema, snapshot.id);
    expect(await generateMigration(snapshot, current), "run `pnpm db:generate` and commit the new migration").toEqual([]);
  });

  it("would catch a nullability change that keeps every name", async () => {
    const snapshot = latestSnapshot();
    const drifted = structuredClone(snapshot) as unknown as {
      tables: Record<string, { columns: Record<string, { notNull: boolean }> }>;
    };
    const runId = drifted.tables["public.datasets"]?.columns["run_id"];
    if (!runId) throw new Error("datasets.run_id missing from the snapshot");
    runId.notNull = !runId.notNull;
    const current = generateDrizzleJson(schema, snapshot.id);
    expect(await generateMigration(drifted as unknown as DrizzleSnapshotJSON, current)).toHaveLength(1);
  });
});
