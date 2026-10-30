import type { AiContextBlock, MarketId, WebContextBlock } from "@ct/contracts";
import { AI_CONTEXT_KIND_LABEL, AI_CONTEXT_KIND_VALUES } from "@ct/contracts/values";
import { formatUtcDate } from "../brief/format";

/**
 * The two context blocks under "Why we think this" (R4, R5, D45): "What AI knows (not verified)" and
 * "From the web", shaped for their cards. They sit apart from the measured answer and never change it:
 * the AI block carries no numbers (code drops any item that states one), and the web block keeps only
 * cited sentences with their link. A block a run stored before Part 11 is absent and draws nothing. Pure.
 */

/** "claude-sonnet-5-5" → "Claude Sonnet 5.5"; another id stays as it is. */
export function contextModelName(model: string | null): string | null {
  if (!model) return null;
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model);
  if (!m) return model;
  const [, family = "", major, minor] = m;
  return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

/** Only an http(s) link without credentials is ever rendered as a link (the contract checks it too). */
export function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username !== "" || u.password !== "") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export interface AiContextView {
  status: AiContextBlock["status"];
  /** Items grouped by kind, in AI_CONTEXT_KIND_VALUES order; empty unless the block is ok. */
  groups: { kind: AiContextBlock["items"][number]["kind"]; label: string; items: { topic: string; text: string }[] }[];
  /** One line for a block that is not ok (off, empty, timed out, failed); null when ok. */
  note: string | null;
  /** "Model: Claude Sonnet 5.5 · generated 30 Oct 2026 · not verified". */
  footer: string;
}

export interface WebContextItemView {
  claim: string;
  url: string;
  /** "example.com: The page title". */
  linkText: string;
  /** "published April 30, 2025", or "date unknown". */
  published: string;
  /** "retrieved 30 Oct 2026". */
  retrieved: string;
}

export interface WebContextView {
  status: WebContextBlock["status"];
  items: WebContextItemView[];
  note: string | null;
  /** "3 searches"; with a saved copy "3 searches · saved copy". */
  footer: string;
}

export interface AnswerContext {
  ai: AiContextView | null;
  web: WebContextView | null;
  /** Market ids the AI block reports the subject already operates in: the market rows' chips. */
  presence: MarketId[];
}

const NOTE_FALLBACK: Readonly<Record<AiContextBlock["status"], string | null>> = {
  ok: null,
  empty: "Nothing to add.",
  off: "This step is off on this server.",
  timed_out: "This step ran out of time.",
  failed: "This step failed.",
};

const noteOf = (status: AiContextBlock["status"], note: string | null) => (status === "ok" ? null : (note?.trim() || NOTE_FALLBACK[status]));

export function aiContextView(block: AiContextBlock): AiContextView {
  const groups = block.status !== "ok"
    ? []
    : AI_CONTEXT_KIND_VALUES.flatMap((kind) => {
        const items = block.items.filter((i) => i.kind === kind).map((i) => ({ topic: i.topic.trim(), text: i.text.trim() }));
        return items.length > 0 ? [{ kind, label: AI_CONTEXT_KIND_LABEL[kind], items }] : [];
      });
  const model = contextModelName(block.model);
  const footer = [
    model ? `Model: ${model}` : null,
    block.generatedAt ? `generated ${formatUtcDate(block.generatedAt)}` : null,
    "not verified",
  ]
    .filter(Boolean)
    .join(" · ");
  return { status: groups.length === 0 && block.status === "ok" ? "empty" : block.status, groups, note: groups.length === 0 ? noteOf(block.status === "ok" ? "empty" : block.status, block.note) : null, footer };
}

/**
 * "published 27 Apr 2026" from the calendar date when the page age gave one; a coarse relative age keeps
 * its words but counts from the retrieval ("published 3 months before retrieval"), so a stored answer
 * never says "3 months ago" long after; else "date unknown".
 */
function publishedText(published: string | null | undefined, publishedIso: string | null | undefined): string {
  if (publishedIso) return `published ${formatUtcDate(publishedIso)}`;
  const raw = published?.trim();
  if (!raw) return "date unknown";
  return /\bago$/i.test(raw) ? `published ${raw.replace(/\s*ago$/i, " before retrieval")}` : `published ${raw}`;
}

export function webContextView(block: WebContextBlock): WebContextView {
  const items = block.status !== "ok"
    ? []
    : block.items.flatMap((i) => {
        const url = safeHttpUrl(i.url);
        if (!url) return [];
        const title = i.title.trim();
        return [
          {
            claim: i.claim.trim(),
            url,
            linkText: title ? `${i.publisher}: ${title}` : i.publisher,
            published: publishedText(i.published, i.publishedIso),
            retrieved: `retrieved ${formatUtcDate(i.retrievedAt)}`,
          },
        ];
      });
  const searches = `${block.searches} ${block.searches === 1 ? "search" : "searches"}`;
  const status = items.length === 0 && block.status === "ok" ? "empty" : block.status;
  return {
    status,
    items,
    note: items.length === 0 ? noteOf(status, block.note) : null,
    footer: block.cached ? `${searches} · saved copy` : searches,
  };
}

/**
 * The page's context: the report's blocks when the run finished (they are stored in it), else the
 * blocks the live run streamed (`context.ai`, `context.web`). Null blocks draw nothing.
 */
export function buildAnswerContext(source: {
  report?: { aiContext?: AiContextBlock | null; webContext?: WebContextBlock | null } | null;
  aiContext?: AiContextBlock | null;
  webContext?: WebContextBlock | null;
}): AnswerContext {
  const ai = source.report?.aiContext ?? source.aiContext ?? null;
  const web = source.report?.webContext ?? source.webContext ?? null;
  return {
    ai: ai ? aiContextView(ai) : null,
    web: web ? webContextView(web) : null,
    presence: ai && ai.status === "ok" ? [...ai.presenceMarkets] : [],
  };
}
