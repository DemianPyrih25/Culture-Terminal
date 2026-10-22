import type { Anthropic } from "./deps";

/**
 * Append-only conversation history. Sonnet 5.5 and Haiku 5.5 bind thinking blocks to the exact
 * prefix that produced them, and editing an earlier turn also breaks the prompt cache, so the
 * only operation is push. Assistant turns are stored as the response's own content array.
 */
export class History {
  readonly #messages: Anthropic.Beta.BetaMessageParam[] = [];

  push(message: Anthropic.Beta.BetaMessageParam): void {
    this.#messages.push(message);
  }

  /** The response content goes back unchanged: thinking blocks, signatures and all. */
  pushAssistant(message: Anthropic.Beta.BetaMessage): void {
    this.#messages.push({ role: "assistant", content: message.content });
  }

  get messages(): readonly Anthropic.Beta.BetaMessageParam[] {
    return this.#messages;
  }

  get length(): number {
    return this.#messages.length;
  }
}

export function textBlock(text: string): Anthropic.Beta.BetaTextBlockParam {
  return { type: "text", text };
}
