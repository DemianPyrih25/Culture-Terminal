import { AI_CONTEXT_CAPTION, AI_CONTEXT_HEADING, WEB_CONTEXT_CAPTION, WEB_CONTEXT_HEADING } from "@ct/contracts/values";
import { useId } from "react";
import type { AiContextView, AnswerContext, WebContextView } from "../../lib/answer/context";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";

/**
 * The context row (R4, R5, D45): "What AI knows (not verified)" and "From the web", side by side on
 * desktop and stacked on phones, after "Why we think this". A dashed border on the sunken surface keeps
 * them from ever looking like measured data; neither carries a footnote or opens How we know. A block that
 * is not ok says why in one line. Web text is rendered as text only (React escapes it), each claim with its
 * link (nofollow, ugc, opener-free). A run stored before Part 11 has neither block: the row draws nothing.
 */

const CARD = "flex min-w-0 flex-col gap-4 rounded-card border border-dashed border-line-strong bg-sunken p-6 max-md:p-5";

export function AiContextCard({ view, className }: { view: AiContextView; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx(CARD, className)} data-context="ai" data-context-status={view.status}>
      <div className="flex flex-col gap-1.5">
        <h2 id={id} className="flex items-center gap-2 text-[15px] leading-6 font-semibold text-ink">
          <Icon name="bot" size={16} className="shrink-0 text-ink-2" />
          {AI_CONTEXT_HEADING}
        </h2>
        <p className="type-caption text-ink-2">{AI_CONTEXT_CAPTION}</p>
      </div>
      {view.groups.length > 0 ? (
        <div className="flex flex-col gap-4">
          {view.groups.map((g) => (
            <div key={g.kind} className="flex flex-col gap-2" data-context-kind={g.kind}>
              <h3 className="text-[13px] leading-[18px] font-semibold text-ink-2">{g.label}</h3>
              <ul className="flex flex-col gap-2">
                {g.items.map((item, i) => (
                  <li key={`${g.kind}-${i}`} className="flex flex-col gap-0.5 type-body text-ink [overflow-wrap:anywhere]">
                    <span className="font-semibold">{item.topic}</span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="type-body text-ink-2" data-context-note="true">
          {view.note}
        </p>
      )}
      <p className="mt-auto type-caption text-ink-2" data-context-footer="true">
        {view.footer}
      </p>
    </section>
  );
}

export function WebContextCard({ view, className }: { view: WebContextView; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx(CARD, className)} data-context="web" data-context-status={view.status}>
      <div className="flex flex-col gap-1.5">
        <h2 id={id} className="flex items-center gap-2 text-[15px] leading-6 font-semibold text-ink">
          <Icon name="external-link" size={16} className="shrink-0 text-ink-2" />
          {WEB_CONTEXT_HEADING}
        </h2>
        <p className="type-caption text-ink-2">{WEB_CONTEXT_CAPTION}</p>
      </div>
      {view.items.length > 0 ? (
        <ul className="flex flex-col gap-4">
          {view.items.map((item, i) => (
            <li key={`${item.url}-${i}`} className="flex flex-col gap-1">
              <p className="type-body text-ink [overflow-wrap:anywhere]">{item.claim}</p>
              <a
                href={item.url}
                target="_blank"
                rel="nofollow noopener noreferrer ugc"
                className="self-start text-[14px] leading-5 font-medium text-accent [overflow-wrap:anywhere] hover:underline hover:underline-offset-4"
                data-web-link="true"
              >
                {item.linkText}
              </a>
              <p className="type-caption text-ink-2">
                {item.published} · {item.retrieved}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2" data-context-note="true">
          {view.note}
        </p>
      )}
      <p className="mt-auto type-caption text-ink-2" data-context-footer="true">
        {view.footer}
      </p>
    </section>
  );
}

/** Both cards on one row (3 + 3 on the six-column grid from 900 px); one alone takes the row. */
export function ContextRow({ context, className }: { context: AnswerContext; className?: string }) {
  const { ai, web } = context;
  if (!ai && !web) return null;
  const both = ai !== null && web !== null;
  const span = both ? "min-[900px]:col-span-3" : "min-[900px]:col-span-6";
  return (
    <div className={cx("grid grid-cols-1 gap-6 max-md:gap-4 min-[900px]:grid-cols-6", className)} data-context-row={both ? "ai+web" : ai ? "ai" : "web"}>
      {ai ? <AiContextCard view={ai} className={span} /> : null}
      {web ? <WebContextCard view={web} className={span} /> : null}
    </div>
  );
}
