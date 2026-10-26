// The tearsheet's address and search box (P1 #1, "<NAME> DES"): what a URL and a typed command ask for,
// and the paths the pages link to. Invented names only (D29).
import { describe, expect, it } from "vitest";
import { cleanDesName, desCommandHref, desHref, desMnemonic, parseDesCommand, parseDesInput, parseDesQuery } from "../../components/des/des-href";

describe("parseDesQuery", () => {
  it("reads a brand by default, another type from ?type= and a well-formed pick", () => {
    expect(parseDesQuery("Juniper%20Cola")).toEqual({ name: "Juniper Cola", type: "brand", pick: null });
    expect(parseDesQuery("Juniper Cola")).toEqual({ name: "Juniper Cola", type: "brand", pick: null });
    expect(parseDesQuery("Artist Nova", { type: "ARTIST" })).toEqual({ name: "Artist Nova", type: "artist", pick: null });
    expect(parseDesQuery("Juniper Twin", { pick: "pk_00000000000000ab" })).toEqual({ name: "Juniper Twin", type: "brand", pick: "pk_00000000000000ab" });
    expect(parseDesQuery("Juniper Twin", { type: ["tv_show", "brand"], pick: ["pk_00000000000000ab"] })?.type).toBe("tv_show");
  });

  it("drops a malformed pick rather than failing, and refuses a type a tearsheet does not take", () => {
    expect(parseDesQuery("Juniper Twin", { pick: "R1" })?.pick).toBeNull();
    expect(parseDesQuery("Juniper Twin", { pick: "pk_zz" })?.pick).toBeNull();
    expect(parseDesQuery("East Side", { type: "place" })).toBeNull();
    expect(parseDesQuery("Elk Lake", { type: "destination" })).toBeNull();
    expect(parseDesQuery("Juniper Cola", { type: "soda" })).toBeNull();
  });

  it("keeps punctuation names carry and refuses what no name needs", () => {
    expect(parseDesQuery(encodeURIComponent("Nova & Vale's"))?.name).toBe("Nova & Vale's");
    expect(parseDesQuery(encodeURIComponent("Echo/Lights"))?.name).toBe("Echo/Lights");
    expect(parseDesQuery("100%25 Juniper")?.name).toBe("100% Juniper");
    // A literal % that is not an escape is kept as typed.
    expect(parseDesQuery("100% Juniper")?.name).toBe("100% Juniper");
    expect(parseDesQuery(encodeURIComponent("<script>"))).toBeNull();
    expect(parseDesQuery("...")).toBeNull();
    expect(parseDesQuery("x".repeat(81))).toBeNull();
  });
});

describe("cleanDesName", () => {
  it("collapses spaces and refuses control and zero-width characters", () => {
    expect(cleanDesName("  Juniper \t  Cola ")).toBe("Juniper Cola");
    expect(cleanDesName(`Juniper${String.fromCharCode(0x200b)}Cola`)).toBeNull();
    expect(cleanDesName(`Juniper${String.fromCharCode(0x07)}`)).toBeNull();
    expect(cleanDesName("")).toBeNull();
  });
});

describe("desHref", () => {
  it("puts the name in the path as typed and the type only when it is not a brand", () => {
    expect(desHref({ name: "Juniper Cola", type: "brand" })).toBe("/d/Juniper%20Cola");
    expect(desHref({ name: "Artist Nova", type: "artist" })).toBe("/d/Artist%20Nova?type=artist");
    expect(desHref({ name: "Echo/Lights", type: "podcast", pick: "pk_00000000000000ab" })).toBe("/d/Echo%2FLights?type=podcast&pick=pk_00000000000000ab");
  });

  it("round-trips through parseDesQuery", () => {
    for (const query of [
      { name: "Nova & Vale's", type: "tv_show", pick: null },
      { name: "Comedian Vega", type: "person", pick: "pk_00000000000000cd" },
    ] as const) {
      const url = new URL(desHref(query), "http://localhost");
      const parsed = parseDesQuery(url.pathname.slice("/d/".length), Object.fromEntries(url.searchParams));
      expect(parsed).toEqual(query);
    }
  });
});

describe("parseDesInput", () => {
  it("takes a plain name with the type picked beside the box", () => {
    expect(parseDesInput("Juniper Cola")).toEqual({ name: "Juniper Cola", type: "brand" });
    expect(parseDesInput("Comedian Vega", "person")).toEqual({ name: "Comedian Vega", type: "person" });
    expect(parseDesInput("Comedian Vega", "venue")).toEqual({ name: "Comedian Vega", type: "brand" });
  });

  it("compiles <NAME> DES, with a type marker that overrides the picked type", () => {
    expect(parseDesInput("Juniper Cola DES")).toEqual({ name: "Juniper Cola", type: "brand" });
    expect(parseDesInput("Artist Nova <ARTIST> DES", "brand")).toEqual({ name: "Artist Nova", type: "artist" });
    expect(parseDesInput("The Quiet Report <PODCAST>")).toEqual({ name: "The Quiet Report", type: "podcast" });
    expect(parseDesInput("East Side <PLACE> DES")).toBeNull();
    expect(parseDesInput("<ARTIST> DES")).toBeNull();
  });

  it("reads a question field's input as a tearsheet only when it ends in DES", () => {
    expect(parseDesCommand("Artist Nova <ARTIST> DES")).toEqual({ name: "Artist Nova", type: "artist" });
    expect(parseDesCommand("  Juniper   Cola DES ")).toEqual({ name: "Juniper Cola", type: "brand" });
    expect(parseDesCommand("Juniper Cola")).toBeNull();
    expect(parseDesCommand("Juniper Cola des")).toBeNull();
  });

  it("sends the command typed where questions go to its tearsheet, and a question nowhere", () => {
    expect(desCommandHref("Artist Nova <ARTIST> DES")).toBe("/d/Artist%20Nova?type=artist");
    expect(desCommandHref("Juniper Cola DES")).toBe("/d/Juniper%20Cola");
    expect(desCommandHref("Who loves Juniper Cola?")).toBeNull();
    expect(desCommandHref("<> DES")).toBeNull();
  });

  it("prints the command the grammar compiles", () => {
    expect(desMnemonic({ name: "Artist Nova", type: "artist" })).toBe("ARTIST NOVA <ARTIST> DES");
  });
});
