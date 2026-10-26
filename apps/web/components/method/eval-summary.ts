import { z } from "zod";

/**
 * apps/web/content/eval-summary.json: the aggregates the offline eval publishes (SPEC §6.7), read by
 * /method#eval. Aggregates only, never a single answer. Rates are fractions from 0 to 1 and every
 * number keeps at most two decimals (pnpm guard's decimal rule covers apps/web/content).
 *
 * {
 *   "ranAt": "2026-10-30",
 *   "model": "claude-sonnet-5-5",
 *   "questions": { "total": 16, "adversarial": 4 },
 *   "metrics": [
 *     { "id": "refutation_rate", "label": "Priors refuted or qualified", "unit": "rate", "grounded": 0.42, "ghost": null }
 *   ],
 *   "realityCheck": { "cases": 12, "medianPercentile": 0.81, "ghostHitRate": 0.25 }
 * }
 */

export const EvalUnit = z.enum(["rate", "count", "seconds", "usd", "number"]);
export type EvalUnit = z.infer<typeof EvalUnit>;

const Rate = z.number().min(0).max(1);

export const EvalMetric = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  unit: EvalUnit,
  /** The full system. */
  grounded: z.number().nullable(),
  /** The same model with no tools; null where the measure does not apply to it. */
  ghost: z.number().nullable(),
  note: z.string().nullish(),
});
export type EvalMetric = z.infer<typeof EvalMetric>;

export const EvalSummary = z.object({
  /** When the eval ran: an ISO date or date-time. */
  ranAt: z.string().min(1),
  /** The analyst model both arms used. */
  model: z.string().min(1),
  questions: z.object({ total: z.int().positive(), adversarial: z.int().nonnegative() }),
  metrics: z.array(EvalMetric).min(1),
  realityCheck: z
    .object({
      cases: z.int().positive(),
      /** The real choice's median percentile in Qloo scoring; random expectation 0.5. */
      medianPercentile: Rate.nullable(),
      /** How often the real choice was among the model-alone picks. */
      ghostHitRate: Rate.nullable(),
      note: z.string().nullish(),
    })
    .nullable(),
});
export type EvalSummary = z.infer<typeof EvalSummary>;

/** What /method#eval shows: nothing run yet, a file it could not read, or the summary. */
export type EvalState = { state: "missing" } | { state: "invalid"; reason: string } | { state: "ok"; summary: EvalSummary };

/** Parses the file's text; a bad file is reported, never shown as numbers. */
export function parseEvalSummary(text: string): EvalState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { state: "invalid", reason: `not JSON: ${(err as Error).message}` };
  }
  const parsed = EvalSummary.safeParse(raw);
  return parsed.success ? { state: "ok", summary: parsed.data } : { state: "invalid", reason: z.prettifyError(parsed.error) };
}

const trimZeros = (text: string) => text.replace(/\.0+$|(\.\d*?)0+$/, "$1");

/** One value as printed: "42%", "52 s", "$0.18", "1,204", "3.5"; an absent one is a dash. */
export function formatEvalValue(value: number | null, unit: EvalUnit): string {
  if (value === null || !Number.isFinite(value)) return "–";
  switch (unit) {
    case "rate":
      return `${Math.round(value * 100)}%`;
    case "seconds":
      return `${trimZeros(value.toFixed(1))} s`;
    case "usd":
      return `$${value.toFixed(2)}`;
    case "count":
      return Math.round(value).toLocaleString("en-US");
    case "number":
      return trimZeros(value.toFixed(2));
  }
}
