// The repository's own config keeps secrets and the private Qloo cache out of git, out of the Docker
// build context and off the network (D29). Checked against the real files, so a loosened pattern
// fails here before anything is staged.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { tempDir } from "./test-utils";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

// A user's global excludes file must not decide the result, so it is pointed at an empty file.
const scratch = tempDir("ignore");
const noExcludes = path.join(scratch, "excludes");
writeFileSync(noExcludes, "");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Whether the repository's .gitignore rules ignore a path. Nothing is created or read at that path. */
function ignoredByGit(file: string): boolean {
  const res = spawnSync("git", ["-c", `core.excludesFile=${noExcludes}`, "check-ignore", "--no-index", "-q", file], {
    cwd: root,
  });
  if (res.status !== 0 && res.status !== 1) throw new Error(`git check-ignore ${file}: ${res.stderr.toString()}`);
  return res.status === 0;
}

const SECRET_AND_DUMP_NAMES = [
  ".env",
  ".env.local",
  ".env-backup",
  ".env_old",
  ".envrc",
  "apps/web/.env.local",
  "apps/web/.env-backup",
  "backups/dev.dump",
  "backups/dev.backup",
  "backups/dev.pgdump",
  "backups/dev.sql.gz",
];

describe(".gitignore", () => {
  it.each(SECRET_AND_DUMP_NAMES)("ignores %s", (file) => {
    expect(ignoredByGit(file)).toBe(true);
  });

  it.each([".env.example", "apps/web/.env.example"])("keeps %s tracked", (file) => {
    expect(ignoredByGit(file)).toBe(false);
  });
});

describe(".dockerignore", () => {
  const lines = read(".dockerignore")
    .split(/\r?\n/)
    .map((l) => l.trim());

  it.each(["**/.env*", "**/*.dump", "**/*.backup", "**/*.pgdump", "**/*.sql.gz", ".probe", ".private", "eval/raw"])(
    "excludes %s from the build context",
    (pattern) => {
      expect(lines).toContain(pattern);
    },
  );

  it("never re-includes an environment file", () => {
    expect(lines.filter((l) => l.startsWith("!") && l.includes(".env"))).toEqual([]);
  });
});

/** The short-syntax entries of every `ports:` list in a compose file. */
function composePorts(yaml: string): string[] {
  const ports: string[] = [];
  let indent = -1;
  for (const line of yaml.split(/\r?\n/)) {
    const key = /^(\s*)ports:\s*$/.exec(line);
    if (key) {
      indent = key[1]?.length ?? 0;
      continue;
    }
    if (indent < 0 || line.trim() === "" || line.trim().startsWith("#")) continue;
    const item = /^(\s*)-\s*"?([^"#]*?)"?\s*(?:#.*)?$/.exec(line);
    if (item && (item[1]?.length ?? 0) >= indent) ports.push(item[2] ?? "");
    else indent = -1;
  }
  return ports;
}

describe("docker-compose.yml", () => {
  it("publishes every port on the loopback interface only", () => {
    const ports = composePorts(read("docker-compose.yml"));
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it("reads short-syntax port lists", () => {
    const yaml = ["services:", "  a:", "    ports:", '      - "5433:5432"', "      - 127.0.0.1:8080:80 # web", "    volumes:", "      - x:/y"];
    expect(composePorts(yaml.join("\n"))).toEqual(["5433:5432", "127.0.0.1:8080:80"]);
  });
});

describe("Dockerfile", () => {
  it("copies every workspace manifest before the frozen install, so the image builds every package", () => {
    const dockerfile = read("Dockerfile");
    const manifests = ["apps", "packages"].flatMap((dir) =>
      readdirSync(path.join(root, dir), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(path.join(root, dir, e.name, "package.json")))
        .map((e) => `${dir}/${e.name}/package.json`),
    );
    expect(manifests.length).toBeGreaterThan(5);
    for (const manifest of manifests) expect(dockerfile, manifest).toContain(`COPY ${manifest} ${path.posix.dirname(manifest)}/`);
  });
});
