"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { HumanCheckPanel, sharedHumanFetch, useHumanCheck } from "../protection/human-check-panel";
import { Button } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { Popover } from "../ui/popover";
import { FOLLOWS_LOADING, FollowsError, sharedFollows, type FollowsState, type FollowsStore } from "./client";
import { followButtonModel, type FollowButtonModel } from "./model";
import { findFollow, type FollowOption } from "./subjects";

/**
 * Follow controls (PLAN §8.1 /following): FollowButton toggles one subject (a brand profile's brand);
 * FollowMenu offers each subject of a note (its brand, its place, its question) in a small panel. Both
 * read the tab's shared follows, follow through POST /api/follows behind the human check, and say a
 * refusal (the follow limit, the check) in the server's own words.
 */

const serverSnapshot = (): FollowsState => FOLLOWS_LOADING;

/** The shared follows, read once the first control mounts (`fresh`: read again, as the Following page does). */
export function useFollows(store: FollowsStore = sharedFollows(), fresh = false): FollowsState {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, serverSnapshot);
  useEffect(() => {
    void store.load(fresh);
  }, [store, fresh]);
  return state;
}

/** One subject's toggle: its model, the press and the refusal. */
function useToggle(option: FollowOption, state: FollowsState) {
  const store = sharedFollows();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The human check's widget mounts only for a control that asked, so two controls never show two widgets.
  const [asked, setAsked] = useState(false);
  const follow = state.kind === "ready" ? findFollow(state.follows, option.subject) : undefined;
  const model = followButtonModel(follow, option.subject, busy ? "busy" : state.kind === "loading" ? "loading" : "ready");
  const press = async () => {
    setBusy(true);
    setError(null);
    try {
      if (model.followId !== null) {
        await store.unfollow(model.followId);
      } else {
        setAsked(true);
        await store.follow(option.create, sharedHumanFetch());
      }
    } catch (err) {
      setError(err instanceof FollowsError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return { model, press, error, asked };
}

function ToggleButton({ model, onPress, size = "md", className }: { model: FollowButtonModel; onPress: () => void; size?: "sm" | "md"; className?: string }) {
  return (
    <Button
      variant="secondary"
      size={size}
      icon={model.pressed ? "check" : "plus"}
      aria-pressed={model.pressed}
      aria-label={model.label}
      title={model.label}
      disabled={model.disabled}
      loading={model.loading}
      loadingLabel={model.pressed ? "Unfollowing…" : "Following…"}
      onClick={onPress}
      className={className}
    >
      {model.text}
    </Button>
  );
}

function HumanCheckSlot({ show, className }: { show: boolean; className?: string }) {
  const human = useHumanCheck();
  return show ? <HumanCheckPanel check={human} className={className} /> : null;
}

export interface FollowButtonProps {
  /** profileFollowOption(name) on a brand profile; one of noteFollowOptions(...) elsewhere. */
  option: FollowOption;
  size?: "sm" | "md";
  className?: string;
}

/** C/FollowButton: Follow ↔ Following (pressed) for one subject; a refusal shows under it. */
export function FollowButton({ option, size = "md", className }: FollowButtonProps) {
  const state = useFollows();
  const { model, press, error, asked } = useToggle(option, state);
  return (
    <div className={cx("flex flex-col items-start gap-2", className)} data-follow={option.subject.kind}>
      <ToggleButton model={model} onPress={() => void press()} size={size} />
      {error ? (
        <p role="alert" className="m-0 max-w-[360px] type-label text-danger-ink">
          {error}
        </p>
      ) : null}
      <HumanCheckSlot show={asked} className="w-full max-w-[360px]" />
    </div>
  );
}

/** One row of the Follow panel: the kind, the subject and its toggle. */
function MenuRow({ option, state, onAsked }: { option: FollowOption; state: FollowsState; onAsked: () => void }) {
  const { model, press, error, asked } = useToggle(option, state);
  useEffect(() => {
    if (asked) onAsked();
  }, [asked, onAsked]);
  const kind = option.subject.kind === "brand" ? "Brand" : option.subject.kind === "place" ? "Place" : "Question";
  return (
    <li className="flex flex-col gap-1.5 rounded-sm px-3 py-2.5" data-follow={option.subject.kind}>
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="type-label text-ink-2">{kind}</span>
          <span className="line-clamp-2 type-body-strong text-ink">{option.subject.label}</span>
        </span>
        <ToggleButton model={model} onPress={() => void press()} size="sm" />
      </div>
      {error ? (
        <p role="alert" className="m-0 type-label text-danger-ink">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export interface FollowMenuProps {
  /** noteFollowOptions(runId, note): the note's brand, place and question, as far as it has them. */
  options: readonly FollowOption[];
}

/**
 * The answer page's Follow: a secondary button ("Following" with a check once anything of the note is
 * followed) that opens a panel with one toggle per subject, and the human check when one is due. A note
 * with nothing to follow renders nothing.
 */
export function FollowMenu({ options }: FollowMenuProps) {
  const state = useFollows();
  const [asked, setAsked] = useState(false);
  if (options.length === 0) return null;
  const any = state.kind === "ready" && options.some((o) => findFollow(state.follows, o.subject) !== undefined);
  return (
    <Popover
      label="Follow"
      width={340}
      placement="bottom-end"
      trigger={(props) => (
        <Button {...props} variant="secondary" icon={any ? "check" : "plus"} data-following={any ? "true" : "false"}>
          {any ? "Following" : "Follow"}
        </Button>
      )}
    >
      <div className="flex flex-col gap-1 p-1">
        <p className="m-0 px-3 pt-2 type-label text-ink-2">
          Keep it on <Link href="/following" className="text-accent hover:underline">
            Following
          </Link> with its latest note. No alerts.
        </p>
        <ul className="m-0 flex list-none flex-col p-0" aria-label="Follow">
          {options.map((option) => (
            <MenuRow key={option.subject.kind} option={option} state={state} onAsked={() => setAsked(true)} />
          ))}
        </ul>
        <HumanCheckSlot show={asked} className="mx-2 mb-2" />
        {state.kind === "error" ? (
          <p className="m-0 flex items-center gap-2 px-3 pb-2 type-label text-ink-2">
            <Icon name="triangle-alert" size={14} className="text-caution" />
            What you follow couldn&apos;t be read; following again is safe.
          </p>
        ) : null}
      </div>
    </Popover>
  );
}
