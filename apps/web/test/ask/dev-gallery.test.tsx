// /dev/ask is a development page: production answers 404; development renders every Ask state from
// fixtures and a way to start the test run, without calling the server.
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

describe("/dev/ask", () => {
  it("calls notFound in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => AskStatesPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("renders every state and the test-run button, and fetches nothing", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FAKE_RUN_SECONDS", "45");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const html = renderToStaticMarkup(<AskStatesPage />);
    for (const entry of ASK_GALLERY) expect(html, entry.name).toContain(entry.name.replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
    expect(html).toContain("Start a 45-second test run");
    expect(html.match(/Taste intelligence for investors/g)).toHaveLength(ASK_GALLERY.length);
    // The gallery binds no global key: several fields share the page.
    expect(html).not.toContain('aria-keyshortcuts="/"');
    expect(fetch).not.toHaveBeenCalled();
  });
});
