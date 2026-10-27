import { AnswerMissing } from "@/components/working/missing";

/**
 * The permalink of a run that has no finished answer (a 404): still being made, or ended without one
 * (failed, stopped, waiting for a pick). One line and the way to the run itself, where it streams live or
 * shows where it stopped.
 */
export function RunPending({ runId, ended }: { runId: string; ended: boolean }) {
  return <AnswerMissing kind={ended ? "no_answer" : "running"} runId={runId} />;
}
