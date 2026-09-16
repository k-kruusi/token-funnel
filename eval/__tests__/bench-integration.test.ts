import { describe, expect, it } from "vitest";
import { makeStubDriver, STUB_MODEL_ID } from "../stub-driver.js";
import { runBench } from "../run-bench.js";

// In-process mirror of the green-bar CLI run: two arms × {50, 200} through the
// REAL funnelReversible from dist/, the built ccr tool, the stub driver, and
// the deterministic grader.
const OPTS = {
  seed: 24029,
  scales: [50, 200],
  budget: 50_000,
  noise: 8,
  qpt: 5,
  retrievalBudget: 8_000,
  commit: "test-commit",
};

describe("run-bench end-to-end (stub driver, offline)", () => {
  it("produces a well-formed report; ccr fires at scale 200; exhaustion error is exercised; deterministic", async () => {
    const run1 = await runBench(OPTS, makeStubDriver(OPTS.seed));
    const run2 = await runBench(OPTS, makeStubDriver(OPTS.seed));

    const { report, rawItems, funnelItems } = run1;
    expect(report.modelId).toBe(STUB_MODEL_ID);
    expect(report.temperature).toBe(0);
    expect(report.samplesPerQ).toBe(1);
    expect(rawItems).toHaveLength(2 * 15);
    expect(funnelItems).toHaveLength(2 * 15);

    const s50 = report.scaleCurve.find((p) => p.scale === 50)!;
    const s200 = report.scaleCurve.find((p) => p.scale === 200)!;
    // Scale 50 fits both arms whole — the stub answers from full coverage.
    expect(s50.armRaw_acc).toBe(1);
    expect(s50.armFunnel_acc).toBe(1);
    expect(s50.ccrRetrievals).toBe(0);
    // Scale 200 exceeds the budget: the ccr path actually fires...
    expect(s200.ccrRetrievals).toBeGreaterThan(0);
    // ...and the per-question retrieval budget exhausts with the clear error.
    expect(s200.retrievalBudgetExhaustions).toBeGreaterThan(0);
    const exhausted = funnelItems.find((i) => i.scale === 200 && i.retrievalError !== null);
    expect(exhausted).toBeDefined();
    expect(exhausted!.retrievalError).toMatch(/retrieval budget exhausted/);
    // The raw arm degrades at 200 (truncated prefix) — the falloff the curve exists to show.
    expect(s200.armRaw_acc).toBeLessThan(1);
    // Both arms' delivered chars are auditable and within the soft budget's ballpark.
    expect(s200.armRaw_chars).toBe(OPTS.budget);
    expect(s200.armFunnel_chars).toBeGreaterThan(0);

    // gaveUp items exist at 200 (the join's raw material) and grade tri-states are exhaustive.
    expect(rawItems.filter((i) => i.scale === 200 && i.graderState === "gaveUp").length).toBeGreaterThan(0);
    for (const i of [...rawItems, ...funnelItems]) {
      expect(["answered-correct", "answered-wrong", "gaveUp"]).toContain(i.graderState);
    }

    // Determinism: identical opts + seed → identical items and curve (generatedAt differs by design).
    expect(run2.rawItems).toEqual(rawItems);
    expect(run2.funnelItems).toEqual(funnelItems);
    expect(run2.report.scaleCurve).toEqual(report.scaleCurve);
  }, 60_000);
});
