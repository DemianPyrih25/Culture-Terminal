// The page chrome: header variants (desktop and phone), the footer, the page head and the shell.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Footer } from "../../components/chrome/footer";
import { Header } from "../../components/chrome/header";
import { NEW_QUESTION_HREF, SITE_NAV } from "../../components/chrome/links";
import { LogoMark } from "../../components/chrome/logo-mark";
import { PageHead } from "../../components/chrome/page-head";
import { SiteShell } from "../../components/chrome/site-shell";

const html = renderToStaticMarkup;

describe("header", () => {
  it("links the wordmark home and lists Your answers, Following, Screener and How it works", () => {
    const out = html(<Header variant="home" />);
    expect(out).toMatch(/<a[^>]*href="\/"[^>]*>.*Culture Terminal<\/span><\/a>/);
    expect(out).toContain('aria-label="Main"');
    expect(SITE_NAV.map((n) => [n.label, n.href])).toEqual([
      ["Your answers", "/briefs"],
      ["Following", "/following"],
      ["Screener", "/screener"],
      ["How it works", "/how-it-works"],
    ]);
    expect(out).toContain('href="/briefs"');
    expect(out).toContain('href="/following"');
    expect(out).toContain('href="/screener"');
    expect(out).toContain('href="/how-it-works"');
    expect(out).not.toContain("New question");
    expect(out).not.toMatch(/examples/i);
  });

  it("marks the active section", () => {
    const out = html(<Header active="answers" />);
    expect(out).toMatch(/<a[^>]*data-nav="answers"[^>]*aria-current="page"/);
    expect(out).not.toMatch(/data-nav="how"[^>]*aria-current/);
  });

  it("adds New question on inner pages only, pointing at Home's box", () => {
    expect(html(<Header variant="inner" />)).toContain(`href="${NEW_QUESTION_HREF}"`);
    expect(NEW_QUESTION_HREF).toBe("/#ask");
    expect(html(<Header variant="working" />)).not.toContain(`href="${NEW_QUESTION_HREF}"`);
  });

  it("has a phone header with a 44 px menu button", () => {
    const out = html(<Header variant="home" />);
    expect(out).toMatch(/<button[^>]*aria-label="Menu"[^>]*class="[^"]*size-11/);
    expect(out).toContain('aria-haspopup="dialog"');
  });

  it("has a phone answer header with back, share and menu", () => {
    const out = html(<Header variant="inner" mobile="answer" backHref="/briefs" />);
    expect(out).toMatch(/<a aria-label="Back"[^>]*href="\/briefs"/);
    expect(out).toContain('aria-label="Share"');
    expect(out).toContain('aria-label="Menu"');
    expect(out).toContain('aria-label="Culture Terminal home"');
  });
});

describe("footer", () => {
  it("states the honesty line and links How it works", () => {
    const out = html(<Footer />);
    expect(out).toContain("<footer");
    expect(out).toContain("Group-level taste data from Qloo · No individuals ·");
    expect(out).toContain("Not financial advice ·");
    expect(out).toMatch(/<a[^>]*href="\/how-it-works"[^>]*>How it works<\/a>/);
  });
});

describe("logo mark", () => {
  it("draws four squares in the topic colours", () => {
    const out = html(<LogoMark />);
    for (const t of ["brands", "places", "tours", "audiences"]) expect(out).toContain(`var(--color-topic-${t})`);
    expect(html(<LogoMark size={20} />)).toContain('width="9"');
  });
});

describe("page head", () => {
  it("shows the topic, eyebrow, actions and the question as the page heading", () => {
    const out = html(
      <PageHead topic="brands" eyebrow="Brands & investing · Real competitors" question="Who rivals Lumen Drinks?" actions={<button type="button">Share</button>} />,
    );
    expect(out).toContain('data-topic="brands"');
    expect(out).toContain("Brands &amp; investing · Real competitors");
    expect(out).toMatch(/<h1[^>]*>Who rivals Lumen Drinks\?<\/h1>/);
    expect(out).toContain("Share");
  });

  it("shows monograms on compare and a skeleton tile before the topic is known", () => {
    const compare = html(<PageHead topic="brands" eyebrow="E" question="Q" compare={{ subject: "Lumen Drinks", second: "Polar Orchard" }} />);
    expect(compare).toContain(">LD<");
    expect(compare).toContain(">PO<");
    expect(compare).toContain("vs");
    const early = html(<PageHead topic={null} eyebrow="" question="Q" questionAs="p" />);
    expect(early).toContain("animate-pulse");
    expect(early).not.toContain("<h1");
  });
});

describe("site shell", () => {
  it("wraps the page in header, main and footer landmarks, with a skip link", () => {
    const out = html(
      <SiteShell header="home">
        <h1>Page</h1>
      </SiteShell>,
    );
    expect(out).toContain('href="#main"');
    expect(out).toContain("<header");
    expect(out).toMatch(/<main id="main"[^>]*max-w-\[1176px\]/);
    expect(out).toContain("<footer");
    expect(out.indexOf("<header")).toBeLessThan(out.indexOf("<main"));
    expect(out.indexOf("<main")).toBeLessThan(out.indexOf("<footer"));
  });
});
