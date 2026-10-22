// `pnpm db:migrate` loads the root .env; these tests only ever load a temp file, never the real one.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRootEnv, rootEnvPath } from "../src/load-root-env";

const VAR = "DATABASE_URL";

describe("loadRootEnv", () => {
  const saved = process.env[VAR];
  let dir: string | undefined;

  afterEach(() => {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function envFile(content: string): string {
    dir = mkdtempSync(path.join(tmpdir(), "ct-db-env-"));
    const file = path.join(dir, ".env");
    writeFileSync(file, content);
    return file;
  }

  it("resolves the repository root from the package, whatever the working directory", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    expect(rootEnvPath()).toBe(path.join(repoRoot, ".env"));
  });

  it("loads a variable the shell did not set", () => {
    delete process.env[VAR];
    const file = envFile(`${VAR}=postgres://ct:ct@localhost:5434/culture_terminal\n`);
    expect(loadRootEnv(file)).toBe(true);
    expect(process.env[VAR]).toBe("postgres://ct:ct@localhost:5434/culture_terminal");
  });

  it("keeps a value that is already set", () => {
    process.env[VAR] = "postgres://ct:ct@localhost:5433/from_shell";
    const file = envFile(`${VAR}=postgres://ct:ct@localhost:5434/culture_terminal\n`);
    expect(loadRootEnv(file)).toBe(true);
    expect(process.env[VAR]).toBe("postgres://ct:ct@localhost:5433/from_shell");
  });

  it("does nothing without a file", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ct-db-env-"));
    expect(loadRootEnv(path.join(dir, ".env"))).toBe(false);
  });
});
