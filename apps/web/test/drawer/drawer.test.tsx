// The How we know drawer (N06): its four tabs on the finished sample run, the focus card and the lookups
// behind a number, the words for each lookup, the URL state, and "Copy as curl" (never a key). The sample
// run is invented (D29).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  API_KEY_PLACEHOLDER,
  callQueries,
  checkLine,
  curlCommand,
  freshnessText,
  hasShortenedParams,
  HowWeKnowPanel,
  HowWeKnowProvider,
  lookupOf,
  numbersCount,
  publicParams,
  readHowParams,
  refName,
  refNames,
  requestCurl,
  requestPairs,
  requestUrl,
  sourceDescription,
  sourceLine,
  SourceRow,
  useHowWeKnow,
  writeHowParams,
  ageText,
  focusView,
  namesText,
} from "../../components/drawer";
import { attrValues, before, events, modelOf, slice, text } from "../working/support";

vi.mock("server-only", () => ({}));

const SAMPLE = events("brand-health");
const { state, model } = modelOf(SAMPLE);
const queries = callQueries(state.evidence);
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const panel = (tab: "summary" | "numbers" | "sources" | "method", footnote: number | null = null) =>
  renderToStaticMarkup(<HowWeKnowPanel model={model} tab={tab} footnote={footnote} queries={queries} ghost />);

const firstMetric = model.footnotes.find((f) => f.kind === "metric" && f.requests.length > 0);

describe("the tabs", () => {
  it("counts the checked numbers and the sources in the tab names' data", () => {
    expect(numbersCount(model)).toBe(25);
    expect(model.sources.items.length).toBe(21);
  });

  it("summary: the check line, the counts, the confidence and what lowered it", () => {
    const html = panel("summary");
    expect(html).toContain('data-check="passed"');
    expect(text(html)).toContain("All 25 numbers checked against Qloo data.");
    expect(text(html)).toMatch(/25 numbers · 21 sources · \d+ saved cop(y|ies), \d+ fetched live/);
    expect(text(html)).toMatch(/(High|Medium|Low) confidence/);
    expect(text(html)).toContain("not by the AI");
  });

  it("numbers: lists every number to focus on when none is chosen", () => {
    const html = panel("numbers");
    expect(html).toContain('aria-label="Numbers in this answer"');
    expect(html.split("<li").length - 1).toBe(model.footnotes.filter((f) => f.kind === "metric" || f.kind === "figure").length);
  });

  it("numbers: focuses one number, with its lookups and the first one open", () => {
    if (!firstMetric) throw new Error("no metric footnote");
    const html = panel("numbers", firstMetric.n);
    const card = slice(html, "data-focus-card", "Lookups behind");
    expect(text(card)).toMatch(/^This number /);
    expect(text(card)).toContain("Source");
    expect(text(card)).toMatch(/Built from \d+ Qloo lookups?/);
    expect(card).toContain(`href="/method#${encodeURIComponent(firstMetric.metric?.formulaId ?? "")}"`);
    expect(text(html)).toContain("Lookups behind this number");
    const rows = attrValues(html, "data-source-row");
    expect(rows.length).toBe(firstMetric.requests.length);
    expect(attrValues(html, "aria-expanded")[0]).toBe("true");
    expect(text(html)).toContain("All numbers");
  });

  it("numbers: takes the answer's own words for a number when the page has them", () => {
    if (!firstMetric) throw new Error("no metric footnote");
    const html = renderToStaticMarkup(
      <HowWeKnowPanel model={model} tab="numbers" footnote={firstMetric.n} describe={() => ({ value: "0.84 match", description: "Closest audience: Granite Outfitters", means: "1.00 = identical tastes." })} />,
    );
    expect(text(slice(html, "data-focus-card", "</section>"))).toMatch(/^This number 0\.84 match Closest audience: Granite Outfitters Source .* Means 1\.00 = identical tastes\./);
  });

  it("sources: every lookup, closed", () => {
    const html = panel("sources");
    expect(attrValues(html, "data-source-row")).toHaveLength(21);
    expect(attrValues(html, "aria-expanded").every((v) => v === "false")).toBe(true);
  });

  it("method: how the question was read, what was looked up, the plan's change and the check", () => {
    const out = text(panel("method"));
    expect(out).toContain("How we read the question");
    expect(out).toContain("What we looked up");
    expect(out).toContain("Where the plan changed");
    expect(out).toContain("Every number was traced to its Qloo lookup");
    expect(out).not.toMatch(/ANALYST|CHECKER|QUANT/);
  });

  it("says when a check was not passed", () => {
    expect(checkLine(model)).toEqual({ ok: true, text: "All 25 numbers checked against Qloo data" });
    const draft = modelOf(before(SAMPLE, "validation")).model;
    expect(checkLine(draft).ok).toBe(false);
  });
});

describe("the provider", () => {
  function Probe() {
    const how = useHowWeKnow();
    return <span data-available={String(how.available)} data-open={String(how.isOpen)} />;
  }

  it("is open to a finished answer only, never a draft", () => {
    expect(renderToStaticMarkup(<HowWeKnowProvider model={model}><Probe /></HowWeKnowProvider>)).toContain('data-available="true"');
    const live = modelOf(before(SAMPLE, "report.final")).model;
    expect(renderToStaticMarkup(<HowWeKnowProvider model={live}><Probe /></HowWeKnowProvider>)).toContain('data-available="false"');
    expect(renderToStaticMarkup(<Probe />)).toContain('data-available="false"');
  });

  it("keeps its state in the URL: ?how=numbers&n=3", () => {
    expect(readHowParams("?how=numbers&n=3")).toEqual({ tab: "numbers", footnote: 3 });
    expect(readHowParams("?how=method")).toEqual({ tab: "method" });
    expect(readHowParams("?how=nope")).toBeNull();
    expect(readHowParams("?replay=1")).toBeNull();
    expect(writeHowParams("?replay=1", { tab: "numbers", footnote: 3 })).toBe("?replay=1&how=numbers&n=3");
    expect(writeHowParams("?how=numbers&n=3", { tab: "summary", footnote: 3 })).toBe("?how=summary");
    expect(writeHowParams("?how=numbers&n=3", null)).toBe("");
  });
});

describe("a lookup's words", () => {
  const search = model.sources.items.find((s) => s.endpoint === "/search");
  const insights = model.sources.items.find((s) => s.endpoint === "/v2/insights" && s.refs.length > 0);

  it("says what it fetched, by name, never by id", () => {
    if (!search || !insights) throw new Error("no lookups");
    expect(sourceDescription(search)).toBe("Brand names matched in Qloo");
    expect(sourceDescription(insights)).toMatch(/^Audience data for Juniper Cola/);
    expect(refName("R1 Juniper Cola")).toBe("Juniper Cola");
    expect(namesText(["R1 Juniper Cola", "R2 Kestrel Tonic", "R3 Granite Outfitters"])).toBe("Juniper Cola and 2 more");
    expect(namesText(["R1 Juniper Cola", "R2 Kestrel Tonic"])).toBe("Juniper Cola and Kestrel Tonic");
  });

  it("prints the endpoint line and how fresh it is", () => {
    expect(sourceLine({ endpoint: "/v2/insights", filterLabel: "brand", rows: 46 })).toBe("/v2/insights · brand · 46 rows");
    expect(freshnessText({ cache: "hit", cacheAgeMs: 9 * 3_600_000, at: "2026-10-23T12:13:00.000Z" })).toBe("Saved copy, 9 h old");
    expect(freshnessText({ cache: "reused", cacheAgeMs: null, at: "2026-10-23T12:13:00.000Z" })).toBe("Saved copy");
    expect(freshnessText({ cache: "miss", cacheAgeMs: null, at: "2026-10-23T12:13:00.000Z" })).toBe("Fetched live, 23 Oct 12:13");
    expect(ageText(30_000)).toBe("under a minute");
    expect(ageText(15 * 60_000)).toBe("15 min");
    expect(ageText(72 * 3_600_000)).toBe("3 days");
  });

  it("lists the request pairs with the short request id, never a credential", () => {
    const pairs = requestPairs({ params: [["filter.type", "urn:entity:brand"], ["api_key", "invented-0001"], ["take", "50"]], shortRequestId: "ab12…cd34", requestId: "ab12-long-cd34" });
    expect(pairs).toEqual([
      ["filter.type", "brand"],
      ["take", "50"],
      ["request id", "ab12…cd34"],
    ]);
  });

  it("names the refs in the request pairs and spaces their lists", () => {
    const names = refNames([{ refs: ["R1 Juniper Cola", "R2 Kestrel Tonic", "R3"] }]);
    expect([...names]).toEqual([
      ["R1", "Juniper Cola"],
      ["R2", "Kestrel Tonic"],
    ]);
    const pairs = requestPairs({ params: [["signal.interests.entities", "R1,R2,R3"]], shortRequestId: "", requestId: null }, names);
    expect(pairs).toEqual([["signal.interests.entities", "Juniper Cola, Kestrel Tonic, R3"]]);
  });

  it("keeps each parameter name whole in the request block", () => {
    const source = model.sources.items.find((s) => s.params.some(([k]) => k.includes(".")));
    if (!source) throw new Error("no dotted parameter");
    const html = renderToStaticMarkup(<SourceRow lookup={source} defaultOpen />);
    expect(html).not.toContain("<wbr");
    expect(html).toMatch(/<dt class="[^"]*whitespace-nowrap/);
  });

  it("opens to the request block, Copy id and Copy as curl", () => {
    const source = model.sources.items[1];
    if (!source) throw new Error("no source");
    const html = renderToStaticMarkup(<SourceRow lookup={source} query={queries.get(source.qlooCallId)} defaultOpen />);
    expect(html).toContain('aria-expanded="true"');
    expect(text(html)).toContain("request id");
    expect(text(html)).toContain("Copy id");
    expect(text(html)).toContain("Copy as curl");
    expect(text(html)).toContain("$QLOO_API_KEY");
  });

  it("stands in for a footnote's request the run did not stream", () => {
    const ref = { qlooCallId: "qc-x", sourceIndex: null, requestId: null, shortRequestId: "no response", endpoint: "/v2/tags" as const, filterType: null, filterLabel: null, params: [], rows: 3, ms: 10, cache: null, cacheLabel: "" };
    expect(lookupOf(ref, model.sources.items)).toMatchObject({ endpoint: "/v2/tags", rows: 3 });
    expect(lookupOf({ ...ref, endpoint: null }, model.sources.items)).toBeNull();
  });

  it("describes a chart's footnote as the chart", () => {
    const figure = model.footnotes.find((f) => f.kind === "figure");
    if (!figure) throw new Error("no figure footnote");
    expect(focusView(figure, null, "Its closest audience is outside its category.")).toMatchObject({ kicker: "This chart", value: null, description: "Its closest audience is outside its category." });
  });
});

describe("copy as curl", () => {
  it("builds the URL with its query and the key as the shell placeholder", () => {
    const curl = curlCommand("/v2/insights", [
      ["filter.type", "urn:entity:brand"],
      ["signal.interests.entities", "brand-alpha,brand-beta"],
      ["take", "6"],
    ]);
    expect(curl).toBe(
      `curl 'https://hackathon.api.qloo.com/v2/insights?filter.type=urn%3Aentity%3Abrand&signal.interests.entities=brand-alpha%2Cbrand-beta&take=6' -H "x-api-key: ${API_KEY_PLACEHOLDER}"`,
    );
  });

  it("keeps a quote inside a value from ending the shell string", () => {
    expect(requestUrl("/search", [["query", "Juniper's Cola"]])).toBe("https://hackathon.api.qloo.com/search?query=Juniper%27s%20Cola");
  });

  it("never carries a credential, even one smuggled into the parameters", () => {
    const params: [string, string][] = [
      ["take", "5"],
      ["api_key", "invented-key-value-0001"],
      ["X-Api-Key", "invented-key-value-0002"],
      ["access_token", "invented-key-value-0003"],
    ];
    expect(publicParams(params)).toEqual([["take", "5"]]);
    expect(curlCommand("/search", params)).not.toContain("invented-key-value");
  });

  it("replays a call's full query from its evidence provenance, not the shortened trace parameters", () => {
    const shortened = model.sources.items.filter((s) => hasShortenedParams(s.params));
    expect(shortened.length).toBeGreaterThan(0);
    for (const source of shortened) {
      const html = renderToStaticMarkup(<SourceRow lookup={source} query={queries.get(source.qlooCallId)} />);
      const full = queries.get(source.qlooCallId);
      if (!full) throw new Error(`no full query for ${source.qlooCallId}`);
      expect(html).toContain('data-curl-exact="true"');
      expect(decode(/data-curl="([^"]*)"/.exec(html)?.[1] ?? "")).toBe(curlCommand(full.path, Object.entries(full.query)));
    }
  });

  it("falls back to the redacted parameters, and flags a shortened one", () => {
    expect(requestCurl({ endpoint: "/search", params: [["query", "x"]] }, undefined)).toEqual({ command: curlCommand("/search", [["query", "x"]]), exact: true });
    expect(requestCurl({ endpoint: "/v2/insights", params: [["filter.location", "POLYGON (12 pts)"]] }, null)?.exact).toBe(false);
    expect(requestCurl({ endpoint: null, params: [] }, null)).toBeNull();
  });
});
