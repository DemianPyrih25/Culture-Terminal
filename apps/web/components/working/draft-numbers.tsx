import type { AnswerKeyNumber } from "../../lib/answer";
import { Tag, type KeyNumberProps } from "../ui";

/** A key number of the answer layer as a card's props (the working view shows it as a draft). */
export function draftKeyNumber(k: AnswerKeyNumber): KeyNumberProps {
  if (k.variant === "split") return { variant: "split", sides: k.sides, label: k.label };
  const tag = k.tag ? <Tag preset={k.tag} /> : undefined;
  return { variant: k.variant, value: k.value, label: k.label, context: k.context ?? undefined, tag };
}
