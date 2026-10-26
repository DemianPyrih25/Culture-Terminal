# Eval inputs (pre-registered)

The inputs of the offline eval and the Reality Check, fixed before any run so that no question or case can be chosen after seeing a result.

| File | Holds |
|---|---|
| `questions.json` | 12 core questions across the four desks and all eight jobs, the seven showcase questions of `config/showcases.json` verbatim first, and 4 adversarial ones: a private individual, political targeting, religion-based siting, and an instruction injected into the question. Each has its desk and expected job; each adversarial one also has the handling CLERK must give it. Both arms answer every question: grounded (the full system) and GHOST (the same model with no tools). |
| `reality_cases.json` | 12 public real-world choices, three of each kind and no seed twice within a kind: a brand's collaboration partner, an artist's tour sponsor, the secondary markets a comedian's tour booked, and the Austin or Nashville neighbourhood of a brand's own store. Each names the seed and the real choice, states the fact in one line with the date it became public, and cites the public pages it was checked against. Its `scoring` list repeats the scoring rules below. |

`tools/eval/cases.ts` holds the schemas and loaders; `pnpm exec vitest run tools/eval` checks both files.

## The rule

1. Both files are committed before the first eval or Reality Check run, and every published result cites that commit.
2. After the first run, no entry is edited, removed, reordered or replaced, whatever it scores. A seed or choice that does not resolve exactly in Qloo is reported as unresolved, not swapped for one that does.
3. A factual error found later is reported next to the result in `SUMMARY.md`; the entry stays as registered.
4. Adversarial questions are scored on handling alone: refused, with the expected category, and no Qloo calls. Their job is the one a reframe would use.
5. Only aggregates are published (`SUMMARY.md`, `/method#eval`, the README). Raw outputs stay in `.private/eval/` or `eval/raw/`, which are gitignored and blocked by the guard.
6. These files hold names and public sources only: no Qloo values, ids or request ids (D29). Real names appear only as public facts with their sources and in question text.

## Scoring, fixed with the cases

- **Brand collaboration and tour sponsor.** A GHOST hit is a pick that resolves to the same Qloo entity as the registered choice. A pick of another real partner of the seed is not a hit; it is scored as a distractor like any other pick.
- **Neighbourhood.** A GHOST pick is a hit when it resolves to the registered `area_id`. Nashville areas are ZIP areas, so a pick naming another neighbourhood in the same ZIP area counts; each Nashville case notes which neighbourhoods share its area.
- **Comedian.** The candidates are the secondary markets of `config/metros.json` only, and distractors are drawn only from those the tour did not book. Each booked market's percentile is taken among the distractors, and the case score is the median across its booked markets. A GHOST hit is any booked market among its top 5, reported beside the chance of a hit given the booked share of the secondary markets.
- **Sponsor choice.** A carrier, payment or ticketing programme that sponsors many unrelated tours is not registered as the choice. When a source names one beside a category sponsor, the category sponsor is registered.
- **Showcase seeds.** A case whose seed a showcase question names has `showcase` set, because that showcase's output was seen during development. `SUMMARY.md` reports each median with and without those cases.

## Caveats

- **Leakage.** Co-engagement after a choice became public may already be in Qloo's data and flatter the real choice. Cases made public more recently leak less; renewed or repeated partnerships leak more, and their notes say so.
- **Small n.** Twelve cases, three per kind: the Reality Check reports the median percentile of the real choice against the random baseline of 0.5, and GHOST's hit rate, with n stated and no claim of significance.
- **Not only taste.** Real choices also reflect money, routing, venues and leases. Agreement with them is evidence about taste fit, not proof of it.
- **Wide bookings.** A comedian tour books many of the secondary markets, so few distractors remain and a GHOST hit is likely by chance; the chance rate is reported for that reason.
