import { describe, it, expect } from "vitest";
import { allocateBudget, reconstruct } from "../internal/budget.js";
import { GENERIC_PROFILE } from "../profiles/generic.js";
import type { LineRecord } from "../types.js";

function rec(line: string, tag: LineRecord["tag"], repeats = 1): LineRecord {
  return { line, tag, repeats };
}

describe("allocateBudget", () => {
  it("always keeps keep_always records regardless of budget", () => {
    const records = [
      rec("Error: boom", "keep_always"),
      rec("context line", "context"),
    ];
    const { kept } = allocateBudget(records, 5, 200_000, 0, 0, GENERIC_PROFILE);
    expect(kept[0]).toBe(true);
  });

  it("keeps keep_always in full and marks the soft-budget-exceeded overage", () => {
    const records = [rec("x".repeat(100), "keep_always")];
    const { kept, markers } = allocateBudget(records, 10, 200_000, 0, 0, GENERIC_PROFILE);
    expect(kept[0]).toBe(true);
    expect(markers.softBudgetExceededChars).toBeGreaterThan(0);
  });

  it("truncates keep_always only when it exceeds the emergency cap", () => {
    const records = Array.from({ length: 100 }, (_, i) => rec(`err line ${i}`.padEnd(50, "!"), "keep_always"));
    const { kept, markers } = allocateBudget(records, 100_000, 500, 0, 0, GENERIC_PROFILE);
    expect(kept.some((k) => !k)).toBe(true);
    expect(markers.emergencyTruncatedChars).toBeGreaterThan(0);
  });

  it("spends remaining budget in priority order: signal > context > boilerplate > redundant > progress", () => {
    const records = [
      rec("progress spam", "progress"),
      rec("boilerplate noise", "boilerplate"),
      rec("real signal", "signal"),
      rec("ordinary context", "context"),
    ];
    // Budget only big enough for the highest-priority tier.
    const cost = (s: string) => s.length + 1;
    const budget = cost("real signal");
    const { kept } = allocateBudget(records, budget, 200_000, 0, 0, GENERIC_PROFILE);
    expect(kept[2]).toBe(true); // signal survives
    expect(kept[0]).toBe(false); // progress dropped
    expect(kept[1]).toBe(false); // boilerplate dropped
    expect(kept[3]).toBe(false); // context dropped (lower priority than signal)
  });

  it("force-keeps minHeadLines and minTailLines regardless of tag", () => {
    const records = [
      rec("head boilerplate", "boilerplate"),
      rec("middle progress 1", "progress"),
      rec("middle progress 2", "progress"),
      rec("tail boilerplate", "boilerplate"),
    ];
    const { kept } = allocateBudget(records, 0, 200_000, 1, 1, GENERIC_PROFILE);
    expect(kept[0]).toBe(true); // head
    expect(kept[3]).toBe(true); // tail
  });

  it("trims a tier from the middle, preserving both head and tail of that tier", () => {
    const records = Array.from({ length: 10 }, (_, i) => rec(`context ${i}`, "context"));
    const cost = (s: string) => s.length + 1;
    // Budget for roughly half the tier's lines.
    const budget = records.slice(0, 5).reduce((sum, r) => sum + cost(r.line), 0);
    const { kept } = allocateBudget(records, budget, 200_000, 0, 0, GENERIC_PROFILE);
    expect(kept[0]).toBe(true); // head of tier survives
    expect(kept[9]).toBe(true); // tail of tier survives
    expect(kept.some((k) => !k)).toBe(true); // something in the middle was dropped
  });

  it("costs a redundant record by its rendered placeholder length, not its pre-fold line length — so it doesn't starve a lower-priority tier", () => {
    // reconstruct() always renders a redundant (repeats > 1) record as its short
    // placeholder, regardless of budget outcome — see the "always shows the
    // redundant placeholder" test below. Charging it at the full pre-fold line
    // length would over-subtract from `remaining`, leaving less for whatever
    // comes after "redundant" in TIER_ORDER (i.e. "progress") than the record
    // actually costs once rendered.
    const longLine = "x".repeat(1500);
    const records = [rec(longLine, "redundant", 50), rec("progress spam", "progress")];
    const placeholderCost = GENERIC_PROFILE.placeholders.redundant!(50).length + 1;
    const progressCost = "progress spam".length + 1;
    const preFoldLineCost = longLine.length + 1;
    // Chosen to sit strictly between the two accountings: enough for the whole
    // redundant "tier" to fit under the (buggy) pre-fold line cost, but not
    // enough left over afterward for the progress record too — while the
    // TRUE (placeholder-based) cost leaves ample room for both.
    const budget = preFoldLineCost + 4;
    expect(budget).toBeLessThan(preFoldLineCost + progressCost); // old accounting: progress wouldn't fit
    expect(budget).toBeGreaterThan(placeholderCost + progressCost); // new accounting: comfortably fits both
    const { kept } = allocateBudget(records, budget, 200_000, 0, 0, GENERIC_PROFILE);
    expect(kept[0]).toBe(true); // redundant record itself always "survives" the pass
    expect(kept[1]).toBe(true); // progress record fits under the corrected (placeholder) cost
  });
});

describe("reconstruct", () => {
  it("silently omits a single dropped line (no placeholder spam)", () => {
    const records = [rec("a", "context"), rec("b", "boilerplate"), rec("c", "context")];
    const kept = [true, false, true];
    const text = reconstruct(records, kept, GENERIC_PROFILE, {});
    expect(text).toBe("a\nc");
  });

  it("collapses a run of ≥2 consecutive dropped same-tag records into one placeholder", () => {
    const records = [rec("a", "context"), rec("b1", "boilerplate"), rec("b2", "boilerplate"), rec("c", "context")];
    const kept = [true, false, false, true];
    const text = reconstruct(records, kept, GENERIC_PROFILE, {});
    expect(text).toContain("⋯ 2 lines collapsed ⋯");
    expect(text.split("\n")).toEqual(["a", "⋯ 2 lines collapsed ⋯", "c"]);
  });

  it("always shows the redundant placeholder, kept or dropped", () => {
    const keptRedundant = rec("dup", "redundant", 5);
    const text1 = reconstruct([keptRedundant], [true], GENERIC_PROFILE, {});
    expect(text1).toBe("⋯ (repeated 5 times) ⋯");
    const text2 = reconstruct([keptRedundant], [false], GENERIC_PROFILE, {});
    expect(text2).toBe("⋯ (repeated 5 times) ⋯");
  });

  it("appends the soft-budget-exceeded marker", () => {
    const text = reconstruct([], [], GENERIC_PROFILE, { softBudgetExceededChars: 42 });
    expect(text).toContain("[token-funnel: 42 chars of error detail exceeded soft budget]");
  });

  it("appends the emergency-cap truncation marker", () => {
    const text = reconstruct([], [], GENERIC_PROFILE, { emergencyTruncatedChars: 99 });
    expect(text).toContain("[token-funnel: truncated at emergency cap, 99 chars of error detail omitted]");
  });
});
