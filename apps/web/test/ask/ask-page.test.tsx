// /ask renders Home with the question in the box, sent at once; the command "<NAME> DES" goes to its
// profile before anything reads the question (§8.2). Invented names only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const parents = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`NEXT_REDIRECT ${href}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/ask",
}));
vi.mock("../../server/container", () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock("../../server/run-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/run-list")>()),
  getFollowUpParent: parents.get,
}));

const { default: AskPage } = await import("../../app/ask/page");

const props = (params: Record<string, string>) =>
  ({ params: Promise.resolve({}), searchParams: Promise.resolve(params) }) as unknown as Parameters<typeof AskPage>[0];

describe("/ask", () => {
  it("redirects '<NAME> DES' to its profile, with the type its marker names", async () => {
    await expect(AskPage(props({ q: "Artist Nova <ARTIST> DES" }))).rejects.toThrow(/^NEXT_REDIRECT \/d\/Artist%20Nova\?type=artist$/);
    await expect(AskPage(props({ q: "  Juniper Cola DES " }))).rejects.toThrow(/^NEXT_REDIRECT \/d\/Juniper%20Cola$/);
  });

  it("renders Home with the question in the box, reading it", async () => {
    const html = renderToStaticMarkup(await AskPage(props({ q: "Who really competes with Juniper Cola?" })));
    expect(html).toContain("Ask what any audience");
    expect(html).toMatch(/<textarea[^>]*id="ask"[^>]*readOnly=""[^>]*>Who really competes with Juniper Cola\?<\/textarea>/);
    expect(html).toContain('data-state="loading"');
    expect(html).toContain("Reading…");
    await expect(AskPage(props({ q: "Juniper Cola DESK" }))).resolves.toBeTruthy();
  });

  it("shows a follow-up's parent above the field, and drops a parent the server would refuse", async () => {
    const runId = "run-fixture-c3d4";
    parents.get.mockResolvedValueOnce({ question: "Who is the Brand Beta audience?", blocked: null });
    const follow = renderToStaticMarkup(await AskPage(props({ parent: runId })));
    expect(follow).toContain("Follow-up to: Who is the Brand Beta audience?");
    expect(follow).toContain('placeholder="Ask a follow-up about this answer"');
    parents.get.mockResolvedValueOnce({ question: "Who is the Brand Beta audience?", blocked: "running" });
    const alone = renderToStaticMarkup(await AskPage(props({ parent: runId })));
    expect(alone).not.toContain("Follow-up to:");
  });
});
