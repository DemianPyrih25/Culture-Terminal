// /trust moved: its page answers with a permanent redirect to /how-it-works (until next.config.ts
// redirects it with a 308 itself), and its rules live on /method.
import { describe, expect, it, vi } from "vitest";

const { permanentRedirect } = vi.hoisted(() => ({
  permanentRedirect: vi.fn((href: string) => {
    throw new Error(`NEXT_REDIRECT 308 ${href}`);
  }),
}));

vi.mock("next/navigation", () => ({ permanentRedirect }));

const { default: TrustPage } = await import("../../app/trust/page");

describe("/trust", () => {
  it("redirects permanently to /how-it-works", () => {
    expect(() => TrustPage()).toThrow("NEXT_REDIRECT 308 /how-it-works");
    expect(permanentRedirect).toHaveBeenCalledWith("/how-it-works");
  });
});
