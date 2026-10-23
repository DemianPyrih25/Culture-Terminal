// Key hints follow the keys a field binds: ⌘K on the command field, / on a list's search field, and no
// hint for a key nothing binds.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandField } from "../../components/ui/command-field";
import { Search } from "../../components/ui/fields";

const noop = () => {};

function kbd(html: string): string[] {
  return [...html.matchAll(/<kbd[^>]*>([^<]*)<\/kbd>/g)].map((m) => m[1]!);
}

function keyShortcuts(html: string): string | null {
  return html.match(/aria-keyshortcuts="([^"]*)"/)?.[1] ?? null;
}

describe("CommandField", () => {
  it("binds ⌘K and / by default and shows ⌘K", () => {
    const html = renderToStaticMarkup(<CommandField value="" onChange={noop} />);
    expect(kbd(html)).toEqual(["⌘K"]);
    expect(keyShortcuts(html)).toBe("Meta+K Control+K /");
    expect(html).toContain('role="search"');
    expect(html).toContain('placeholder="Ask a question"');
  });

  it("can leave / to the page's search field", () => {
    const html = renderToStaticMarkup(<CommandField value="" onChange={noop} shortcut={["mod-k"]} />);
    expect(kbd(html)).toEqual(["⌘K"]);
    expect(keyShortcuts(html)).toBe("Meta+K Control+K");
  });

  it("shows no hint without a bound key, unless one is asked for", () => {
    expect(kbd(renderToStaticMarkup(<CommandField value="" onChange={noop} shortcut={false} />))).toEqual([]);
    const still = renderToStaticMarkup(<CommandField value="" onChange={noop} shortcut={false} keycap="⌘K" />);
    expect(kbd(still)).toEqual(["⌘K"]);
    expect(keyShortcuts(still)).toBeNull();
  });

  it("drops the shortcut while disabled", () => {
    expect(keyShortcuts(renderToStaticMarkup(<CommandField value="" onChange={noop} disabled />))).toBeNull();
  });
});

describe("Search", () => {
  it("binds nothing and shows no hint by default", () => {
    const html = renderToStaticMarkup(<Search placeholder="Search briefs" />);
    expect(kbd(html)).toEqual([]);
    expect(keyShortcuts(html)).toBeNull();
    expect(html).toContain('type="search"');
    expect(html).toContain("Search briefs");
  });

  it("takes / when asked, never ⌘K", () => {
    const html = renderToStaticMarkup(<Search placeholder="Search briefs" shortcut />);
    expect(kbd(html)).toEqual(["/"]);
    expect(keyShortcuts(html)).toBe("/");
  });
});
