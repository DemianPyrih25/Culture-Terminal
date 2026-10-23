import { Pillar } from "@ct/contracts";
import type { BriefSort } from "./briefs-client";

/** The library's view, as its URL carries it: /briefs?q=&sort=&desk=. */
export interface LibraryParams {
  /** The question search, trimmed; "" for none. */
  q: string;
  sort: BriefSort;
  /** One desk, listed in full; null for every desk, the latest per desk. */
  desk: Pillar | null;
}

/** Longest search the library sends (GET /api/runs takes 200 characters). */
export const LIBRARY_SEARCH_MAX = 200;

const one = (value: string | string[] | undefined | null): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

/** The view from the page's search params; anything unknown falls back to the default. */
export function readLibraryParams(params: Record<string, string | string[] | undefined>): LibraryParams {
  const desk = Pillar.safeParse(one(params.desk));
  return {
    q: one(params.q).trim().slice(0, LIBRARY_SEARCH_MAX),
    sort: one(params.sort) === "conviction" ? "conviction" : "date",
    desk: desk.success ? desk.data : null,
  };
}

/** The library URL of a view; defaults are left out. */
export function libraryHref({ q, sort, desk }: LibraryParams): string {
  const params = new URLSearchParams();
  if (q.trim() !== "") params.set("q", q.trim());
  if (sort !== "date") params.set("sort", sort);
  if (desk !== null) params.set("desk", desk);
  const text = params.toString();
  return text === "" ? "/briefs" : `/briefs?${text}`;
}

/** Every desk, the latest few of each, only without a desk or a search; otherwise one flat list. */
export function isGrouped(params: Pick<LibraryParams, "q" | "desk">): boolean {
  return params.desk === null && params.q.trim() === "";
}
