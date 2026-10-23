import { rmSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPath,
  checkPathText,
  inDecimalScope,
  scanContent,
  scanHistory,
  scanText,
  scanWorkingTree,
} from "./no-qloo-data";
import { fakeAnthropicKey, fakeRequestId, fakeUuid, REQUEST_ID_HEADER, TempRepo } from "./test-utils";

const rules = (findings: ReadonlyArray<{ rule: string }>) => findings.map((f) => f.rule);

describe("checkPath", () => {
  it.each([
    ".probe/raw/g1.json",
    "tools/probe/.probe/pins.json",
    ".private/notes.md",
    "eval/raw/run-01.json",
    "backups/prod.dump",
    "backups/dev.backup",
    "dev.sql.gz",
    "db/dev.pgdump",
    ".env",
    ".env.local",
    "apps/web/.env.production",
    ".env.example/secret",
  ])("flags %s", (file) => {
    expect(rules(checkPath(file))).toContain("forbidden-path");
  });

  it.each([
    ".env.example",
    "packages/db/src/env.ts",
    "eval/questions.json",
    "eval/rawness.md",
    "tools/probe/run-probe.ts",
    "docs/dump.md",
    "environment/readme.md",
  ])("allows %s", (file) => {
    expect(checkPath(file)).toEqual([]);
  });
});

describe("invisible characters", () => {
  const ch = (cp: number) => String.fromCodePoint(cp);

  it("flags a BOM, zero-width, bidi, tag and control characters, with their position", () => {
    for (const cp of [0xfeff, 0x200b, 0x202e, 0x2066, 0xe0041, 0x07, 0x85, 0xad]) {
      const findings = scanText("src/a.ts", `const s = "ok${ch(cp)}";`);
      expect(findings.map((f) => [f.rule, f.line, f.column])).toEqual([["invisible-char", 1, 14]]);
    }
  });

  it("allows tabs, line breaks and ordinary non-ASCII text such as accents, dashes and arrows", () => {
    expect(scanText("src/a.ts", "a\tb\r\nCafé · 25–29 ← →\n")).toEqual([]);
  });
});

describe("checkPathText", () => {
  it("flags a UUID in a file name and masks it in the reported path", () => {
    const id = fakeUuid("c");
    const findings = checkPathText(`packages/qloo/test/fixtures/${id}.json`);
    expect(rules(findings)).toEqual(["uuid"]);
    expect(findings[0]).toEqual({
      file: "packages/qloo/test/fixtures/<uuid>.json",
      rule: "uuid",
      message: expect.stringMatching(/\(in the path\)$/),
    });
    expect(JSON.stringify(findings)).not.toContain(id);
  });

  it("flags a request id in a path", () => {
    expect(rules(checkPathText(`logs/${REQUEST_ID_HEADER}=${fakeRequestId()}.txt`))).toEqual(["request-id"]);
  });

  it("exempts **/test/synthetic/** and ordinary paths", () => {
    expect(checkPathText(`packages/qloo/test/synthetic/${fakeUuid("c")}.json`)).toEqual([]);
    expect(checkPathText("packages/db/drizzle/meta/0000_snapshot.json")).toEqual([]);
  });
});

describe("uuid rule", () => {
  it("flags a UUID with its line and column, without echoing the value", () => {
    const id = fakeUuid("c");
    const findings = scanText("packages/qloo/src/pins.ts", `const a = 1;\nconst pin = "${id}";\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "uuid", line: 2, column: 14 });
    expect(findings[0]?.message).not.toContain(id);
  });

  it("matches upper case and UUIDs inside URNs or identifiers", () => {
    const text = [`urn:entity:${fakeUuid("A")}`, `id_${fakeUuid("b")}`].join("\n");
    expect(rules(scanText("config/showcases.json", text))).toEqual(["uuid", "uuid"]);
  });

  it("ignores longer hex runs that only contain a UUID-shaped slice", () => {
    expect(scanText("src/a.ts", `0${fakeUuid("d")}0`)).toEqual([]);
  });

  it.each([
    "%22",
    "%2C",
    "%3a",
    "%20",
    "%2F",
    "%5B%22",
    "%252C",
    "%253D",
    "%25252C",
    "%u201C",
    "%25u201c",
    "\\x22",
    "\\u0022",
    "\\u201c",
    "\\u2014",
    "\\uFEFF",
  ])("flags a UUID right after the escape %s", (prefix) => {
    expect(rules(scanText("packages/qloo/test/fixtures/a.json", `?q=${prefix}${fakeUuid("c")}`))).toEqual(["uuid"]);
  });

  it("still ignores a UUID-shaped slice of a hex run that no escape ends", () => {
    for (const prefix of ["ab12", "%2", "%u20", "\\u20", "x0"]) {
      expect(scanText("src/a.ts", `${prefix}${fakeUuid("d")}`), prefix).toEqual([]);
    }
  });

  it("flags every UUID in a URL-encoded list", () => {
    const text = `entities=${fakeUuid("a")}%2C${fakeUuid("b")}`;
    expect(rules(scanText("docs/QLOO_USAGE.md", text))).toEqual(["uuid", "uuid"]);
  });

  it("flags UUIDs in a URL encoded twice, inside another URL", () => {
    const inner = `https%3A%2F%2Fapi.example.test%2Fv2%2Finsights%3Fsignal.interests.entities%253D${fakeUuid("a")}%252C${fakeUuid("b")}`;
    expect(rules(scanText("docs/README.md", `https://viewer.example.test/?u=${inner}`))).toEqual(["uuid", "uuid"]);
  });

  it("flags a UUID between escaped curly quotes, as JSON with escaped non-ASCII writes them", () => {
    expect(rules(scanText("config/notes.json", `{"note": "\\u201c${fakeUuid("e")}\\u201d"}`))).toEqual(["uuid"]);
  });

  it("exempts **/test/synthetic/** fixtures", () => {
    const text = `{"entity_id":"${fakeUuid("e")}"}`;
    expect(scanText("packages/qloo/test/synthetic/search.json", text)).toEqual([]);
    expect(scanText("packages/quant/src/test/synthetic/heatmap.json", text)).toEqual([]);
    expect(rules(scanText("packages/qloo/test/fixtures/search.json", text))).toEqual(["uuid"]);
  });

  it("exempts only drizzle-kit's id and prevId lines in migration snapshots", () => {
    const snapshot = `{\n  "id": "${fakeUuid("1")}",\n  "prevId": "${fakeUuid("0")}",\n  "x": "${fakeUuid("2")}"\n}\n`;
    const findings = scanText("packages/db/drizzle/meta/0003_snapshot.json", snapshot);
    expect(findings.map((f) => f.line)).toEqual([4]);
    expect(rules(scanText("packages/db/drizzle/0003_init.sql", `-- "id": "${fakeUuid("1")}"`))).toEqual(["uuid"]);
    expect(rules(scanText("config/meta/0003_snapshot.json", snapshot))).toEqual(["uuid", "uuid", "uuid"]);
  });
});

describe("request-id rule", () => {
  const value = fakeRequestId();

  it.each([
    `${REQUEST_ID_HEADER}: ${value}`,
    `"${REQUEST_ID_HEADER}": "${value}"`,
    `${REQUEST_ID_HEADER}=${value}`,
    `| \`${REQUEST_ID_HEADER}\` | ${value} |`,
    `${REQUEST_ID_HEADER.toUpperCase()} → ${value}`,
  ])("flags a header with a value: %s", (line) => {
    const findings = scanText("docs/QLOO_USAGE.md", line);
    expect(rules(findings)).toEqual(["request-id"]);
    expect(findings[0]?.message).not.toContain(value);
  });

  it.each([
    `const header = "${REQUEST_ID_HEADER}";`,
    `["${REQUEST_ID_HEADER}", "x-month-ratelimit-remaining"]`,
    `res.headers.get("${REQUEST_ID_HEADER}")`,
    `${REQUEST_ID_HEADER}: <request id>`,
    `${REQUEST_ID_HEADER}: \${requestId}`,
    `"${REQUEST_ID_HEADER}": requestId`,
    `the ${REQUEST_ID_HEADER} header`,
  ])("allows the bare header name: %s", (line) => {
    expect(scanText("packages/qloo/src/client.ts", line)).toEqual([]);
  });
});

describe("decimal rule", () => {
  const score = "0." + "9234";

  it("flags 3+ fractional digits in docs, README, prompts, config and page copy", () => {
    for (const file of [
      "docs/METHOD.md",
      "README.md",
      "readme.md",
      "packages/geo/Readme.md",
      "packages/geo/README.MD",
      "packages/agent/prompts/director.md",
      "config/metros.json",
      "apps/web/content/method.ts",
      "apps/web/content/trust/limits.json",
      "apps/web/app/method/content.mdx",
      "apps/web/app/trust/notes.md",
    ]) {
      expect(rules(scanText(file, `affinity ${score} here`)), file).toEqual(["decimal"]);
    }
  });

  it("is out of scope elsewhere", () => {
    for (const file of ["tools/probe/run-probe.ts", "apps/web/app/page.tsx", "packages/quant/src/stats.ts", "eval/questions.json"]) {
      expect(inDecimalScope(file), file).toBe(false);
      expect(scanText(file, `lon -${"86." + "7816"}`), file).toEqual([]);
    }
  });

  it.each([
    ["semantic version", "@anthropic-ai/sdk 0.131.0"],
    ["long semantic version", "1.0.1234"],
    ["IP address", "127.0.0.1 and 192.168.100.200"],
    ["two fractional digits", "0.92 to 0.97"],
    ["version tag", "v1.2345"],
    ["integer", "50000 calls"],
  ])("allows a %s", (_label, text) => {
    expect(scanText("docs/PLAN.md", text)).toEqual([]);
  });

  it("flags signed, thousands-separated, leading-dot and underscore-emphasised decimals", () => {
    const text = [`-${score}`, `1,234.5678`, `≈.1234`, `similarity _${score}_`].join("\n");
    expect(scanText("docs/a.md", text).map((f) => f.line)).toEqual([1, 2, 3, 4]);
  });
});

describe("anthropic key rule", () => {
  it("flags a key anywhere and never prints it", () => {
    const key = fakeAnthropicKey();
    const findings = scanText("tools/llm-bench/run.ts", `const key = "${key}";`);
    expect(rules(findings)).toEqual(["anthropic-key"]);
    expect(findings[0]?.message).not.toContain(key);
  });

  it("allows the bare prefix", () => {
    expect(scanText("apps/web/server/x.ts", `if (k.startsWith("sk-ant-")) {}`)).toEqual([]);
  });
});

describe("encodings and binaries", () => {
  const json = `{"entity_id":"${fakeUuid("e")}"}`;
  const FILE = "packages/qloo/test/fixtures/search.json";

  it("decodes UTF-16 with and without a BOM, as Windows PowerShell writes it", () => {
    const le = Buffer.from(json, "utf16le");
    expect(rules(scanContent(FILE, Buffer.concat([Buffer.from([0xff, 0xfe]), le])))).toEqual(["uuid"]);
    expect(rules(scanContent(FILE, le))).toEqual(["uuid"]);
    const be = Buffer.from(le).swap16();
    expect(rules(scanContent(FILE, Buffer.concat([Buffer.from([0xfe, 0xff]), be])))).toEqual(["uuid"]);
  });

  it("inflates gzip, including gzip inside gzip", () => {
    expect(rules(scanContent("fixtures/search.json.gz", gzipSync(json)))).toEqual(["uuid"]);
    expect(rules(scanContent("fixtures/search.json.gz.gz", gzipSync(gzipSync(json))))).toEqual(["uuid"]);
  });

  it("reports an unreadable binary unless its format is expected in the repository", () => {
    const bytes = Buffer.from([0, 1, 2]);
    expect(rules(scanContent("x.bin", bytes))).toEqual(["binary"]);
    expect(rules(scanContent("data.json.gz", Buffer.from([0x1f, 0x8b, 0, 0, 1])))).toEqual(["binary"]);
    for (const file of ["apps/web/app/favicon.ico", "design/board.pen", "a.PNG", "fonts/a.woff2"]) {
      expect(scanContent(file, bytes), file).toEqual([]);
    }
  });
});

describe("git sources", () => {
  let repo: TempRepo | undefined;
  afterEach(() => {
    repo?.cleanup();
    repo = undefined;
  });

  it("scans tracked and untracked files but skips ignored ones", { timeout: 30_000 }, () => {
    repo = new TempRepo();
    repo.write({
      ".gitignore": "secret-notes/\n",
      "src/ok.ts": "export const x = 1;\n",
      "src/pins.ts": `export const pin = "${fakeUuid("f")}";\n`,
      "secret-notes/pins.ts": `export const pin = "${fakeUuid("f")}";\n`,
      ".probe/raw.json": "{}\n",
      "favicon.ico": new Uint8Array([0, 1, 2, ...Buffer.from(fakeUuid("a"))]),
      "blob.bin": new Uint8Array([0, 1, 2]),
    });
    const { findings, scanned } = scanWorkingTree(repo.root);
    expect(scanned).toBe(6);
    expect(findings.map((f) => `${f.file}:${f.rule}`).sort()).toEqual([
      ".probe/raw.json:forbidden-path",
      "blob.bin:binary",
      "src/pins.ts:uuid",
    ]);
  });

  it("scans the staged blob when the file on disk differs or is gone", { timeout: 30_000 }, () => {
    repo = new TempRepo();
    repo.write({ "fixtures/edited.json": `{"id":"${fakeUuid("c")}"}\n`, "fixtures/deleted.json": `"${fakeUuid("d")}"\n` });
    repo.git(["add", "fixtures"]);
    repo.write({ "fixtures/edited.json": `{"id":"<entity>"}\n` });
    rmSync(path.join(repo.root, "fixtures/deleted.json"));

    const { findings } = scanWorkingTree(repo.root);
    expect(findings.map((f) => `${f.file}:${f.line}:${f.rule}`).sort()).toEqual([
      "fixtures/deleted.json:1:uuid",
      "fixtures/edited.json:1:uuid",
    ]);
  });

  it("reports a finding once when disk and index hold the same content", { timeout: 30_000 }, () => {
    repo = new TempRepo();
    repo.write({ "src/pins.ts": `export const pin = "${fakeUuid("f")}";\n` });
    repo.git(["add", "src/pins.ts"]);
    expect(rules(scanWorkingTree(repo.root).findings)).toEqual(["uuid"]);
  });

  it("flags UUIDs in file names in both modes", { timeout: 30_000 }, () => {
    repo = new TempRepo();
    const file = `fixtures/${fakeUuid("c")}.json`;
    const sha = repo.commit({ [file]: "{}\n" }, "fixture");
    repo.write({ [file]: "{}\n" });
    expect(scanWorkingTree(repo.root).findings).toMatchObject([{ file: "fixtures/<uuid>.json", rule: "uuid" }]);
    expect(scanHistory(repo.root).findings).toMatchObject([{ file: "fixtures/<uuid>.json", rule: "uuid", commit: sha }]);
  });

  it("keeps the invisible-character rule out of history, where a committed file cannot be fixed", { timeout: 30_000 }, () => {
    repo = new TempRepo();
    const hidden = String.fromCodePoint(0x200b);
    const file = { "src/a.ts": `export const s = "a${hidden}b";` };
    repo.commit(file, "first");
    repo.write(file);
    expect(scanHistory(repo.root).findings).toEqual([]);
    expect(rules(scanWorkingTree(repo.root).findings)).toEqual(["invisible-char"]);
  });

  it("scans commit messages and annotated tag messages", { timeout: 30_000 }, () => {
    repo = new TempRepo();
    const first = repo.commit({ "a.md": "fine\n" }, `Pin S1 entity ${fakeUuid("c")}`);
    const second = repo.commit({ "a.md": "fine\n" }, "second", first);
    repo.git(["tag", "-a", "v1", "-m", `release\n\n${REQUEST_ID_HEADER}: ${fakeRequestId()}`, second]);
    repo.git(["tag", "light", first]);

    const { findings } = scanHistory(repo.root);
    const tag = repo.git(["rev-parse", "refs/tags/v1"]);
    expect(findings).toEqual([
      expect.objectContaining({ file: "<commit message>", rule: "uuid", line: 1, column: 15, commit: first }),
      expect.objectContaining({ file: "<tag message>", rule: "request-id", line: 3, commit: tag }),
    ]);
  });

  it("finds data that was committed and later deleted, on any ref", { timeout: 30_000 }, () => {
    repo = new TempRepo();
    const first = repo.commit(
      { "notes.md": `pin ${fakeUuid("b")}\n`, ".private/data.json": "{}\n", "src/a.ts": "export {};\n" },
      "first",
    );
    repo.commit({ "src/a.ts": "export {};\n" }, "second", first);
    repo.commit({ "docs/score.md": `score ${"0." + "8123"}\n` }, "side branch", undefined, "refs/heads/side");

    expect(scanWorkingTree(repo.root).findings).toEqual([]);

    const { findings } = scanHistory(repo.root);
    const summary = findings.map((f) => `${f.file}:${f.rule}`).sort();
    expect(summary).toEqual([".private/data.json:forbidden-path", "docs/score.md:decimal", "notes.md:uuid"]);
    expect(findings.find((f) => f.rule === "uuid")).toMatchObject({ line: 1, column: 5, commit: first });
  });

  it("handles a repository with no commits", { timeout: 30_000 }, () => {
    repo = new TempRepo();
    expect(scanHistory(repo.root)).toEqual({ findings: [], scanned: 0 });
  });
});
