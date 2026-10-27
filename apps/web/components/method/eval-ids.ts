/**
 * The ids the offline eval writes its headline metrics under (SPEC §6.6, §6.7), and the ordinal the eval
 * prints. Read by tools/eval; the schema and parser of the summary itself are
 * components/method/eval-summary.ts.
 */

/** The headline metrics in summary.metrics, by id; the eval writes them under these ids. */
export const EVAL_METRIC_IDS = {
  /** Hypotheses refuted or qualified by the data, of all planned ones. */
  refuted: "refutation_rate",
  /** Numbers bound to a request: grounded, and GHOST (the same model without Qloo) in `ghost`. */
  traced: "traceability",
  /** Adversarial questions handled as pre-registered. */
  adversarial: "adversarial_accuracy",
} as const;

/** "81st", "52nd", "3rd", "11th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}
