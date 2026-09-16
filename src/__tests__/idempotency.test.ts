import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { funnel } from "../index.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf-8");
}

// Content from bash.ts arrives at traffic-mirror already compressed once.
// funnel(funnel(x)) must not cascade into further mangling — this is the
// "natural idempotency" property the design relies on instead of a
// double-compression sentinel (see the README's "How it works" section).
const CASES: Array<{ name: string; hint: string }> = [
  { name: "git-diff-multi-file.txt", hint: "git" },
  { name: "vitest-run-failing.txt", hint: "test-output" },
  { name: "vitest-run-passing.txt", hint: "test-output" },
  { name: "grep-multi-file.txt", hint: "grep" },
  { name: "tsc-build-errors.txt", hint: "build-output" },
  { name: "npm-build-clean.txt", hint: "build-output" },
];

// Tight enough that the first pass performs real compression on every fixture
// (none of these are simply passed through untouched), but not so tight that
// keep_always content routinely blows past the soft budget — see the
// calibration in honest-response.test.ts for why an overly aggressive budget
// here would make even a single pass legitimately keep re-trimming further.
const MAX_CHARS = 2000;

describe("idempotency: funnel(funnel(x, hint), hint)", () => {
  for (const { name, hint } of CASES) {
    it(`${name} is stable under a second pass`, () => {
      const raw = fixture(name);
      const once = funnel(raw, hint, { maxChars: MAX_CHARS });
      const twice = funnel(once, hint, { maxChars: MAX_CHARS });

      const shrink = 1 - twice.length / once.length;
      expect(shrink).toBeLessThanOrEqual(0.1);

      // Every placeholder is a single "⋯ ... ⋯" span — a nested/doubled
      // placeholder would leave an odd number of the glyph in the text.
      const glyphCount = (twice.match(/⋯/g) ?? []).length;
      expect(glyphCount % 2).toBe(0);
      expect(twice).not.toContain("⋯ ⋯");
    });
  }

  it("keeps every universal keep_always line present after a second pass", () => {
    const raw = fixture("vitest-run-failing.txt");
    const once = funnel(raw, "test-output", { maxChars: MAX_CHARS });
    const twice = funnel(once, "test-output", { maxChars: MAX_CHARS });
    const failLines = raw.split("\n").filter((l) => /^FAIL /.test(l));
    for (const l of failLines) {
      expect(once).toContain(l);
      expect(twice).toContain(l);
    }
  });
});
