// The marketing landing (/welcome, and "/" for signed-out visitors): calls to action lead to account creation
// and sign-in, OpenStreetMap is named as a source, all 13 jobs are listed, and no usage numbers or prices appear.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DESKS } from "../../components/landing/content";
import { LandingPage } from "../../components/landing/landing-page";

describe("LandingPage", () => {
  const html = renderToStaticMarkup(<LandingPage />);

  it("names every source, OpenStreetMap included", () => {
    for (const s of ["Qloo taste data", "US Census ACS", "SEC EDGAR", "OpenStreetMap"]) expect(html).toContain(s);
  });

  it("lists the 13 jobs on 4 desks", () => {
    expect(DESKS).toHaveLength(4);
    expect(DESKS.flatMap((d) => d.jobs)).toHaveLength(13);
  });

  it("sends calls to action to sign-up, sign-in and the method", () => {
    expect(html).toContain('href="/signup"');
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/method"');
    expect(html).toMatch(/Create account/);
    expect(html).toMatch(/Sign in/);
  });

  it("states no usage numbers or prices", () => {
    expect(html).not.toMatch(/\b30 a day|10 an hour|\$\d/);
  });
});
