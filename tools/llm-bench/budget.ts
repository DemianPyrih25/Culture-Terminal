import { formatUsd } from "./pricing";

/** Thrown when the next request could push total spend over the cap; nothing was sent. */
export class BudgetStop extends Error {
  constructor(
    readonly spentUsd: number,
    readonly estimateUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `budget guard: ${formatUsd(spentUsd)} spent + up to ${formatUsd(estimateUsd)} for the next request ` +
        `would exceed the cap of ${formatUsd(capUsd)}`,
    );
    this.name = "BudgetStop";
  }
}

/**
 * A hard spending cap. Callers ask before every request with an upper-bound estimate and charge
 * the real cost after it, so the total stays within the cap even if the request maxes out, as long
 * as the estimate's prompt-size assumption holds (callModel records any request where it did not).
 */
export class BudgetGuard {
  #spent = 0;

  constructor(readonly capUsd: number) {
    if (!(capUsd > 0) || !Number.isFinite(capUsd)) throw new RangeError(`budget cap must be a positive number, got ${capUsd}`);
  }

  get spentUsd(): number {
    return this.#spent;
  }

  allows(estimateUsd: number): boolean {
    return this.#spent + estimateUsd <= this.capUsd;
  }

  /** Throws BudgetStop when the request must not be sent. */
  reserve(estimateUsd: number): void {
    if (!this.allows(estimateUsd)) throw new BudgetStop(this.#spent, estimateUsd, this.capUsd);
  }

  charge(usd: number): void {
    if (!(usd >= 0) || !Number.isFinite(usd)) throw new RangeError(`charge must be a non-negative number, got ${usd}`);
    this.#spent += usd;
  }
}

/** Reads a USD cap from the environment, falling back to `fallback` when unset or empty. */
export function readUsdCap(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of US dollars, got "${raw}"`);
  return value;
}
