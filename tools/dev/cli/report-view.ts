// The end of an agent run as text: the note's verdict, thesis and arguments with every {{M#}} token
// rendered as its metric's display value and badge, the limitations and the receipt. A run without
// a report shows its status, its reason and, for needs_input, the picker with a --pins answer per
// candidate.
import { indexSnapshot, renderProse, type AgentRunResult } from "@ct/agent";
import type { EventInputOf, Report } from "@ct/contracts";
import { normaliseName } from "@ct/quant";
import { formatCount, formatFixed2, formatMs, formatTokens, formatUsd, idList, shortFilterType } from "./format";
import { wrapText } from "./table";

const WIDTH = 100;

/** `label` then the text wrapped beside it, continuation lines aligned under the text. */
function field(label: string, text: string, indent = "  "): string[] {
  const pad = `${indent}${label.padEnd(11)}`;
  return wrapText(text, WIDTH - pad.length).map((line, i) => (i === 0 ? pad : " ".repeat(pad.length)) + line);
}

function renderNote(report: Report, result: AgentRunResult): string[] {
  const ledger = indexSnapshot(result.ledger);
  const prose = (text: string): string => renderProse(text, ledger, report.dataFreshness.trendWindow);
  const { verdict, receipt } = report;
  const lines = [
    `REPORT ${report.incomplete ? "(INCOMPLETE: evidence digest, the ANALYST did not submit)" : ""}`.trimEnd(),
    ...field("headline", prose(verdict.headline)),
    ...field(
      "signal",
      `${verdict.signal} · confidence ${verdict.confidence.band} (${verdict.confidence.score}/100) · ` +
        `${verdict.coverage.evidenceOk} of ${verdict.coverage.evidenceTotal} evidence bundles ok`,
    ),
    ...verdict.confidence.breakdown.map((b) => `             ${b.points} ${b.label}${b.count > 1 ? ` ×${b.count}` : ""}`),
    ...field("thesis", prose(verdict.thesis)),
    "",
    `ARGUMENTS (${report.arguments.length})`,
  ];
  for (const a of report.arguments) {
    lines.push(`  ${a.id} ${a.section} · ${a.strength} · ${idList([...a.metricIds, ...a.evidenceIds])}`);
    lines.push(...field("QLOO DATA", prose(a.qlooFact), "     "));
    lines.push(...field("OUR READ", prose(a.ourRead), "     "));
  }
  lines.push("", `LIMITATIONS (${report.limitations.length})`);
  for (const l of report.limitations) {
    lines.push(...wrapText(`${l.flag === null ? "" : `${l.flag}: `}${l.text}`, WIDTH - 4).map((line, i) => `${i === 0 ? "  - " : "    "}${line}`));
  }
  if (report.warnings.length > 0) {
    lines.push("", `CHECKER WARNINGS (${report.warnings.length})`);
    for (const w of report.warnings) lines.push(`  ${w.rule} ${w.action}: ${w.message}`);
  }
  const endpoints = receipt.endpoints.map((e) => `${e.path}${e.filterType === null ? "" : ` ${shortFilterType(e.filterType)}`} ×${e.calls}`);
  lines.push(
    "",
    "RECEIPT",
    ...field("Qloo", `${formatCount(receipt.qlooNetwork)} network · ${formatCount(receipt.qlooCached)} cached · ${formatCount(receipt.qlooReused)} reused`),
    ...(endpoints.length > 0 ? field("endpoints", endpoints.join(", ")) : []),
    ...field("LLM", `${formatUsd(receipt.usd)} · ${formatTokens(receipt.tokens)}`),
    ...field(
      "models",
      `clerk ${receipt.models.clerk ?? "—"} · analyst ${receipt.models.analyst ?? "—"} · ghost ${receipt.models.ghost ?? "—"}` +
        (receipt.economy ? " · ECONOMY" : ""),
    ),
    ...field("numbers", `${receipt.numbersTraced.traced}/${receipt.numbersTraced.total} traced`),
    ...field("time", formatMs(receipt.ms)),
  );
  return lines;
}

/**
 * `pins`: picker key → Qloo entity id, read back through the mention's cached /search. A candidate
 * with an id gets the --pins answer that chooses it; without ids the hint points at run-skill.
 */
function renderPicker(picker: EventInputOf<"needs_input">, pins: ReadonlyMap<string, string>): string[] {
  // The pin key is the normalised mention, which pinsOption reads back unchanged and which has no
  // comma, quote or "=" to break the flag.
  const key = normaliseName(picker.mention);
  const lines = [`NEEDS A CHOICE: '${picker.mention}' (${picker.entityType}) is ${picker.reason}; nothing was substituted (D20).`];
  picker.candidates.forEach((c, i) => {
    lines.push(
      `  ${i + 1}. ${c.name}${c.disambiguation === null ? "" : ` (${c.disambiguation})`}` +
        (c.popularity === null ? "" : ` · pop ${formatFixed2(c.popularity)}`),
    );
    const id = pins.get(c.key);
    if (id !== undefined && key !== "") lines.push(`     --pins "${key}=${id}"`);
  });
  const answered = key !== "" && picker.candidates.some((c) => pins.has(c.key));
  lines.push(
    answered
      ? "  Run the same question again with one of the --pins above to choose, or ask with a more specific name."
      : `  Ask again with a more specific name, or find the candidates' entity ids with ` +
          `pnpm run-skill resolve_entities "${key || picker.mention}" --type ${picker.entityType}` +
          `${picker.entityType === "place" ? " --metro <metro>" : ""} and pass one as --pins "<name>=<entityId>".`,
  );
  return lines;
}

export function renderAgentResult(
  result: AgentRunResult,
  picker: EventInputOf<"needs_input"> | null,
  pins: ReadonlyMap<string, string> = new Map(),
): string[] {
  const lines: string[] = [""];
  if (result.report !== null) lines.push(...renderNote(result.report, result), "");
  else if (picker !== null) lines.push(...renderPicker(picker, pins), "");
  lines.push(
    `RUN ${result.status}${result.reason === null ? "" : `: ${result.reason}`}`,
    `  ${result.model ?? "no ANALYST"} · ${formatUsd(result.usd)} · ${formatTokens(result.usage)} · ` +
      `Qloo ${formatCount(result.qloo.network)} network / ${formatCount(result.qloo.cached)} cached / ${formatCount(result.qloo.reused)} reused · ` +
      `${formatMs(result.elapsedMs)}`,
  );
  if (result.validation !== null) {
    const { traced, total } = result.validation.numbersTraced;
    lines.push(`  CHECKER ${traced === total ? "✓" : "✗"} ${traced}/${total} numbers traced · ${result.validation.issues.length} issue(s)`);
  }
  const s = result.ledger;
  lines.push(`  ledger ${s.evidence.length} evidence · ${s.metrics.length} metrics · ${s.datasets.length} datasets · ${s.findings.length} findings`);
  return lines;
}
