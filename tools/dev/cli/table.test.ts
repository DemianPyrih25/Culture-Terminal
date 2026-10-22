import { describe, expect, it } from "vitest";
import { memoryIo, safeIo } from "./io";
import { clean, displayWidth, padCell, renderTable, terminalSafe, truncate, wrapText } from "./table";

// Escape sequences an untrusted Qloo name or LLM sentence could carry: a colour, a clipboard write
// (OSC 52), a hyperlink (OSC 8), a C1 CSI, a bidi override and a zero-width space.
const HOSTILE = "Brand \u001b[31mRed\u001b[0m \u001b]52;c;ZXZpbA==\u0007\u001b]8;;https://x\u001b\\link \u009b2J\u{202e}evil\u{200b}";
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2069}\u{feff}]/u;

describe("clean and terminalSafe", () => {
  it("drop every control character and keep the visible text", () => {
    expect(clean(HOSTILE)).not.toMatch(CONTROL);
    expect(clean(HOSTILE)).toBe("Brand [31mRed[0m ]52;c;ZXZpbA==]8;;https://x\\link 2Jevil");
    expect(clean("Café ①")).toBe("Café ①");
  });

  it("turn tabs and line breaks into spaces; terminalSafe keeps line feeds", () => {
    expect(clean("a\tb\r\nc\u{2028}d")).toBe("a b  c d");
    expect(terminalSafe("\nHEADING\r\u001b[2K\tx")).toBe("\nHEADING [2K x");
  });

  it("guard every line written through safeIo", () => {
    const io = memoryIo();
    const safe = safeIo(io);
    safe.out(HOSTILE);
    safe.err(`\n${HOSTILE}`);
    expect([...io.stdout, ...io.stderr].join("")).not.toMatch(CONTROL);
    expect(io.stderr[0]?.startsWith("\nBrand ")).toBe(true);
  });
});

describe("displayWidth", () => {
  it("counts code points and gives combining marks no width", () => {
    expect(displayWidth("Brand")).toBe(5);
    expect(displayWidth("Café")).toBe(4);
    expect(displayWidth("0.42 ①")).toBe(6);
    expect(displayWidth("—")).toBe(1);
  });
});

describe("truncate", () => {
  it("cuts to the width with an ellipsis and leaves short text alone", () => {
    expect(truncate("Brand Alpha", 20)).toBe("Brand Alpha");
    expect(truncate("Brand Alpha", 6)).toBe("Brand…");
    expect(truncate("Brand Alpha", 6)).toHaveLength(6);
    expect(truncate("abc", 0)).toBe("");
  });
});

describe("padCell", () => {
  it("pads by display width on either side", () => {
    expect(padCell("①", 3)).toBe("①  ");
    expect(padCell("12", 4, "right")).toBe("  12");
  });
});

describe("renderTable", () => {
  it("aligns columns, right-aligns where asked and trims trailing spaces", () => {
    const lines = renderTable(
      [{ header: "id" }, { header: "ms", align: "right" }, { header: "note" }],
      [
        ["M1", "5 ms", ""],
        ["M12", "1.2 s", "slow"],
      ],
      { indent: "  " },
    );
    expect(lines).toEqual(["  id      ms  note", "  M1    5 ms", "  M12  1.2 s  slow"]);
  });

  it("cuts cells to a column's max and keeps leading spaces of a cell", () => {
    const lines = renderTable([{ header: "name", max: 8 }, { header: "x" }], [["  Brand Alpha Classic", "1"]], { noHeader: true });
    expect(lines).toEqual(["  Brand…  1"]);
  });

  it("puts a multi-line cell on one line and renders missing cells empty", () => {
    expect(renderTable([{ header: "a" }, { header: "b" }], [["x\ny"]], { noHeader: true })).toEqual(["x y"]);
  });

  it("strips escape sequences from cells, so they neither reach the terminal nor skew the widths", () => {
    const lines = renderTable([{ header: "name" }, { header: "n" }], [["\u001b[31mRed\u001b[0m", "1"], ["Blue", "2"]]);
    expect(lines.join("\n")).not.toMatch(CONTROL);
    expect(lines).toEqual(["name        n", "[31mRed[0m  1", "Blue        2"]);
  });
});

describe("wrapText", () => {
  it("wraps on word boundaries and gives an over-long word its own line", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(wrapText("a supercalifragilistic b", 5)).toEqual(["a", "supercalifragilistic", "b"]);
    expect(wrapText("   ", 10)).toEqual([""]);
  });
});
