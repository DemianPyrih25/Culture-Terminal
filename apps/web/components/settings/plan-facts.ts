import type { Lane, Mode } from "@ct/contracts";

export interface ServiceView {
  tone: "good" | "caution" | "danger" | "muted";
  label: string;
  detail: string | null;
}

const UNTIL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** "1 Nov, 00:00 UTC"; null for a missing or unreadable time. */
export function untilWords(until: string | null): string | null {
  if (!until) return null;
  const at = new Date(until);
  return Number.isNaN(at.getTime()) ? null : `${UNTIL.format(at)} UTC`;
}

/** How live answers run right now for this visitor's lane, from GET /api/access. */
export function serviceView(mode: Mode | null | undefined, message: string | null, until: string | null): ServiceView {
  const back = untilWords(until);
  switch (mode) {
    case "live":
      return { tone: "good", label: "Live", detail: "New questions get a fresh answer." };
    case "economy":
      return {
        tone: "caution",
        label: "Reduced",
        detail: `Answers use a smaller model and web search is off${back ? ` until ${back}` : ""}.`,
      };
    case "replay_only":
      return {
        tone: "danger",
        label: "Paused",
        detail: message ?? `New answers are paused${back ? ` until ${back}` : ""}. Answers you already have still open.`,
      };
    case null:
      return { tone: "muted", label: "Unknown", detail: "The server could not report its state just now." };
    default:
      return { tone: "muted", label: "Checking", detail: null };
  }
}

export function laneName(lane: Lane | undefined): string {
  if (lane === "judge") return "Review access";
  return "Open access";
}
