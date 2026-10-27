// /dev/ask is a development page: production answers 404; development renders every state of the
// question box, the suggestion list and Your answers from fixtures, and a way to start the test run,
// without calling the server.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));

const { default: AskStatesPage } = await import("../../app/dev/ask/page");
const { ASK_GALLERY } = await import("../../components/ask/fixtures");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("/dev/ask", () => {
  it("calls notFound in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => AskStatesPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("renders every state, the suggestion list, Your answers and the test-run button, and fetches nothing", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FAKE_RUN_SECONDS", "45");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const html = renderToStaticMarkup(<AskStatesPage />);
    for (const entry of ASK_GALLERY) expect(html, entry.name).toContain(escaped(entry.name));
    expect(html).toContain("Start a 45-second test run");
    // One box per state, each with its own field id.
    expect(html.match(/<form[^>]*data-state=/g)).toHaveLength(ASK_GALLERY.length);
    expect(html).toContain(">Reading…<");
    expect(html).toContain(">Starting…<");
    expect(new Set(html.match(/id="ask-gallery-\d+"/g)).size).toBe(ASK_GALLERY.length);
    expect(html).toContain("We don&#x27;t answer political targeting questions. Try this instead:");
    expect(html).toContain("New questions reopen at 8:00 pm your time.");
    expect(html).toContain("Juniper Cola · audience profile");
    expect(html).toContain("No answers yet.");
    expect(html).not.toMatch(/example|showcase/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
