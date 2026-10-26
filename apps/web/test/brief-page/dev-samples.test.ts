// The /dev/brief viewer reads any recorded sample in server/samples from disk, so a sample the agent
// stream adds shows up without a code change; names are checked before they reach the file system.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { listSampleFiles, readSampleFile, samplesDir } from "../../app/dev/brief/samples";

vi.mock("server-only", () => ({}));

const scratch = mkdtempSync(path.join(tmpdir(), "ct-dev-samples-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("dev samples", () => {
  it("finds the samples folder from apps/web or the repo root", () => {
    expect(listSampleFiles(samplesDir())).toEqual(expect.arrayContaining(["brand-health", "brand-health-incomplete", "needs-input"]));
  });

  it("reads every recorded sample on disk against the RunEvent schema", () => {
    for (const name of listSampleFiles()) {
      const sample = readSampleFile(name);
      expect(sample.kind, name).toBe("ok");
      if (sample.kind === "ok") expect(sample.events[0]?.type).toBe("run.created");
    }
  });

  it("refuses unknown and unsafe names, and reports a file that does not parse", () => {
    writeFileSync(path.join(scratch, "broken-run.events.json"), JSON.stringify([{ type: "nope" }]));
    writeFileSync(path.join(scratch, "notes.json"), "[]");
    expect(listSampleFiles(scratch)).toEqual(["broken-run"]);
    expect(readSampleFile("broken-run", scratch)).toMatchObject({ kind: "invalid", name: "broken-run" });
    for (const name of ["../broken-run", "Broken", "missing", ""]) expect(readSampleFile(name, scratch)).toEqual({ kind: "missing" });
  });
});
