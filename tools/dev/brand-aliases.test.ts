// tools/dev/brand-aliases.ts: how one alias search is judged, what the check writes back, and that the file
// keeps its one-entry-per-line shape. Invented names only (D29); no Qloo call.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QlooSearchEntity } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { aliasOutcome, checkedEntry, formatConfig, type AliasConfigFile, type AliasEntry } from "./brand-aliases";

const ENTRY: AliasEntry = { alias: "Brand Gamma", names: ["Brand Gamma Foods"], type: "brand", status: "unverified", verified_by: null };
const result = (name: string): QlooSearchEntity => ({ entity_id: `ent-${name}`, name, types: ["urn:entity:brand"] }) as unknown as QlooSearchEntity;

describe("brand-aliases check", () => {
  it("verifies an alias when one of its names comes back, and names it", () => {
    expect(aliasOutcome(ENTRY, [result("Brand Gamma Studio"), result("brand gamma foods")])).toEqual({ status: "verified", name: "brand gamma foods" });
  });

  it("leaves it unverified when none comes back, or when the alias already resolves exactly", () => {
    expect(aliasOutcome(ENTRY, [result("Brand Gamma Studio")])).toEqual({ status: "unverified", why: "absent" });
    expect(aliasOutcome(ENTRY, [result("Brand Gamma"), result("Brand Gamma Foods")])).toEqual({ status: "unverified", why: "exact" });
  });

  it("writes the status and a dated line saying what came back", () => {
    expect(checkedEntry(ENTRY, { status: "verified", name: "Brand Gamma Foods" }, "2026-10-30")).toEqual({
      ...ENTRY,
      status: "verified",
      verified_by: "brand-aliases.ts 2026-10-30: the brand search for 'Brand Gamma' returned 'Brand Gamma Foods'",
    });
    expect(checkedEntry({ ...ENTRY, status: "verified" }, { status: "unverified", why: "failed" }, "2026-10-30")).toMatchObject({ status: "unverified", verified_by: "brand-aliases.ts 2026-10-30: the search failed" });
  });

  it("writes config/brand_aliases.json back exactly as the repo keeps it", () => {
    const path = fileURLToPath(new URL("../../config/brand_aliases.json", import.meta.url));
    // The working copy may hold CRLF line ends (core.autocrlf); git stores LF, as formatConfig writes.
    const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    expect(formatConfig(JSON.parse(text) as AliasConfigFile)).toBe(text);
  });
});
