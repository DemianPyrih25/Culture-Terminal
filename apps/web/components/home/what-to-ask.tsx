/** What a question can be about, one quiet line each: patterns to follow, not examples to click. */
export const WHAT_TO_ASK: readonly { topic: string; pattern: string }[] = [
  { topic: "Places", pattern: "Where in a city a concept or brand should open, or how two cities compare." },
  { topic: "Brands", pattern: "How a brand's audience is shifting, or how two brands compare head to head." },
  { topic: "Audiences", pattern: "What a group of fans also loves, or which audiences share their taste." },
  { topic: "Marketing", pattern: "Which creator, sponsor, partner or market fits a brand or an artist." },
];

/**
 * Under Home's question box: a closed "What can I ask?" that opens to the four kinds of question and one
 * line on how to write one. Native details, so it works without JavaScript.
 */
export function WhatToAsk({ className }: { className?: string }) {
  return (
    <details className={`group ${className ?? ""}`}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] leading-5 font-medium text-accent hover:text-accent-hover [&::-webkit-details-marker]:hidden">
        What can I ask?
        <span aria-hidden="true" className="transition-transform duration-200 group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="mt-4 flex flex-col gap-3 border-l border-line pl-4 motion-safe:animate-rise">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {WHAT_TO_ASK.map((row) => (
            <li key={row.topic} className="flex gap-3 text-[14px] leading-6 max-md:flex-col max-md:gap-0">
              <span className="w-[92px] shrink-0 font-semibold text-ink">{row.topic}</span>
              <span className="text-ink-2">{row.pattern}</span>
            </li>
          ))}
        </ul>
        <p className="m-0 text-[13px] leading-5 text-ink-2">Name the brand, place or artist, and the city if it matters.</p>
      </div>
    </details>
  );
}
