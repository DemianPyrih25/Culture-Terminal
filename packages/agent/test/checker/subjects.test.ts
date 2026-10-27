// CHECKER V2's subject half: a metric token set beside another entity's name. Invented entities only (D29).
import type { MetricId } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { misattributedTokens } from "../../src/report/subjects";

const ENTITIES = [
  { ref: "R1", name: "Brand Alpha" },
  { ref: "R2", name: "Show Nova with Dana Vale" },
  { ref: "R3", name: "The Lumen Hour" },
  { ref: "R4", name: "Dr. Orbit Labs" },
];
const SUBJECTS: Record<string, string[]> = { M1: ["R1"], M2: ["R2"], M3: ["R3"], M4: ["R4"], M5: ["R2", "R3"], M6: ["35_to_44"] };
const metric = (id: MetricId) => (SUBJECTS[id] === undefined ? undefined : { subjectRefs: SUBJECTS[id] });
const misattributed = (text: string) => misattributedTokens(text, metric, ENTITIES).map((t) => t.id);

describe("misattributedTokens", () => {
  it("flags a token whose lead-up names another entity, by its whole name or a distinctive word", () => {
    expect(misattributed("In the scan Nova sat at {{M3}}.")).toEqual(["M3"]);
    expect(misattributed("Show Nova with Dana Vale ranks {{M1}} [E1].")).toEqual(["M1"]);
    expect(misattributedTokens("In the scan Nova sat at {{M3}}.", metric, ENTITIES)[0]).toEqual({
      id: "M3",
      subjects: ["The Lumen Hour"],
      named: ["Show Nova with Dana Vale"],
    });
  });

  it("passes list items, pair metrics, pronouns and a subject named anywhere in the sentence", () => {
    expect(misattributed("Nova ranks {{M2}}, the Lumen show {{M3}} and Alpha {{M1}}.")).toEqual([]);
    expect(misattributed("Nova and Lumen sit close {{M5}}.")).toEqual([]);
    expect(misattributed("Next to Nova, it ranks {{M3}}.")).toEqual([]);
    expect(misattributed("Nova trails {{M3}}, the Lumen Hour's rank.")).toEqual([]);
    // A metric about no registered entity is never judged.
    expect(misattributed("Nova leads at 35–44 {{M6}}.")).toEqual([]);
  });

  it("does not read a capitalised sentence opener or an abbreviation as a name or a sentence break", () => {
    // "Orbit" opens the second sentence; "Dr." does not end the first.
    expect(misattributed("Lumen leads. Orbit gains {{M3}}.")).toEqual([]);
    expect(misattributed("Dr. Orbit Labs ranks {{M4}}, ahead of Lumen.")).toEqual([]);
    expect(misattributed("The Lumen Hour leads; Dr. Orbit sits at {{M3}}.")).toEqual(["M3"]);
  });

  it("judges nothing with fewer than two registered entities", () => {
    expect(misattributedTokens("Nova sat at {{M3}}.", metric, ENTITIES.slice(0, 1))).toEqual([]);
  });
});
