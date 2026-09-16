import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compressTestOutput, compressBuildOutput, compressGeneric, funnel } from "../index.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf-8");
}

const VITEST_FAILING = fixture("vitest-run-failing.txt");
const VITEST_PASSING = fixture("vitest-run-passing.txt");
const TSC_ERRORS = fixture("tsc-build-errors.txt");

// The Honest Response Principle: an MCP tool must never silently drop the
// content that tells a caller what actually went wrong. These tests are the
// project's invariant suite for that guarantee as it applies to token-funnel —
// see the "Honest Response Principle" section of the repo CLAUDE.md.
describe("Honest Response Principle", () => {
  it("preserves every FAIL-prefixed test name, AssertionError line, and the Tests: summary under a tight budget", () => {
    const out = compressTestOutput(VITEST_FAILING, { maxChars: 400 });
    const failLines = VITEST_FAILING.split("\n").filter((l) => /^FAIL /.test(l));
    const assertionLines = VITEST_FAILING.split("\n").filter((l) => /AssertionError:/.test(l));
    expect(failLines.length).toBeGreaterThan(0);
    for (const l of failLines) expect(out).toContain(l);
    for (const l of assertionLines) expect(out).toContain(l);
    expect(out).toMatch(/Tests\s+\d+ failed/);
  });

  it("preserves every error TS line plus at least one line of context after it", () => {
    const out = compressBuildOutput(TSC_ERRORS, { maxChars: 300 });
    const errorLines = TSC_ERRORS.split("\n").filter((l) => /error TS\d+/.test(l));
    expect(errorLines.length).toBeGreaterThan(0);
    const outLines = out.split("\n");
    for (const errorLine of errorLines) {
      const idx = outLines.indexOf(errorLine);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx + 1).toBeLessThan(outLines.length);
    }
  });

  it("compresses a passing run more aggressively than a failing run of comparable size", () => {
    const budget = 300;
    const outFailing = compressTestOutput(VITEST_FAILING, { maxChars: budget });
    const outPassing = compressTestOutput(VITEST_PASSING, { maxChars: budget });
    expect(outPassing.length).toBeLessThan(outFailing.length);
  });

  it("still preserves keep_always content when run through the wrong profile", () => {
    // compressGeneric has none of test-output's category-specific rules — only
    // the universal keep_always floor. Misclassification should degrade the
    // compression ratio, never the correctness of what survives.
    const out = compressGeneric(VITEST_FAILING, { maxChars: 400 });
    const failLines = VITEST_FAILING.split("\n").filter((l) => /^FAIL /.test(l));
    const assertionLines = VITEST_FAILING.split("\n").filter((l) => /AssertionError:/.test(l));
    for (const l of failLines) expect(out).toContain(l);
    for (const l of assertionLines) expect(out).toContain(l);
  });

  it("isError does not gate keep_always survival either way — content truth overrides the caller's signal", () => {
    const raw = ["context before", "Error: something broke", "context after"].join("\n");
    const withTrue = funnel(raw, "generic", { maxChars: 30, isError: true });
    const withFalse = funnel(raw, "generic", { maxChars: 30, isError: false });
    const withUndefined = funnel(raw, "generic", { maxChars: 30 });
    expect(withTrue).toContain("Error: something broke");
    expect(withFalse).toContain("Error: something broke");
    expect(withUndefined).toContain("Error: something broke");
  });

  it("isError: true widens boilerplate/progress to context instead of disabling compression", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `✓ passing test ${i}`).join("\n");
    const normal = compressTestOutput(raw, { maxChars: 40, minHeadLines: 0, minTailLines: 0 });
    const flagged = compressTestOutput(raw, { maxChars: 40, minHeadLines: 0, minTailLines: 0, isError: true });
    // Both still compress (isError doesn't disable the budget), but the widened
    // run competes as "context" instead of being collapsed as "boilerplate"
    // first, so it is not identical to the unflagged compression.
    expect(flagged).not.toBe(normal);
  });

  it("emits the emergency-cap truncation marker when keep_always content alone exceeds 4x maxChars", () => {
    const errorLines = Array.from({ length: 500 }, (_, i) => `Error: failure number ${i} with some detail padding`);
    const raw = errorLines.join("\n");
    const maxChars = 100;
    const out = funnel(raw, "generic", { maxChars });
    expect(out).toContain("[token-funnel: truncated at emergency cap");
  });
});
