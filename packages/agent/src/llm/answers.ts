import type Anthropic from "@anthropic-ai/sdk";
import type { AnalystToolResult } from "../analyst";
import { errorText, type AnalystToolErrorCode } from "./notices";

export interface Answer {
  content: string;
  isError: boolean;
  /** Set when the loop wrote the is_error result itself. */
  code: AnalystToolErrorCode | null;
  executed: boolean;
}

const NO_RESULT: Answer = {
  content: errorText("TOOL_FAILED", "no result was produced for this call."),
  isError: true,
  code: "TOOL_FAILED",
  executed: false,
};

/**
 * The answers to every tool_use block of one response. All of them go back together in ONE user
 * message, in the order the model made the calls, and none is ever left without a tool_result.
 */
export class Answers {
  readonly #byId = new Map<string, Answer>();

  constructor(readonly uses: readonly Anthropic.Beta.BetaToolUseBlock[]) {}

  accept(use: Anthropic.Beta.BetaToolUseBlock, content: string): void {
    this.#byId.set(use.id, { content, isError: false, code: null, executed: false });
  }

  reject(use: Anthropic.Beta.BetaToolUseBlock, code: AnalystToolErrorCode, message: string, issues: readonly string[] = []): void {
    this.#byId.set(use.id, { content: errorText(code, message, issues), isError: true, code, executed: false });
  }

  executed(id: string, result: AnalystToolResult | undefined): void {
    this.#byId.set(id, result ? { content: result.content, isError: result.is_error === true, code: null, executed: true } : { ...NO_RESULT, executed: true });
  }

  get(use: Anthropic.Beta.BetaToolUseBlock): Answer {
    return this.#byId.get(use.id) ?? NO_RESULT;
  }
}
