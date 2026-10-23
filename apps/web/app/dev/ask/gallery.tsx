"use client";

import { useState } from "react";
import { AskComposer } from "../../../components/ask/ask-composer";
import { ASK_GALLERY } from "../../../components/ask/fixtures";
import { parseCommand } from "../../../lib/grammar/parse";

/** One state of the Ask panel; the field can be typed in, nothing is sent. */
function Slot({ entry }: { entry: (typeof ASK_GALLERY)[number] }) {
  const [value, setValue] = useState(entry.draft);
  return (
    <AskComposer
      value={value}
      onChange={setValue}
      onSubmit={() => undefined}
      state={entry.state}
      compiled={parseCommand(value)}
      parent={entry.parent ?? null}
      onEdit={() => undefined}
      onRun={() => undefined}
      onRetry={() => undefined}
      onAsk={() => undefined}
      onDropParent={() => undefined}
      slashShortcut={false}
      showFocus
      kickerAs="p"
    />
  );
}

/** Every Ask state from fixtures, at the composer's 960 px. */
export function AskGallery() {
  return (
    <ol className="flex flex-col gap-14">
      {ASK_GALLERY.map((entry, i) => (
        <li key={entry.name} className="flex flex-col gap-3">
          <h2 className="font-mono text-[11px] text-faint">
            {String(i + 1).padStart(2, "0")} · {entry.name}
          </h2>
          <Slot entry={entry} />
        </li>
      ))}
    </ol>
  );
}
