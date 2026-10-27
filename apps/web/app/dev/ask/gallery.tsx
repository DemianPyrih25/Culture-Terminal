"use client";

import { useState, type ReactNode } from "react";
import { askNotice, isBusy } from "../../../components/ask/ask-machine";
import { followsUp } from "../../../components/ask/ask-parent";
import { ASK_GALLERY, FIXTURE_AT, type AskGalleryEntry } from "../../../components/ask/fixtures";
import { AskNoticeView } from "../../../components/home/ask-notice";
import { QuestionBox } from "../../../components/home/question-box";
import { SuggestionList } from "../../../components/home/suggestion-list";
import { suggestionsFor } from "../../../components/home/suggestions";
import type { AnswerItem } from "../../../components/library/answers";
import { YourAnswersView, type YourAnswersState } from "../../../components/library/your-answers";

/** One state of the question box; the field can be typed in, nothing is sent. */
function BoxSlot({ entry, index }: { entry: AskGalleryEntry; index: number }) {
  const [value, setValue] = useState(entry.draft);
  const notice = askNotice(entry.state, entry.pause ?? null, "UTC");
  const busy = isBusy(entry.state);
  const parent = entry.parent ?? null;
  return (
    <div className="flex w-full max-w-[880px] flex-col gap-3">
      <QuestionBox
        id={`ask-gallery-${index}`}
        value={value}
        onChange={setValue}
        onSubmit={() => undefined}
        state={busy ? "loading" : entry.pause || entry.state.phase.kind === "paused" ? "paused" : "idle"}
        loadingLabel={entry.state.run.kind === "starting" ? "Starting…" : "Reading…"}
        followUp={followsUp(parent) ? { label: parent.question ?? "your last answer", onDrop: () => undefined } : null}
        placeholder={followsUp(parent) ? "Ask a follow-up about this answer" : undefined}
        showFocus={entry.focus}
      />
      {notice ? <AskNoticeView notice={notice} onReframe={() => undefined} onRetry={() => undefined} /> : null}
    </div>
  );
}

function Section({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-3">
      <h2 className="m-0 type-label text-ink-2">
        {String(index).padStart(2, "0")} · {title}
      </h2>
      {children}
    </li>
  );
}

const DAY = "2026-07-06T09:40:00.000Z";

/** Invented answers, one per row state. */
const ROWS: AnswerItem[] = [
  { runId: "run-fixture-0001", question: "Which cities love Juniper Cola most?", status: "working", note: "Working…", createdAt: DAY },
  { runId: "run-fixture-0002", question: "Juniper Cola vs Brand Beta, by city", status: "done", note: "Brand Beta holds the coasts.", createdAt: DAY },
  { runId: "run-fixture-0003", question: "Who is the Artist Nova audience?", status: "partial", note: "Partial answer", createdAt: "2026-07-05T18:00:00.000Z" },
  { runId: "run-fixture-0004", question: "Where to open a listening bar in Riverside?", status: "stopped", note: "Stopped", createdAt: "2026-06-30T10:00:00.000Z" },
];

const LIST_STATES: { title: string; state: YourAnswersState }[] = [
  { title: "Your answers · rows", state: { kind: "ready", items: ROWS, now: FIXTURE_AT } },
  { title: "Your answers · empty", state: { kind: "ready", items: [], now: FIXTURE_AT } },
  { title: "Your answers · loading", state: { kind: "loading" } },
  { title: "Your answers · error", state: { kind: "error", message: "Your answers couldn't be loaded.", retry: true } },
];

/** Every state of the question box, the suggestion list and Your answers, from fixtures. */
export function AskGallery() {
  const suggestions = suggestionsFor("Juniper Cola");
  let n = 0;
  return (
    <ol className="m-0 flex list-none flex-col gap-12 p-0">
      {ASK_GALLERY.map((entry, i) => (
        <Section key={entry.name} index={++n} title={entry.name}>
          <BoxSlot entry={entry} index={i} />
        </Section>
      ))}
      <Section index={++n} title="Suggestion list (a name typed)">
        <div className="w-full max-w-[880px]">
          <SuggestionList id="ask-gallery-list" groups={suggestions} activeKey={suggestions[0]?.rows[0]?.key ?? null} onPick={() => undefined} />
        </div>
      </Section>
      {LIST_STATES.map((entry) => (
        <Section key={entry.title} index={++n} title={entry.title}>
          <YourAnswersView state={entry.state} timeZone="UTC" onRetry={() => undefined} />
        </Section>
      ))}
    </ol>
  );
}
