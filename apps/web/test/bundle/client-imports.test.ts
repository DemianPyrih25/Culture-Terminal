// The client bundle split (Part 11): a "use client" module takes its values from the zod-free entry
// "@ct/contracts/values" and never imports zod; type-only imports from the barrel are erased and stay.
// Home and /ask are checked deeper: nothing below their first client module imports zod or barrel values.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB = path.resolve(__dirname, "../..");
const ROOTS = ["components", "lib", "app"].map((d) => path.join(WEB, d));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p.includes(`${path.sep}app${path.sep}api`)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r));
const isClient = (src: string) => /^\s*["']use client["']/.test(src);

/** The value names an import statement brings in (nothing for `import type`, or for `{ type A, type B }`). */
function valueSpecifiers(statement: string): string[] {
  if (/^\s*import\s+type\b/.test(statement)) return [];
  const braces = /\{([^}]*)\}/.exec(statement)?.[1];
  if (braces === undefined) return ["*"];
  return braces
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("type "));
}

const IMPORT = /^\s*import\s+[^;]*?from\s+"([^"]+)";?/gm;

/** Problems in one module's static imports: zod, or values from the contracts barrel. */
export function importProblems(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[1] ?? "";
    if (spec === "zod" || spec.startsWith("zod/")) out.push("imports zod");
    else if (spec === "@ct/contracts" && valueSpecifiers(m[0]).length > 0) out.push(`value import of @ct/contracts: ${valueSpecifiers(m[0]).join(", ")}`);
  }
  return out;
}

describe("the rule itself", () => {
  it("flags zod and barrel values, and lets types and the values entry through", () => {
    expect(importProblems('import { z } from "zod";')).toEqual(["imports zod"]);
    expect(importProblems('import { Job } from "@ct/contracts";')).toHaveLength(1);
    expect(importProblems('import type { Job } from "@ct/contracts";')).toEqual([]);
    expect(importProblems('import { type Job, type Pillar } from "@ct/contracts";')).toEqual([]);
    expect(importProblems('import { JOB_VALUES } from "@ct/contracts/values";')).toEqual([]);
  });
});

describe("client modules", () => {
  it("take values from @ct/contracts/values and never import zod", () => {
    const bad: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      if (!isClient(src)) continue;
      for (const p of importProblems(src)) bad.push(`${path.relative(WEB, file)}: ${p}`);
    }
    expect(bad).toEqual([]);
  });

  it("keep Home and /ask free of zod below their first client module", () => {
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/") ? path.join(WEB, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
      if (!base) return null;
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // not this one
        }
      }
      return null;
    };
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (file: string, client: boolean) => {
      const key = `${file}|${client}`;
      if (seen.has(key)) return;
      seen.add(key);
      const src = readFileSync(file, "utf8");
      const below = client || isClient(src);
      if (below) for (const p of importProblems(src)) bad.push(`${path.relative(WEB, file)}: ${p}`);
      for (const m of src.matchAll(IMPORT)) {
        if (/^\s*import\s+type\b/.test(m[0])) continue;
        const next = resolve(file, m[1] ?? "");
        if (next && !next.includes(`${path.sep}server${path.sep}`)) visit(next, below);
      }
    };
    for (const page of ["app/page.tsx", "app/ask/page.tsx", "app/layout.tsx"]) visit(path.join(WEB, page), false);
    expect(bad).toEqual([]);
  });
});
