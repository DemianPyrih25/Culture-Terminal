// The request inspector behind every number, and "Copy as curl": the endpoint and filter type, the
// redacted parameters, rows, latency, cache status and age, the full request id, the evidence bundle,
// the formula of a derived number, and a curl that never holds a key.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildBriefModel, type BriefSource, type Footnote } from "../../lib/brief";
import {
  API_KEY_PLACEHOLDER,
  BriefProvider,
  briefContextValue,
  curlCommand,
  hasShortenedParams,
  NoteInspector,
  publicParams,
  requestCurl,
  requestUrl,
  SourceInspector,
} from "../../components/brief";
import { ParamName } from "../../components/brief/request-inspector";
import { after, decode, events, slice, stateOf, tagOf, text } from "./support";

// Which pages exist, switched per test: /method ships in Part 7.
const routes = vi.hoisted(() => ({ ROUTE_LIVE: { method: false, following: false } }));
vi.mock("server-only", () => ({}));
vi.mock("../../lib/routes", () => routes);

const SAMPLE = events("brand-health");
const state = stateOf(SAMPLE);
const model = buildBriefModel(state, after(SAMPLE));
const context = briefContextValue(model, state);

function inspect(note: Footnote): string {
  return renderToStaticMarkup(
    <BriefProvider value={context}>
      <NoteInspector note={note} />
    </BriefProvider>,
  );
}

function inspectSource(source: BriefSource): string {
  return renderToStaticMarkup(
    <BriefProvider value={context}>
      <SourceInspector source={source} />
    </BriefProvider>,
  );
}

const derived = model.footnotes.find((f) => f.computed !== null && f.requests.length > 0);
const measured = model.footnotes.find((f) => f.kind === "metric" && f.computed === null && f.requests.length > 0);
const figure = model.footnotes.find((f) => f.kind === "figure" && f.requests.length > 1);

describe("the request inspector", () => {
  it("shows the number, its note, and the request behind it in full", () => {
    if (!measured) throw new Error("no measured footnote in the sample");
    const html = inspect(measured);
    const request = measured.requests[0];
    if (!request) throw new Error("no request");
    const plain = text(html);
    expect(plain).toContain(`Note ${measured.n}`);
    expect(plain).toContain(measured.metric?.text ?? "missing");
    expect(plain).toContain(`GET ${request.endpoint}`);
    expect(plain).toContain(request.filterType ?? "missing");
    for (const [name, value] of request.params) {
      expect(plain).toContain(name);
      expect(plain).toContain(value);
    }
    expect(plain).toContain(String(request.rows));
    expect(plain).toContain(request.cacheLabel);
    // The full request id, with a copy button, not just its short form.
    expect(decode(slice(html, "data-request-id", "</code>"))).toContain(request.requestId ?? "missing");
    expect(plain).toContain("Copy id");
    expect(plain).toContain("Copy as curl");
    // The evidence bundle it belongs to, with its purpose.
    for (const id of measured.evidenceIds) {
      expect(html).toContain(`data-evidence-id="${id}"`);
      expect(plain).toContain(state.evidence[id]?.purpose.replace(/[.\s]+$/, "") ?? "missing");
    }
    // The request links to its row in Sources.
    expect(html).toContain(`href="#source-${(request.sourceIndex ?? 0) + 1}"`);
  });

  it("names the formula of a derived number, and links to it only once /method is built", () => {
    if (!derived?.computed) throw new Error("no derived footnote in the sample");
    const { formulaId } = derived.computed;
    routes.ROUTE_LIVE.method = false;
    const html = inspect(derived);
    expect(text(html)).toContain("Computed in code by QUANT");
    expect(html).toContain(`data-formula="${formulaId}"`);
    expect(text(slice(html, "data-formula=", "</p>"))).toContain(formulaId);
    // No link into a page that does not exist yet: it would leave the brief for a 404.
    expect(html).not.toContain('href="/method');
    routes.ROUTE_LIVE.method = true;
    expect(inspect(derived)).toContain(`href="/method#${encodeURIComponent(formulaId)}"`);
    routes.ROUTE_LIVE.method = false;
  });

  it("breaks a parameter name only after its dots, never inside a word", () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <tr>
            <th>
              <ParamName name="filter.results.entities" />
            </th>
            <th>
              <ParamName name="take" />
            </th>
          </tr>
        </tbody>
      </table>,
    );
    expect(html).toContain("<th>filter.<wbr/>results.<wbr/>entities</th><th>take</th>");
    if (!measured) throw new Error("no measured footnote in the sample");
    for (const tag of inspect(measured).match(/<th scope="row"[^>]*>/g) ?? []) expect(tag).not.toContain("overflow-wrap:anywhere");
  });

  it("steps through every request of a note that rests on several", () => {
    if (!figure) throw new Error("no figure footnote with several requests");
    const html = inspect(figure);
    expect(text(html)).toContain(`Request 1 of ${figure.requests.length}`);
    expect(html.match(/aria-label="Request \d+"/g)?.length).toBe(figure.requests.length);
    expect(html).toContain('aria-pressed="true"');
  });

  it("says 'not measured' with the reason for an UNAVAILABLE number, never 0", () => {
    if (!measured?.metric) throw new Error("no metric footnote");
    const note: Footnote = {
      ...measured,
      metric: { ...measured.metric, unavailable: true, text: "not measured", reason: "no_signal", reasonLabel: "no usable trend in the window" },
      unavailable: { reason: "no_signal", label: "no usable trend in the window" },
    };
    const html = inspect(note);
    expect(text(slice(html, 'data-unavailable="true"', "</p>"))).toBe("Not measured: no usable trend in the window");
    // The value line is gone: no number stands in for the missing one.
    expect(html).not.toContain(`>${measured.metric.text}</span>`);
  });

  it("opens a Sources row's request with its cache status, including reuse from another run", () => {
    const reused = model.sources.items.find((s) => s.cache === "reused");
    if (!reused) throw new Error("no reused request in the sample");
    const html = inspectSource(reused);
    expect(text(html)).toContain(`Request ${reused.n}`);
    expect(text(html)).toContain(reused.cacheLabel);
    expect(html).toContain('data-stamp="REUSED"');
    expect(decode(html)).toContain(reused.requestId ?? "missing");
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
    expect(API_KEY_PLACEHOLDER).toBe("$QLOO_API_KEY");
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
    const curl = curlCommand("/search", params);
    expect(curl).not.toContain("invented-key-value");
    expect(curl.match(/x-api-key/gi)).toHaveLength(1);
  });

  it("holds no key for any request of the sample run", () => {
    for (const source of model.sources.items) {
      const curl = curlCommand(source.endpoint, source.params);
      expect(curl.endsWith(`-H "x-api-key: ${API_KEY_PLACEHOLDER}"`)).toBe(true);
      expect(curl).not.toMatch(/api[-_]?key=/i);
    }
  });

  it("replays a call's full query from its evidence provenance, not the shortened trace parameters", () => {
    // The matrix calls' entity lists are shortened in the trace event ("a,b,… (+2)").
    const shortened = model.sources.items.filter((s) => hasShortenedParams(s.params));
    expect(shortened.length).toBeGreaterThan(0);
    for (const source of shortened) {
      const bundle = Object.values(state.evidence).find((e) => e.qlooCallIds.includes(source.qlooCallId));
      if (!bundle) throw new Error(`no bundle for ${source.qlooCallId}`);
      const full = bundle.provenance.requests[bundle.qlooCallIds.indexOf(source.qlooCallId)];
      if (!full) throw new Error("no provenance");
      const html = inspectSource(source);
      const curl = decode(/data-curl="([^"]*)"/.exec(html)?.[1] ?? "");
      expect(html).toContain('data-curl-exact="true"');
      expect(curl).toBe(curlCommand(full.path, Object.entries(full.query)));
      expect(curl).not.toContain(encodeURIComponent("…"));
      for (const id of (full.query["filter.results.entities"] ?? "").split(",")) expect(curl).toContain(id);
      expect(curl.match(/x-api-key/gi)).toHaveLength(1);
      expect(curl).toContain(API_KEY_PLACEHOLDER);
      // The table still shows the trace's redacted values, and says the curl has them in full.
      expect(text(html)).toContain("the curl carries them in full");
    }
  });

  it("falls back to the redacted parameters for a call in no evidence bundle, and flags a shortened one", () => {
    // A call in no bundle has no full query (runs recorded before the gate's name searches had one).
    const search = model.sources.items.find((s) => s.endpoint === "/search") ?? model.sources.items[0];
    if (!search) throw new Error("no call");
    expect(requestCurl(search, undefined)).toEqual({ command: curlCommand(search.endpoint, search.params), exact: true });
    const polygon = requestCurl({ endpoint: "/v2/insights", params: [["filter.location", "POLYGON (12 pts)"]] }, null);
    expect(polygon?.exact).toBe(false);
    expect(hasShortenedParams([["filter.location", "MULTIPOLYGON (40 pts)"]])).toBe(true);
    expect(hasShortenedParams([["x", "[redacted]"]])).toBe(true);
    expect(hasShortenedParams([["filter.location", "POINT(-73.9 40.7)"], ["take", "20"]])).toBe(false);
  });

  it("keeps the inspector's stamp still: it flashed where the call landed", () => {
    const source = model.sources.items[0];
    if (!source) throw new Error("no source");
    const html = renderToStaticMarkup(
      <BriefProvider value={briefContextValue(model, state, () => true, true)}>
        <SourceInspector source={source} />
      </BriefProvider>,
    );
    expect(tagOf(html, "data-stamp=")).not.toMatch(/flash/);
  });
});
