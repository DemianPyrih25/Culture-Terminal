"use client";

import { QUESTION_MAX_CHARS } from "@ct/contracts";
import {
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import { Keycap } from "../ui/keycap";
import { cx } from "../ui/cx";
import { useFocusShortcut } from "../ui/use-shortcut";

/** The placeholder of A/Question field (A01). */
export const QUESTION_PLACEHOLDER = "Ask about a brand, an artist, a place or an audience";
/** The same on a phone, where the long one is cut off. */
export const QUESTION_PLACEHOLDER_SHORT = "Ask about a brand, place or audience";

/** Below Tailwind's sm: the field is too narrow for the long placeholder. */
const NARROW_QUERY = "(max-width: 639.98px)";

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True on a phone-width screen; false on the server and through hydration, so the markup matches. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

/** The parts of a key press the field's Enter rule reads. */
export interface QuestionKey {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
}

/**
 * What a key press does in the field: Enter asks ("submit"), Shift+Enter does nothing ("ignore": a
 * question is one paragraph), anything else, and Enter that ends an IME composition, is the field's own (null).
 */
export function questionKeyAction(event: QuestionKey): "submit" | "ignore" | null {
  if (event.key !== "Enter" || event.isComposing) return null;
  return event.shiftKey ? "ignore" : "submit";
}

/** The field's text as one paragraph: a pasted line break becomes a space. */
export function questionText(raw: string): string {
  return raw.replace(/\r\n?|\n/g, " ");
}

/**
 * Grows the field with its text where CSS cannot (field-sizing: content is missing in Firefox): the
 * height follows the text on each change and on resize, up to the max height the class sets.
 */
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

/** Imperative handle: Edit puts the caret back in the field. */
export interface QuestionFieldHandle {
  focus(): void;
  /** Focuses the field with the caret after the last character. */
  focusEnd(): void;
}

export interface QuestionFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter, with the trimmed value; an empty field submits nothing. */
  onSubmit: (question: string) => void;
  /** Esc: the field clears itself through onChange first. */
  onClear?: () => void;
  /** Other keys (arrows, ⌘↵) the page handles; called before Enter and Esc are. */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Default QUESTION_PLACEHOLDER, or its short form on a phone. */
  placeholder?: string;
  autoFocus?: boolean;
  /** Binds the bare / key to focus the field (default true); the top bar keeps ⌘K. */
  slashShortcut?: boolean;
  /** Draws the focused border without focus, for stills and the gallery. */
  showFocus?: boolean;
  /** A composing panel hangs under the field: square bottom corners. */
  attached?: boolean;
  /** Ids of elements that describe the field (the "Compiled to" line). */
  describedBy?: string;
  disabled?: boolean;
  className?: string;
  ref?: Ref<QuestionFieldHandle>;
}

/**
 * A/Question field: the large serif field of Home and Ask, 64 px for one line, with "↵ to ask" while
 * empty and "esc to clear" once there is a question. A long question wraps, up to three lines (five on
 * a phone) before it scrolls, so a starter or a ?q= is read whole before it runs. Enter asks and
 * Shift+Enter does nothing: a question is one paragraph. Controlled; the page decides what Enter does.
 * The form is a plain GET to /ask with the question as q.
 */
export function QuestionField({
  value,
  onChange,
  onSubmit,
  onClear,
  onKeyDown,
  placeholder,
  autoFocus = false,
  slashShortcut = true,
  showFocus = false,
  attached = false,
  describedBy,
  disabled = false,
  className,
  ref,
}: QuestionFieldProps) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const areaId = `question-${useId()}`;
  const narrow = useNarrow();
  useFitHeight(areaRef, value);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => areaRef.current?.focus(),
      focusEnd: () => {
        const area = areaRef.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      },
    }),
    [],
  );

  useFocusShortcut(slashShortcut ? ["slash"] : [], () => areaRef.current?.focus(), !disabled);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = value.trim();
    if (question === "" || disabled) return;
    onSubmit(question);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const action = questionKeyAction({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing });
    if (action !== null) {
      // A textarea never submits on Enter by itself.
      event.preventDefault();
      if (action === "submit") event.currentTarget.form?.requestSubmit();
      return;
    }
    if (event.key === "Escape" && value !== "") {
      event.preventDefault();
      onChange("");
      onClear?.();
    }
  }

  const empty = value.trim() === "";
  return (
    <form
      action="/ask"
      method="get"
      onSubmit={submit}
      className={cx(
        // 19 px inside the 1 px border: the text starts 20 px in, as A01 draws it.
        "flex w-full min-w-0 items-center gap-3 border bg-paper pr-4 pl-[19px] transition-colors",
        attached ? "rounded-t-brief" : "rounded-brief",
        showFocus ? "border-accent" : "border-line-strong focus-within:border-accent",
        disabled && "opacity-60",
        className,
      )}
    >
      <label htmlFor={areaId} className="sr-only">
        Your question
      </label>
      {/*
        One line is 28 px with 17 px above and below: 62 px inside the border, the 64 px field of A01.
        Three lines at most (118 px), then it scrolls; on a phone 24 px lines, five at most (158 px).
      */}
      <textarea
        ref={areaRef}
        id={areaId}
        name="q"
        rows={1}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        autoFocus={autoFocus}
        value={value}
        maxLength={QUESTION_MAX_CHARS}
        disabled={disabled}
        placeholder={placeholder ?? (narrow ? QUESTION_PLACEHOLDER_SHORT : QUESTION_PLACEHOLDER)}
        aria-describedby={describedBy}
        aria-keyshortcuts={slashShortcut && !disabled ? "/" : undefined}
        onChange={(e) => onChange(questionText(e.target.value))}
        onKeyDown={keyDown}
        className="block max-h-[118px] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-[17px] font-serif text-[22px] leading-7 text-ink caret-accent outline-none field-sizing-content placeholder:text-dim focus-visible:outline-none disabled:cursor-not-allowed max-sm:max-h-[158px] max-sm:py-[19px] max-sm:text-[18px] max-sm:leading-6"
      />
      <span aria-hidden="true" className="flex shrink-0 items-center gap-[6px] max-sm:hidden">
        <Keycap>{empty ? "↵" : "esc"}</Keycap>
        <span className="text-[11px] text-dim">{empty ? "to ask" : "to clear"}</span>
      </span>
    </form>
  );
}
