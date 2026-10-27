"use client";

import { useMemo } from "react";
import { buildAnswerModel, type AnswerKeyNumber } from "../../lib/answer";
import type { BriefModel, Footnote } from "../../lib/brief";
import { HowWeKnowProvider, type NumberCopy } from "../drawer";
import { AnswerPage, type AnswerPageProps, type AnswerPageState } from "./answer-page";

/**
 * A finished answer with its How we know drawer around it: /r/[id] and the /dev/brief samples. (A run's
 * own page, /run/[id], wraps AnswerPage the same way once its report arrives.)
 */

/** The answer's words for each footnote, for the drawer's focus card: a key number's value, a chart's title. */
export function answerNumberCopy(
  keyNumbers: readonly AnswerKeyNumber[],
  charts: readonly ({ footnote: number; title: string } | null)[],
): (note: Footnote) => NumberCopy | null {
  const byNote = new Map<number, NumberCopy>();
  for (const k of keyNumbers) {
    if (k.footnote === null) continue;
    byNote.set(k.footnote, k.variant === "split" ? { description: k.label } : { value: k.value, description: k.context ? `${k.label}: ${k.context}` : k.label });
  }
  for (const c of charts) if (c && !byNote.has(c.footnote)) byNote.set(c.footnote, { description: c.title });
  return (note) => byNote.get(note.n) ?? null;
}

export function PermalinkAnswer(props: Omit<AnswerPageProps, "state"> & { state: AnswerPageState; model: BriefModel }) {
  const { model, state } = props;
  const describe = useMemo(() => {
    const answer = buildAnswerModel(
      model,
      { resolves: state.resolves, ghost: state.ghost ?? null, report: state.report ?? null, metrics: state.metrics },
      { datasets: props.datasets ?? {} },
    );
    return answerNumberCopy(answer.keyNumbers, [answer.charts.main, answer.charts.second, answer.charts.map]);
  }, [model, state, props.datasets]);
  const ghost = (state.ghost ?? state.report?.ghost ?? null) !== null;
  return (
    <HowWeKnowProvider model={model} evidence={state.evidence} ghost={ghost} describe={describe}>
      <AnswerPage {...props} />
    </HowWeKnowProvider>
  );
}
