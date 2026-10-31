"use client";

import { DEFAULT_SCRIPT_ID, Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { loadAccess } from "./access-client";
import {
  HUMAN_LOADING,
  HumanCheck,
  humanFetch,
  SCRIPT_ERROR,
  UNSUPPORTED_ERROR,
  type HumanState,
  type HumanStatus,
} from "./human-check";

let shared: HumanCheck | null = null;

/** This tab's human check, shared by every page and control that spends (the question box, the answer's picker). */
export function sharedHumanCheck(): HumanCheck {
  return (shared ??= new HumanCheck(loadAccess));
}

let sharedFetch: typeof fetch | null = null;

/** humanFetch on the shared check, for a request that spends from any page (pass it as lib/start-run's `fetch`). */
export function sharedHumanFetch(): typeof fetch {
  return (sharedFetch ??= humanFetch(sharedHumanCheck()));
}

/** The shared check, with GET /api/access read once the component mounts. */
export function useHumanCheck(): HumanCheck {
  const check = sharedHumanCheck();
  useEffect(() => {
    void check.load();
  }, [check]);
  return check;
}

const serverSnapshot = (): HumanState => HUMAN_LOADING;

export function useHumanState(check: HumanCheck): HumanState {
  return useSyncExternalStore(check.subscribe, check.getSnapshot, serverSnapshot);
}

/**
 * Reports a Turnstile script that fails to load (a blocker, a firewall, a CSP) to the check at once.
 * Watched on the script tag the library injects, rather than through its scriptOptions.onError,
 * which also drops the onload callback Cloudflare's script calls.
 */
function useScriptFailures(check: HumanCheck): void {
  useEffect(() => {
    let watched: HTMLScriptElement | null = null;
    const failed = () => check.onScriptError();
    const watch = () => {
      const script = document.getElementById(DEFAULT_SCRIPT_ID);
      if (!(script instanceof HTMLScriptElement) || script === watched) return;
      watched?.removeEventListener("error", failed);
      watched = script;
      script.addEventListener("error", failed);
    };
    watch();
    const observer = new MutationObserver(watch);
    observer.observe(document.head, { childList: true });
    return () => {
      observer.disconnect();
      watched?.removeEventListener("error", failed);
    };
  }, [check]);
}

/** What the panel says, by status and error; null while nothing needs saying (the check runs unseen). */
export function humanCheckCopy(state: { status: HumanStatus; error?: string | null }): { head: string; detail: string } | null {
  switch (state.status) {
    case "interactive":
      return {
        head: "Confirm you're a person to get a new answer",
        detail: "Cloudflare checks this browser once every two hours. Answers you already have need no check.",
      };
    case "error":
      if (state.error === SCRIPT_ERROR) {
        return {
          head: "The check that you are a person could not load",
          detail: "Something in this browser or network blocked Cloudflare's check. New answers need it; answers you already have still open.",
        };
      }
      if (state.error === UNSUPPORTED_ERROR) {
        return {
          head: "This browser cannot run the check that you are a person",
          detail: "New answers need it, so try another browser. Answers you already have still open here.",
        };
      }
      return {
        head: "The check that you are a person could not run",
        detail: "New answers need it; answers you already have still open. Try again, or reload the page.",
      };
    default:
      return null;
  }
}

export interface HumanCheckCardProps {
  status: HumanStatus;
  /** The widget's error code, while status is error. */
  error?: string | null;
  /** Try again after an error; absent where trying again cannot help (an unsupported browser). */
  onRetry?: () => void;
  /** The Turnstile widget (a placeholder in the gallery). */
  children?: ReactNode;
  className?: string;
}

/**
 * The human check's frame under the question box, in the InlineState style (a white surface with a hairline, padding 14 16):
 * the copy, the widget, and Try again after an error. While the check runs unseen it is a zero-height box around the widget.
 * The ask for a click is announced politely, an error as an alert.
 */
export function HumanCheckCard({ status, error = null, onRetry, children, className }: HumanCheckCardProps) {
  const copy = humanCheckCopy({ status, error });
  return (
    <section
      aria-label="Human check"
      aria-hidden={copy === null}
      data-human-check={status}
      className={
        copy === null
          ? // The widget runs here unseen; Turnstile shows its iframe only when it needs the visitor.
            "h-0 overflow-hidden"
          : cx("flex flex-col gap-3 rounded-sm border border-line bg-surface px-4 py-3.5 md:flex-row md:items-start md:gap-3", className)
      }
    >
      {copy !== null ? (
        <span className="flex h-5 shrink-0 items-center text-accent">
          <Icon name="shield-check" size={18} />
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {copy !== null ? (
          <div className="flex flex-col gap-0.5" role={status === "error" ? "alert" : "status"}>
            <p className="m-0 text-[14px] leading-5 font-semibold text-ink">{copy.head}</p>
            <p className="m-0 text-[13px] leading-5 text-ink-2">{copy.detail}</p>
          </div>
        ) : null}
        {children}
      </div>
      {status === "error" && onRetry ? (
        <div className="flex shrink-0 max-md:pl-9">
          <Button size="sm" icon="rotate-ccw" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The human check: Cloudflare Turnstile under the question box. The widget renders only while a check
 * is due (never once this browser holds its two-hour cookie), as interaction-only: nothing shows
 * while Cloudflare is satisfied without the visitor, and the card opens with its copy when
 * Cloudflare asks for a click, or when the widget fails (with Try again). A script that cannot load
 * and a browser Turnstile does not support fail at once; Try again after a script failure injects
 * the script again.
 */
export function HumanCheckPanel({ check, className }: { check: HumanCheck; className?: string }) {
  const state = useHumanState(check);
  const widget = useRef<TurnstileInstance | null>(null);
  // Bumped to mount the widget afresh after its script failed to load.
  const [mount, setMount] = useState(0);
  useEffect(() => check.attach(() => widget.current?.reset()), [check]);
  useScriptFailures(check);
  const due = state.status === "checking" || state.status === "interactive" || state.status === "error";
  if (state.siteKey === null || !due) return null;
  const retry =
    state.error === UNSUPPORTED_ERROR
      ? undefined
      : () => {
          if (state.error === SCRIPT_ERROR) {
            // The failed script tag would stop a new one from being injected.
            document.getElementById(DEFAULT_SCRIPT_ID)?.remove();
            setMount((n) => n + 1);
          }
          check.retry();
        };
  return (
    <HumanCheckCard status={state.status} error={state.error} onRetry={retry} className={className}>
      <Turnstile
        key={mount}
        ref={widget}
        siteKey={state.siteKey}
        options={{ appearance: "interaction-only", theme: "light", action: "live", language: "en" }}
        onSuccess={check.onToken}
        onExpire={check.onExpire}
        onError={check.onError}
        onUnsupported={check.onUnsupported}
        onBeforeInteractive={check.onInteractive}
      />
    </HumanCheckCard>
  );
}
