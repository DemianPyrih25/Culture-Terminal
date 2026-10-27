"use client";

import { QUESTION_MAX_CHARS } from "@ct/contracts";
import { useImperativeHandle, useLayoutEffect, useRef, type FormEvent, type KeyboardEvent, type Ref, type RefObject } from "react";
import { Button } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";

/** The box's placeholder: what to ask, in general words. */
export const QUESTION_PLACEHOLDER = "Type a question about a brand, artist, place or audience";

/** The parts of a key press the box's Enter rule reads. */
export interface QuestionKey {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}

/**
 * What a key press does in the field: Enter asks ("submit"), Shift+Enter does nothing ("ignore": a
 * question is one paragraph); anything else, and Enter that ends an IME composition, is the field's own.
 */
export function questionKeyAction(event: QuestionKey): "submit" | "ignore" | null {
  if (event.key !== "Enter" || event.isComposing) return null;
  return event.shiftKey ? "ignore" : "submit";
}

/** The field's text as one paragraph: a pasted line break becomes a space. */
export function questionText(raw: string): string {
  return raw.replace(/\r\n?|\n/g, " ");
}

/** Grows the field with its text where CSS cannot (field-sizing: content is missing in Firefox). */
function useFitHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const area = ref.current;
    if (!area || CSS.supports("field-sizing", "content")) return;
    const fit = () => {
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ref, value]);
}

/** idle and typing follow focus; loading reads the question; paused disables the button. */
export type QuestionBoxState = "idle" | "loading" | "paused";

/** The suggestion list's wiring for the field (a textbox with list autocomplete, not role=combobox). */
export interface QuestionCombobox {
  expanded: boolean;
  listId: string;
  activeId: string | null;
}

export interface QuestionBoxProps {
  /** The field's id: "ask" on Home, so "New question" lands in it. */
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Get answer or Enter, with the trimmed question; an empty box sends nothing. */
  onSubmit: (question: string) => void;
  /** Keys the page handles first (the suggestion list's arrows, Enter on a row, Esc). */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  state?: QuestionBoxState;
  /** The busy button's word: "Reading…" while the question is read, "Starting…" as the run starts. */
  loadingLabel?: string;
  placeholder?: string;
  /** A follow-up: the pill above the field, with x to ask on its own. */
  followUp?: { label: string; onDrop?: () => void } | null;
  combobox?: QuestionCombobox;
  /** Ids of the elements that describe the field (the inline state under the box). */
  describedBy?: string;
  autoFocus?: boolean;
  /** Draws the focused look without focus, for the /dev/ask gallery. */
  showFocus?: boolean;
  fieldRef?: Ref<HTMLTextAreaElement>;
  className?: string;
}

/**
 * QuestionBox (N01, N02, N17): the 880 box with the field and Primary-L "Get answer". Focus draws the
 * accent border and its 4 px soft ring; loading greys the text and spins the button; paused disables
 * the button. On phones the box stacks the field over a full-width button. A follow-up shows its parent
 * as a pill above the field. The form is a plain GET to /ask, so it works before the page hydrates.
 */
export function QuestionBox({
  id,
  value,
  onChange,
  onSubmit,
  onKeyDown,
  onFocus,
  onBlur,
  state = "idle",
  loadingLabel = "Reading…",
  placeholder = QUESTION_PLACEHOLDER,
  followUp = null,
  combobox,
  describedBy,
  autoFocus = false,
  showFocus = false,
  fieldRef,
  className,
}: QuestionBoxProps) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  useFitHeight(areaRef, value);
  useImperativeHandle(fieldRef, () => areaRef.current as HTMLTextAreaElement, []);
  const loading = state === "loading";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = value.trim();
    if (question === "" || state !== "idle") return;
    onSubmit(question);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const action = questionKeyAction({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing });
    if (action === null) return;
    // A textarea never submits on Enter by itself.
    event.preventDefault();
    if (action === "submit") event.currentTarget.form?.requestSubmit();
  }

  return (
    <form
      action="/ask"
      method="get"
      onSubmit={submit}
      data-state={state}
      className={cx(
        "flex w-full rounded-box border-[1.5px] bg-surface shadow-xs transition-[border-color,box-shadow]",
        // 1.5 px inner stroke: 6.5 px around Primary-L makes the 68 px box (148 on phones with 14.5).
        "gap-4 py-[6.5px] pr-[6.5px] pl-6 md:items-end",
        "max-md:min-h-[148px] max-md:flex-col max-md:p-[14.5px]",
        followUp === null ? "md:min-h-[68px] md:items-center" : "md:min-h-[104px]",
        loading
          ? "border-line-strong"
          : showFocus
            ? "border-accent ring-4 ring-accent-soft"
            : "border-line-strong focus-within:border-accent focus-within:ring-4 focus-within:ring-accent-soft",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2 md:self-stretch md:justify-center">
        {followUp !== null ? (
          <span className="inline-flex h-7 max-w-full items-center gap-1.5 self-start rounded-chip bg-sunken pr-1 pl-3 type-label text-ink-2">
            <span className="truncate">Follow-up to: {followUp.label}</span>
            {followUp.onDrop ? (
              <button
                type="button"
                onClick={followUp.onDrop}
                aria-label="Ask on its own"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-chip text-ink-2 hover:bg-line hover:text-ink"
              >
                <Icon name="x" size={14} />
              </button>
            ) : null}
          </span>
        ) : null}
        <label htmlFor={id} className="sr-only">
          Your question
        </label>
        <textarea
          ref={areaRef}
          id={id}
          name="q"
          rows={1}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          autoFocus={autoFocus}
          value={value}
          maxLength={QUESTION_MAX_CHARS}
          readOnly={loading}
          placeholder={placeholder}
          // A textarea keeps its textbox role (ARIA allows combobox only on an input): while the list is
          // open the field names it and its active row.
          aria-autocomplete={combobox ? "list" : undefined}
          aria-controls={combobox?.expanded ? combobox.listId : undefined}
          aria-activedescendant={combobox?.expanded ? (combobox.activeId ?? undefined) : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(questionText(e.target.value))}
          onKeyDown={keyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          className={cx(
            "block max-h-[120px] min-w-0 resize-none overflow-y-auto bg-transparent py-3 text-[17px] leading-6 caret-accent outline-none field-sizing-content placeholder:text-ink-3 focus-visible:outline-none",
            "max-md:min-h-12 max-md:py-0 max-md:text-[16px]",
            loading ? "text-ink-2" : "text-ink",
          )}
        />
      </div>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={loading}
        loadingLabel={loadingLabel}
        disabled={state === "paused"}
        className="md:min-w-[148px] max-md:w-full"
      >
        Get answer
      </Button>
    </form>
  );
}
