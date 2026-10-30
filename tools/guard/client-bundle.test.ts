import { rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanBundleDir, scanBundleText, SERVER_ONLY_ENV } from "./client-bundle";
import { fakeAnthropicKey, tempDir, writeFiles } from "./test-utils";

const FILE = "apps/web/.next/static/chunks/app.js";

describe("scanBundleText", () => {
  it("flags the Anthropic key prefix and never echoes the key", () => {
    const key = fakeAnthropicKey();
    const findings = scanBundleText(FILE, `var k="${key}";`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "bundle-secret", line: 1, column: 8 });
    expect(findings[0]?.message).not.toContain(key);
  });

  it.each(SERVER_ONLY_ENV)("flags the server-only variable name %s", (name) => {
    expect(scanBundleText(FILE, `e.env.${name}||""`)).toHaveLength(1);
    expect(scanBundleText(FILE, `{"${name}":1}`)).toHaveLength(1);
  });

  it("allows the shell placeholder used by copy-as-curl", () => {
    const curl = ["curl", "-H", `'X-Api-Key: $QLOO_API_KEY'`, "-H", "'X-Api-Key: ${QLOO_API_KEY}'"].join(" ");
    expect(scanBundleText(FILE, curl)).toEqual([]);
  });

  it("does not match names that merely contain a server-only name", () => {
    expect(scanBundleText(FILE, "MY_QLOO_API_KEY_HINT NEXT_PUBLIC_TURNSTILE_SITE_KEY")).toEqual([]);
  });

  it("flags connection strings", () => {
    const scheme = ["postgres", "postgresql"].map((s) => `${s}://`);
    for (const s of scheme) expect(scanBundleText(FILE, `"${s}user:pass@host/db"`)).toHaveLength(1);
  });

  it("flags an X-Api-Key header with a literal value but not with a variable", () => {
    const literal = "k3y".repeat(6);
    expect(scanBundleText(FILE, `headers:{"X-Api-Key":"${literal}"}`)).toHaveLength(1);
    expect(scanBundleText(FILE, `h.set("x-api-key","${literal}")`)).toHaveLength(1);
    expect(scanBundleText(FILE, `headers:{"X-Api-Key":t}`)).toEqual([]);
    expect(scanBundleText(FILE, `["X-Api-Key","Content-Type"]`)).toEqual([]);
  });

  it("flags a UUID-shaped id (a possible Qloo entity id) but not the nil UUID or a doc link (R8)", () => {
    // Invented id, built at runtime so this test file holds no UUID literal.
    const id = ["0a1b2c3d", "0000", "4000", "8000", "00000000aaaa"].join("-");
    expect(scanBundleText(FILE, `{"signal.interests.entities":"${id}"}`)).toMatchObject([{ rule: "bundle-entity-id" }]);
    expect(scanBundleText(FILE, `q=${id.toUpperCase()}`)).toHaveLength(1);
    expect(scanBundleText(FILE, `x="${["0", "0", "0", "0"].map((_, i) => "0".repeat([8, 4, 4, 4][i] ?? 4)).join("-")}-000000000000"`)).toEqual([]);
    expect(scanBundleText(FILE, `![diagram](https://example.com/assets/12/${id})`)).toEqual([]);
  });

  it("passes ordinary minified code", () => {
    const code = `(()=>{"use strict";let e=document.querySelector("#a");e&&(e.textContent="Culture Terminal")})();`;
    expect(scanBundleText(FILE, code)).toEqual([]);
  });
});

describe("scanBundleDir", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("walks nested files, skips binaries and reports repo-relative paths", () => {
    root = tempDir("bundle");
    const leaked = ["DATABASE", "URL"].join("_");
    writeFiles(root, {
      "apps/web/.next/static/chunks/main.js": "console.log(1)",
      "apps/web/.next/static/chunks/app/page.js": `x(process.env.${leaked})`,
      "apps/web/.next/static/media/font.woff2": new Uint8Array([0, 0, ...Buffer.from(leaked)]),
    });
    const { findings, scanned } = scanBundleDir(path.join(root, "apps/web/.next/static"), root);
    expect(scanned).toBe(3);
    expect(findings.map((f) => `${f.file}:${f.line}:${f.column}`)).toEqual(["apps/web/.next/static/chunks/app/page.js:1:15"]);
  });

  it("fails clearly when there is no build", () => {
    root = tempDir("nobundle");
    expect(() => scanBundleDir(path.join(root!, "apps/web/.next/static"), root!)).toThrow(/pnpm build/);
  });
});
