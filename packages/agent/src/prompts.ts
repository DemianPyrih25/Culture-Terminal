// The frozen system prompts (PLAN §4.5). The Markdown sources in packages/agent/prompts/ are bundled
// into prompts.generated.ts by `pnpm prompts:build`, because the Next.js server bundle cannot read
// them from disk. Each prompt is identical on every request, so the system prefix stays cacheable;
// everything that changes per run goes in the first user message.
//
// DIRECTOR_PROMPT is the ANALYST system prompt (director.md), CLERK_PROMPT the CLERK's (clerk.md) and
// GHOST_PROMPT GHOST's (ghost.md).
// PROMPT_HASHES holds the sha256 of each prompt exactly as sent, keyed by file name, so receipts and
// replays can record which prompt version produced a run.
export { CLERK_PROMPT, DIRECTOR_PROMPT, GHOST_PROMPT, PROMPT_HASHES } from "./prompts.generated";
