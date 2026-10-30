// The zod-free values entry (@ct/contracts/values): nothing reachable from it imports zod at runtime, and
// its values are the very ones the barrel exports, so client bundles and server code never drift.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as barrel from "../src/index";
import * as values from "../src/values/index";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");
const pkg = JSON.parse(readFileSync(path.resolve(HERE, "../package.json"), "utf8")) as { exports: unknown; sideEffects: unknown };

/** Runtime module specifiers of a file: every import and re-export that is not type-only. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)"/gm;
  for (const m of text.matchAll(re)) {
    if (m[2]) continue;
    // `import { type A, type B } from` is type-only too.
    const names = m[3] ?? "";
    const braces = /^\{([^}]*)\}$/.exec(names.trim());
    if (braces && braces[1]!.split(",").every((n) => n.trim() === "" || n.trim().startsWith("type "))) continue;
    out.push(m[4]!);
  }
  for (const m of text.matchAll(/^\s*import\s+"([^"]+)"/gm)) out.push(m[1]!);
  return out;
}

/** Every source file reachable from `entry` through runtime imports, and every bare specifier seen. */
function reach(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of runtimeImports(file)) {
      if (!spec.startsWith(".")) {
        bare.add(spec);
        continue;
      }
      todo.push(path.resolve(path.dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`));
    }
  }
  return { files, bare };
}

describe("values entry", () => {
  it("is exported as @ct/contracts/values with sideEffects false", () => {
    expect(pkg.exports).toEqual({ ".": "./src/index.ts", "./values": "./src/values/index.ts" });
    expect(pkg.sideEffects).toBe(false);
  });

  it("imports nothing from zod, nor any module that does, at runtime", () => {
    const { files, bare } = reach(path.join(SRC, "values", "index.ts"));
    expect([...bare]).toEqual([]);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // A type-only import of zod is erased at build time; any other import of it is not.
      const runtimeZod = text.split("\n").filter((l) => /from\s+"zod"/.test(l) && !/^\s*import\s+type\s/.test(l));
      expect(runtimeZod, path.relative(SRC, file)).toEqual([]);
    }
    // The zod modules themselves are out of reach.
    for (const zodModule of ["enums.ts", "report.ts", "datasets.ts", "events.ts", "tools.ts", "intent.ts", "ledger.ts"]) {
      expect(files.has(path.join(SRC, zodModule)), zodModule).toBe(false);
    }
  });

  it("exports the same values the barrel does", () => {
    const shared = Object.keys(values).filter((k) => k in barrel);
    expect(shared.length).toBeGreaterThan(80);
    // Typed wrappers on the barrel (provenance guards, event stamping) shadow the structural ones on purpose.
    const wrapped = new Set(["isPublicProvenanceRequest", "isQlooProvenanceRequest", "provenanceSource", "stampEvent", "unstampEvent", "encodeSseEvent"]);
    for (const k of shared) {
      if (wrapped.has(k)) continue;
      expect((barrel as Record<string, unknown>)[k], k).toBe((values as Record<string, unknown>)[k]);
    }
    const missing = Object.keys(values).filter((k) => !(k in barrel));
    expect(missing).toEqual([]);
  });

  it("builds the zod enums from the value arrays", () => {
    expect(barrel.Job.options).toEqual([...values.JOB_VALUES]);
    expect(barrel.Flag.options).toEqual([...values.FLAG_VALUES]);
    expect(barrel.SkillId.options).toEqual([...values.SKILL_ID_VALUES]);
    expect(barrel.ToolName.options).toEqual([...values.TOOL_NAME_VALUES]);
    expect(barrel.DatasetKind.options).toEqual([...values.DATASET_KIND_VALUES]);
    expect(barrel.VizComponent.options).toEqual([...values.VIZ_COMPONENT_VALUES]);
    expect(barrel.PublicSource.options).toEqual([...values.PUBLIC_SOURCE_VALUES]);
    expect(barrel.ConfidenceRule.options).toEqual([...values.CONFIDENCE_RULE_VALUES]);
    expect(barrel.ValidationRule.options).toEqual([...values.VALIDATION_RULE_VALUES]);
  });

  it("keeps the structural guards in step with the typed ones", () => {
    const sec = { source: "sec" as const, method: "GET" as const, host: "data.sec.gov", path: "/x", query: {}, reference: "CIK1" };
    const qloo = { method: "GET" as const, path: "/search" as const, query: {} };
    expect(values.isPublicProvenanceRequest(sec)).toBe(true);
    expect(values.isPublicProvenanceRequest(qloo)).toBe(false);
    expect(values.provenanceSource(qloo)).toBe("qloo");
    expect(values.encodeSseEvent({ seq: 3 })).toBe('id: 3\ndata: {"seq":3}\n\n');
  });
});
