import type { QlooParams } from "@ct/contracts";

/** A request the synthetic API answers with HTTP 400 and `{"error": message}`, as Qloo does. */
export class MockBadRequest extends Error {
  override readonly name = "MockBadRequest";
}

/** Page size when a request sends no `take`, matching the API's default. */
export const DEFAULT_TAKE = 20;

export function readString(params: QlooParams, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  // The only object in QlooParamValue is a list.
  return typeof value === "object" ? value.join(",") : String(value);
}

/** A comma list or a string array, trimmed, without empties or duplicates, in request order. */
export function readList(params: QlooParams, key: string): string[] {
  const value = params[key];
  if (value === undefined) return [];
  const items = typeof value === "object" ? value : String(value).split(",");
  return [...new Set(items.map((s) => s.trim()).filter((s) => s.length > 0))];
}

export function readNumber(params: QlooParams, key: string): number | undefined {
  const raw = params[key];
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : Number(readString(params, key));
  if (!Number.isFinite(n)) throw new MockBadRequest(`${key} must be a number`);
  return n;
}

export function readBool(params: QlooParams, key: string): boolean {
  const raw = params[key];
  return raw === true || raw === "true";
}

/** `take` and `page` as a slice window over a ranked list. */
export function readWindow(params: QlooParams): { take: number; offset: number } {
  const take = Math.trunc(readNumber(params, "take") ?? DEFAULT_TAKE);
  const page = Math.trunc(readNumber(params, "page") ?? 1);
  if (take < 1) throw new MockBadRequest("take must be at least 1");
  if (page < 1) throw new MockBadRequest("page must be at least 1");
  return { take, offset: (page - 1) * take };
}

export function applyWindow<T>(items: readonly T[], params: QlooParams): T[] {
  const { take, offset } = readWindow(params);
  return items.slice(offset, offset + take);
}
