import { describe, expect, it } from "vitest";
import { extractAnswer, grade, normalizeAnswer } from "../grade.js";

describe("grade — deterministic tri-state, no LLM", () => {
  it("answered-correct on exact match after normalization", () => {
    expect(grade("Counting...\nANSWER: 67", "67")).toBe("answered-correct");
    expect(grade("ANSWER:   Delta.", "delta")).toBe("answered-correct");
  });

  it("answered-wrong on a parseable but mismatched answer", () => {
    expect(grade("ANSWER: 66", "67")).toBe("answered-wrong");
  });

  it("gaveUp when no ANSWER line is parseable", () => {
    expect(grade("I can't determine the exact count from a truncated table.", "67")).toBe("gaveUp");
    expect(grade("The answer is probably 67 but I am not sure", "67")).toBe("gaveUp");
  });

  it("the LAST ANSWER line wins (models think aloud)", () => {
    expect(extractAnswer("ANSWER: 3\nwait, recounting\nANSWER: 5")).toBe("5");
  });

  it("normalization trims, lowercases, strips trailing periods, collapses spaces", () => {
    expect(normalizeAnswer("  Gamma. ")).toBe("gamma");
    expect(normalizeAnswer("14  rows")).toBe("14 rows");
  });
});
