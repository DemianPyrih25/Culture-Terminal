"use client";

import type { KeyboardEvent, Ref } from "react";
import { cx } from "../ui/cx";
import type { CompiledCommand } from "../../lib/grammar/parse";
import type { AskState } from "./ask-machine";
import { AskPanel, askPanelShown, askStatusText, type AskParent } from "./ask-panel";
import { QuestionField, type QuestionFieldHandle } from "./question-field";

export interface AskComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter in the field, with the trimmed question. */
  onSubmit: (question: string) => void;
  /** Esc cleared the field. */
  onClear?: () => void;
  /** ⌘↵ / Ctrl+↵: open the brief that already answers the question. */
  onOpenExisting?: () => void;
  state: AskState;
  compiled: CompiledCommand | null;
  parent?: AskParent | null;
  onEdit?: () => void;
  onRun?: () => void;
  onRetry?: () => void;
  onAsk?: (question: string) => void;
  onDropParent?: () => void;
  autoFocus?: boolean;
  /** Binds / to the field (default true); off in the gallery, which shows several. */
  slashShortcut?: boolean;
  /** Draws the field focused without focus (the gallery's stills). */
  showFocus?: boolean;
  /** The kicker is the page's h1 on the Ask page; the gallery shows it as plain text. */
  kickerAs?: "h1" | "p";
  fieldRef?: Ref<QuestionFieldHandle>;
  className?: string;
}

const NAV_SELECTOR = "textarea, [data-ask-nav]";

/**
 * Whether ↑ or ↓ leaves the question field for the panel: ↓ from the end of the text, ↑ from its start,
 * so inside a question that wraps the arrows still move the caret between its lines.
 */
export function arrowLeavesField(key: "ArrowUp" | "ArrowDown", selectionStart: number, selectionEnd: number, length: number): boolean {
  if (selectionStart !== selectionEnd) return false;
  return key === "ArrowDown" ? selectionEnd === length : selectionStart === 0;
}

/** ↑ ↓ move between the field and the panel's controls, wrapping at either end. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const target = event.target as HTMLElement;
  if (target instanceof HTMLTextAreaElement && !arrowLeavesField(event.key, target.selectionStart, target.selectionEnd, target.value.length)) {
    return;
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(NAV_SELECTOR)].filter(
    (el) => !(el as HTMLButtonElement).disabled,
  );
  const at = items.indexOf(target);
  if (at < 0 || items.length < 2) return;
  event.preventDefault();
  const next = items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
  next?.focus();
}

/**
 * A02's composer: the kicker, A/Question field in its typing state and the composing panel under it,
 * with the keys of the footer (↑ ↓ move, ⇥ to the reading's Edit, ⌘↵ open the existing brief). The
 * live region announces the reading as it arrives. Controlled by AskView, or by the /dev/ask gallery.
 */
export function AskComposer({
  value,
  onChange,
  onSubmit,
  onClear,
  onOpenExisting,
  state,
  compiled,
  parent = null,
  onEdit,
  onRun,
  onRetry,
  onAsk,
  onDropParent,
  autoFocus = false,
  slashShortcut = true,
  showFocus = false,
  kickerAs: Kicker = "h1",
  fieldRef,
  className,
}: AskComposerProps) {
  const draft = value.trim();
  const shown = askPanelShown(state, draft, parent);

  function onFieldKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onOpenExisting) {
      event.preventDefault();
      onOpenExisting();
    }
  }

  return (
    <div className={cx("flex w-full flex-col", className)} onKeyDown={moveFocus}>
      <Kicker className="pb-[14px] text-[11px] leading-[13px] font-semibold tracking-[1.3px] text-dim uppercase">
        Taste intelligence for investors
      </Kicker>
      <QuestionField
        ref={fieldRef}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        onClear={onClear}
        onKeyDown={onFieldKeyDown}
        autoFocus={autoFocus}
        slashShortcut={slashShortcut}
        showFocus={showFocus}
        attached={shown}
      />
      <AskPanel
        state={state}
        draft={draft}
        compiled={compiled}
        parent={parent}
        onEdit={onEdit}
        onRun={onRun}
        onRetry={onRetry}
        onAsk={onAsk}
        onDropParent={onDropParent}
      />
      <p role="status" aria-live="polite" className="sr-only">
        {askStatusText(state, draft)}
      </p>
    </div>
  );
}
