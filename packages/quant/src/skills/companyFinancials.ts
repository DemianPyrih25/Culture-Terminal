import {
  ANALYST_TOOLS,
  makeId,
  publicDataErrorCode,
  type DatasetId,
  type DigestRow,
  type EvidenceId,
  type Finding,
  type Flag,
  type Metric,
  type MetricUnit,
  type NoValueReason,
  type PublicCallMeta,
  type PublicDataErrorCode,
  type RankedRow,
  type SecFactPoint,
  type SkillCtx,
  type SkillFor,
  type SkillResult,
  type SkillStatus,
  type ToolInput,
  type ValueCell,
} from "@ct/contracts";
import { z } from "zod";
import raw from "../../../../config/listed_companies.json";
import { tasteFinancialsSplitFinding } from "../findings";
import type { FormulaId } from "../formulas";
import { SKILL_LIMITATIONS } from "../limitations";
import { addSkillEvidence, addSkillMetric } from "./common";
import { skillResult, type DigestTarget } from "./digest";
import { safeName, safeText } from "./format";
import { windowText } from "./momentum";
import { financialsOf, percent, periodName, periodText, usd, type Financials, type ReportedPeriod } from "./companyFinancials/facts";

/**
 * S13 company_financials (PLAN §5.2, D40, SPEC S13): reported figures of the US-listed company behind
 * a brand, from SEC EDGAR company facts. The brand maps to a ticker only through
 * config/listed_companies.json, by its exact resolved name (case aside): no fuzzy match, no guess. Any
 * other brand gets an UNAVAILABLE figure with NOT_A_LISTED_COMPANY. Costs 0 Qloo calls.
 */

type FinInput = ToolInput<"company_financials">;

const Listed = z.object({ ticker: z.string().min(1), company: z.string().min(1), note: z.string().min(1).optional() });
const ListedConfig = z.object({ brands: z.record(z.string(), Listed) });

export interface ListedCompany {
  /** The brand name as the list writes it. */
  brand: string;
  ticker: string;
  company: string;
  /** Says the figures are company-wide when the brand is part of a larger company. */
  note: string | null;
}

/** Brand → company, keyed by the lower-cased, space-collapsed name. */
export type ListedCompanies = ReadonlyMap<string, ListedCompany>;

const nameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

export function listedCompaniesFrom(config: unknown): ListedCompanies {
  const parsed = ListedConfig.parse(config);
  return new Map(Object.entries(parsed.brands).map(([brand, c]) => [nameKey(brand), { brand, ticker: c.ticker, company: c.company, note: c.note ?? null }]));
}

/** config/listed_companies.json is ours, so a malformed file fails loudly at start-up. */
export const LISTED_COMPANIES: ListedCompanies = listedCompaniesFrom(raw);

/** The listed company of a brand's exact resolved name, or null. */
export function listedCompanyOf(name: string, listed: ListedCompanies = LISTED_COMPANIES): ListedCompany | null {
  return listed.get(nameKey(name)) ?? null;
}

/** Why public data failed, in a reader's words. */
const ERROR_TEXT: Readonly<Record<PublicDataErrorCode, string>> = {
  not_configured: "SEC access is not configured on this server",
  not_found: "SEC EDGAR has no record for it",
  rate_limited: "SEC EDGAR asked us to slow down; try again shortly",
  unavailable: "SEC EDGAR could not be reached",
  bad_request: "SEC EDGAR refused the request",
  invalid_response: "SEC EDGAR returned an answer that could not be read",
};

interface FinRun {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  notices: string[];
}

function finish(run: FinRun, out: DigestTarget, status: SkillStatus, rows: readonly DigestRow[], datasetIds: readonly DatasetId[] = []): SkillResult {
  return skillResult(
    { status, evidenceIds: run.evidenceIds, datasetIds, metrics: run.metrics, rows, findings: run.findings, flags: run.flags, registered: [], notices: run.notices },
    out,
  );
}

/** One UNAVAILABLE revenue figure saying why there are none, so the note can say it plainly. */
function addMissing(run: FinRun, brandRef: string, label: string, reason: NoValueReason, evidenceIds: readonly EvidenceId[]): void {
  run.metrics.push(
    addSkillMetric(run.ctx.ledger, {
      key: "fin.revenue",
      label,
      subjectRefs: [brandRef],
      value: null,
      reason,
      display: "",
      unit: "usd",
      badge: "MEASURED",
      formulaId: "fin.revenue",
      evidenceIds,
      n: null,
      comparator: null,
    }),
  );
}

/** Every metric the ledger holds so far, in id order (ids are dense: M1, M2, …). */
function ledgerMetrics(ctx: SkillCtx): Metric[] {
  const out: Metric[] = [];
  for (let i = 1; ; i++) {
    const m = ctx.ledger.metric(makeId("M", i));
    if (m === undefined) return out;
    out.push(m);
  }
}

interface PeriodMetrics {
  period: ReportedPeriod;
  revenue: Metric;
  yoy: Metric | null;
  gross: Metric | null;
  operating: Metric | null;
}

function addPeriodMetrics(run: FinRun, brandRef: string, company: string, p: ReportedPeriod, evidenceIds: readonly EvidenceId[], full: boolean): PeriodMetrics {
  const add = (
    key: string,
    what: string,
    value: number | null,
    display: string,
    unit: MetricUnit,
    formulaId: FormulaId,
    badge: "MEASURED" | "DERIVED",
    from: SecFactPoint,
  ): Metric => {
    const m = addSkillMetric(run.ctx.ledger, {
      key,
      label: `${what} of ${company}, ${periodName(p)}`,
      subjectRefs: [brandRef],
      value,
      reason: "not_reported",
      display,
      unit,
      badge,
      formulaId,
      evidenceIds,
      n: null,
      comparator: null,
      period: periodText(p, from),
    });
    run.metrics.push(m);
    return m;
  };
  const revenue = add("fin.revenue", "Revenue", p.revenue.value, usd(p.revenue.value), "usd", "fin.revenue", "MEASURED", p.revenue);
  const yoy = add(
    "fin.yoy",
    "Revenue change vs a year earlier",
    p.yoy,
    p.yoy === null ? "" : `${percent(p.yoy, true)} vs the period ended ${p.prior?.end ?? "a year earlier"}`,
    "pct",
    "fin.yoy",
    "DERIVED",
    p.revenue,
  );
  if (!full) return { period: p, revenue, yoy, gross: null, operating: null };
  const gross = add("fin.gross_margin", "Gross margin", p.grossMargin, p.grossMargin === null ? "" : `${percent(p.grossMargin)} of revenue`, "pct", "fin.margin", "DERIVED", p.grossProfit ?? p.revenue);
  const operating = add(
    "fin.operating_margin",
    "Operating margin",
    p.operatingMargin,
    p.operatingMargin === null ? "" : `${percent(p.operatingMargin)} of revenue`,
    "pct",
    "fin.margin",
    "DERIVED",
    p.operatingIncome ?? p.revenue,
  );
  return { period: p, revenue, yoy, gross, operating };
}

const cell = (v: number | null): ValueCell => (v === null ? { value: null, reason: "not_reported" } : { value: v, reason: null });

function addTable(run: FinRun, company: string, fin: Financials, note: string | null, evidenceIds: readonly EvidenceId[]): DatasetId | null {
  const row = (p: ReportedPeriod, i: number): RankedRow => ({
    key: `${p.span}-${i + 1}`,
    rank: null,
    label: periodName(p),
    sublabel: `${p.revenue.form} filed ${p.revenue.filed} · accession ${p.revenue.accession}`,
    ref: null,
    tagRef: null,
    type: null,
    cells: [cell(p.revenue.value), cell(p.grossMargin), cell(p.operatingMargin), cell(p.yoy)],
    flags: [],
    explain: [],
  });
  const groups = [
    ...(fin.years.length > 0 ? [{ key: "years", label: "Fiscal years", rows: fin.years.map(row) }] : []),
    ...(fin.quarters.length > 0 ? [{ key: "quarters", label: "Latest quarters", rows: fin.quarters.map(row) }] : []),
  ];
  if (groups.length === 0) return null;
  const dataset = run.ctx.ledger.addDataset({
    kind: "Ranked",
    title: `Reported financials · ${company}`,
    evidenceIds: [...evidenceIds],
    formulaIds: ["fin.revenue", "fin.margin", "fin.yoy"],
    payload: {
      columns: [
        { key: "revenue", label: "Revenue", unit: "usd", comparator: null },
        { key: "gross_margin", label: "Gross margin", unit: "pct", comparator: null },
        { key: "operating_margin", label: "Operating margin", unit: "pct", comparator: null },
        { key: "yoy", label: "Revenue vs a year earlier", unit: "pct", comparator: null },
      ],
      groups,
      caption:
        "As reported in SEC EDGAR filings, US dollars. Margins are gross profit or operating income divided by revenue for the same period; " +
        `the last column compares revenue with the same period a year earlier. ${note ?? "Company-level figures."} Not advice.`,
    },
  });
  return dataset.id;
}

/** TASTE_FINANCIALS_SPLIT when the brand's momentum in this run and the latest fiscal year's revenue point opposite ways. */
function addSplitFinding(run: FinRun, brandRef: string, brandName: string, company: string, latest: PeriodMetrics | undefined): void {
  if (latest === undefined || latest.yoy === null || latest.yoy.value === null) return;
  const momentum = ledgerMetrics(run.ctx).find((m) => m.key === "mom.delta_26w" && m.value !== null && m.subjectRefs.includes(brandRef));
  if (momentum === undefined || momentum.value === null) return;
  const draft = tasteFinancialsSplitFinding({
    brandName,
    companyName: company,
    momentumDelta: momentum.value,
    momentumWindow: `the ${momentum.window ? `${momentum.window.start}..${momentum.window.end}` : windowText()} trending window`,
    revenueYoy: latest.yoy.value,
    revenuePeriod: `the ${periodName(latest.period)}`,
  });
  if (draft === null) return;
  const f = run.ctx.ledger.addFinding({ ...draft, metricIds: [momentum.id, latest.yoy.id] });
  run.findings.push(f);
}

export function makeCompanyFinancialsSkill(listed: ListedCompanies = LISTED_COMPANIES): SkillFor<"company_financials"> {
  async function run(input: FinInput, ctx: SkillCtx): Promise<SkillResult> {
    const out: DigestTarget = { tool: "company_financials", step: input.step_id };
    const fin: FinRun = { ctx, flags: new Set(), evidenceIds: [], metrics: [], findings: [], notices: [] };
    const entity = ctx.registry.entity(input.brand);
    if (entity === null) {
      fin.notices.push(`${input.brand} is not in the registry; resolve the brand first.`);
      return finish(fin, out, "error", []);
    }
    const brandName = safeName(entity.name);
    const company = listedCompanyOf(entity.name, listed);
    if (company === null) {
      fin.flags.add("NOT_A_LISTED_COMPANY");
      addMissing(fin, entity.ref, `Reported revenue of ${brandName}: not a mapped US-listed company`, "not_listed", []);
      fin.notices.push(`${brandName} is not mapped to a US-listed company (private, foreign or not in our list); no financial figures are shown and none are guessed.`);
      return finish(fin, out, "empty", []);
    }
    const companyName = safeText(company.company, 60);
    if (ctx.publicdata === null) {
      addMissing(fin, entity.ref, `Reported revenue of ${companyName}: public data is off in this run`, "unavailable", []);
      fin.notices.push("Public data (SEC EDGAR) is not available in this run, so no financial figures were read.");
      return finish(fin, out, "error", []);
    }

    const calls: PublicCallMeta[] = [];
    const record = (status: SkillStatus, summary: string): EvidenceId[] => {
      const flags: Flag[] = calls.some((c) => c.stale) ? ["STALE_CACHE"] : [];
      for (const f of flags) fin.flags.add(f);
      const e = calls.length === 0 ? null : addSkillEvidence(ctx.ledger, { skill: "company_financials", source: "sec", purpose: `SEC EDGAR filings of ${companyName} (${company.ticker})`, calls, status, summary, flags });
      if (e !== null) fin.evidenceIds.push(e.id);
      return e === null ? [] : [e.id];
    };
    const fail = (err: unknown, step: string): SkillResult => {
      const code = publicDataErrorCode(err);
      if (code === null) throw err;
      const ids = record("error", `${step}: ${ERROR_TEXT[code]}.`);
      addMissing(fin, entity.ref, `Reported revenue of ${companyName}: ${ERROR_TEXT[code]}`, code === "not_found" ? "not_listed" : "unavailable", ids);
      fin.notices.push(`No financial figures for ${companyName}: ${ERROR_TEXT[code]} (${step}). None are guessed.`);
      return finish(fin, out, "error", []);
    };

    let cik: string;
    try {
      const ticker = await ctx.publicdata.secTicker(company.ticker);
      calls.push(ticker.meta);
      if (ticker.data === null) {
        const ids = record("empty", `Ticker ${company.ticker} is not in the SEC ticker map.`);
        addMissing(fin, entity.ref, `Reported revenue of ${companyName}: ticker ${company.ticker} not in the SEC map`, "not_listed", ids);
        fin.flags.add("NOT_A_LISTED_COMPANY");
        fin.notices.push(`${company.ticker} is no longer in the SEC ticker map (renamed, acquired or delisted); no figures are shown.`);
        return finish(fin, out, "empty", []);
      }
      cik = ticker.data.cik;
    } catch (err) {
      return fail(err, "ticker lookup");
    }
    let points: SecFactPoint[];
    try {
      const facts = await ctx.publicdata.secCompanyFacts(cik);
      calls.push(facts.meta);
      points = facts.data.points;
    } catch (err) {
      return fail(err, "company facts");
    }

    const result = financialsOf(points);
    const accessions = [...new Set([...result.years, ...result.quarters].map((p) => p.revenue.accession))];
    const evidenceIds = record(
      result.years.length === 0 ? "empty" : "ok",
      `${result.years.length} fiscal years and ${result.quarters.length} later quarters with reported revenue (CIK ${cik}); accessions ${accessions.join(", ") || "none"}.`,
    );
    if (result.years.length === 0) {
      addMissing(fin, entity.ref, `Reported revenue of ${companyName}: no annual US-GAAP revenue in its filings`, "not_reported", evidenceIds);
      fin.notices.push(`${companyName}'s SEC company facts hold no annual US-GAAP revenue in US dollars, so no figures are shown.`);
      return finish(fin, out, "empty", []);
    }

    const yearMetrics = result.years.map((p) => addPeriodMetrics(fin, entity.ref, companyName, p, evidenceIds, true));
    const quarterMetrics = result.quarters.map((p) => addPeriodMetrics(fin, entity.ref, companyName, p, evidenceIds, false));
    const datasetId = addTable(fin, companyName, result, company.note, evidenceIds);
    addSplitFinding(fin, entity.ref, brandName, companyName, yearMetrics[0]);

    if (company.note !== null) fin.notices.push(company.note);
    fin.notices.push(
      `Cite each figure with its {{PERIOD:M#}} token. These are ${companyName}'s reported results; never link them causally to a taste metric. Not advice.`,
    );
    const rows: DigestRow[] = [...yearMetrics, ...quarterMetrics].map((m) => ({
      ref: null,
      name: periodName(m.period),
      values: {
        revenue: m.revenue.id,
        yoy: m.yoy?.id ?? null,
        gross_margin: m.gross?.id ?? null,
        operating_margin: m.operating?.id ?? null,
      },
    }));
    return finish(fin, out, result.years.length < 2 ? "partial" : "ok", rows, datasetId === null ? [] : [datasetId]);
  }

  return {
    id: "company_financials",
    mnemonic: "FIN",
    kitWorkflows: ANALYST_TOOLS.company_financials.kitWorkflows,
    input: ANALYST_TOOLS.company_financials.input,
    // SEC calls cost no Qloo calls; their pace is the public-data client's.
    estimateCalls: async () => 0,
    run,
    limitations: () => [...SKILL_LIMITATIONS.company_financials],
  };
}

export const companyFinancialsSkill = makeCompanyFinancialsSkill();
