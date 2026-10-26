// /ask sends the command "<NAME> DES" to its tearsheet before anything reads the question (§8.2): a
// page, not a run, whichever way it arrived (top bar, hero, follow-up, link). Invented names only.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`NEXT_REDIRECT ${href}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../server/container", () => ({ getDatabase: vi.fn(), getQlooClient: vi.fn(), peekQlooClient: vi.fn() }));

const { default: AskPage } = await import("../../app/ask/page");

const props = (q: string) => ({ params: Promise.resolve({}), searchParams: Promise.resolve({ q }) }) as unknown as Parameters<typeof AskPage>[0];

describe("/ask", () => {
  it("redirects '<NAME> DES' to its tearsheet, with the type its marker names", async () => {
    await expect(AskPage(props("Artist Nova <ARTIST> DES"))).rejects.toThrow(/^NEXT_REDIRECT \/d\/Artist%20Nova\?type=artist$/);
    await expect(AskPage(props("  Juniper Cola DES "))).rejects.toThrow(/^NEXT_REDIRECT \/d\/Juniper%20Cola$/);
  });

  it("keeps any other question on /ask, read back before a brief runs", async () => {
    await expect(AskPage(props("Is the Juniper Cola audience a moat or a niche?"))).resolves.toBeTruthy();
    await expect(AskPage(props("Juniper Cola DESK"))).resolves.toBeTruthy();
  });
});
