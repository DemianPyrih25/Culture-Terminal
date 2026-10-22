import { afterEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "./cli";
import { fakeUuid, TempRepo } from "./test-utils";

function capture(env: Record<string, string | undefined> = {}): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l) => out.push(l), error: (l) => err.push(l), env };
}

describe("guard cli", { timeout: 30_000 }, () => {
  let repo: TempRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });

  it("exits 0 on a clean tree", () => {
    repo = new TempRepo();
    repo.write({ "src/a.ts": "export const a = 1;\n" });
    const io = capture();
    expect(main([], repo.root, io)).toBe(0);
    expect(io.out.at(-1)).toMatch(/working tree: 1 files scanned, clean/);
  });

  it("exits 1 with file:line:col and rule per finding, never the value", () => {
    repo = new TempRepo();
    const id = fakeUuid("9");
    repo.write({ "src/a.ts": `\n  "${id}"\n`, ".env.local": "X=1\n" });
    const io = capture();
    expect(main([], repo.root, io)).toBe(1);
    expect(io.out).toContain(
      "src/a.ts:2:4  uuid  UUID-shaped value outside **/test/synthetic/** (D29: Qloo IDs are resolved at runtime and pinned in the database)",
    );
    expect(io.out.some((l) => l.startsWith(".env.local  forbidden-path  "))).toBe(true);
    expect(io.out.join("\n")).not.toContain(id);
    expect(io.out.at(-1)).toMatch(/2 findings$/);
  });

  it("adds GitHub annotations inside Actions", () => {
    repo = new TempRepo();
    repo.write({ "src/a.ts": `"${fakeUuid("8")}"\n` });
    const io = capture({ GITHUB_ACTIONS: "true" });
    expect(main([], repo.root, io)).toBe(1);
    expect(io.out).toContain(
      "::error file=src/a.ts,title=guard uuid,line=1,col=2::UUID-shaped value outside **/test/synthetic/** (D29: Qloo IDs are resolved at runtime and pinned in the database)",
    );
  });

  it("scans history with --history", () => {
    repo = new TempRepo();
    const first = repo.commit({ "a.md": `${fakeUuid("7")}\n` }, "first");
    repo.commit({ "b.md": "fine\n" }, "second", first);
    const io = capture();
    expect(main(["--history"], repo.root, io)).toBe(1);
    expect(io.out[0]).toBe(
      `a.md:1:1  uuid  UUID-shaped value outside **/test/synthetic/** (D29: Qloo IDs are resolved at runtime and pinned in the database) (commit ${first.slice(0, 12)})`,
    );
  });

  it("scans the bundle directory with --bundle, honouring NEXT_DIST_DIR and --dir", () => {
    repo = new TempRepo();
    repo.write({ "apps/web/.next-agent1/static/chunks/a.js": `fetch("postgres://x")` });
    const io = capture({ NEXT_DIST_DIR: ".next-agent1" });
    expect(main(["--bundle"], repo.root, io)).toBe(1);
    expect(io.out[0]).toMatch(/^apps\/web\/\.next-agent1\/static\/chunks\/a\.js:1:8 {2}bundle-secret/);

    const io2 = capture();
    expect(main(["--bundle", "--dir", "apps/web/.next-agent1/static"], repo.root, io2)).toBe(1);
  });

  it("exits 2 on usage errors and on a missing bundle", () => {
    repo = new TempRepo();
    for (const argv of [["--nope"], ["--dir", "x"], ["--bundle", "--dir"]]) {
      const io = capture();
      expect(main(argv, repo.root, io), argv.join(" ")).toBe(2);
      expect(io.err.join("\n")).toMatch(/Usage: pnpm guard/);
    }
    const io = capture();
    expect(main(["--bundle"], repo.root, io)).toBe(2);
    expect(io.err.join("\n")).toMatch(/bundle directory not found/);
  });

  it("prints usage with --help", () => {
    const io = capture();
    expect(main(["--help"], ".", io)).toBe(0);
    expect(io.out.join("\n")).toMatch(/--history/);
  });
});
