// Types only: the server's follow-up rule (RunManager.parentContext), read where the page renders.
import type { FollowUpBlock } from "../../server/run-list";

/** The answer a follow-up hangs from (PLAN §7.3), as /ask read it from the database. */
export interface AskParent {
  runId: string;
  /** The parent's question; null when the run could not be read. */
  question: string | null;
  /**
   * Why POST /api/runs would refuse it as the parent ("unreadable" when it could not be read): the
   * question then runs on its own. Null when the new answer follows up on it.
   */
  blocked: FollowUpBlock | "unreadable" | null;
}

/** Whether a run started here names the parent: only when the server will take it. */
export function followsUp(parent: AskParent | null): parent is AskParent & { blocked: null } {
  return parent !== null && parent.blocked === null;
}
