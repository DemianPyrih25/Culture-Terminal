import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** .private/ is gitignored (D29): raw bench output stays on this machine. */
export const OUTPUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.private/llm-bench");

/** An ISO timestamp that is also a valid Windows file name (no colons). */
export function fileStamp(date: Date): string {
  return date.toISOString().replace(/:/g, "-");
}

export function writeResult(name: string, data: unknown): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return file;
}
