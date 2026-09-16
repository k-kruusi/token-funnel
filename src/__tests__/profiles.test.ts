import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compressGit, compressTestOutput, compressBuildOutput, compressGrep, compressFileRead } from "../index.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf-8");
}

const GIT_DIFF = fixture("git-diff-multi-file.txt");
const VITEST_FAILING = fixture("vitest-run-failing.txt");
const VITEST_PASSING = fixture("vitest-run-passing.txt");
const GREP_MULTI = fixture("grep-multi-file.txt");
const NPM_BUILD_CLEAN = fixture("npm-build-clean.txt");

function ratio(raw: string, compressed: string): number {
  return 1 - compressed.length / raw.length;
}

// A tight budget is what actually exercises tier-based trimming — these
// fixtures are a few KB, well under the 50_000-char production default, so a
// realistic-sized budget would leave everything untouched (ratio 0).
const APPLICABLE_BUDGET = 200;
// A generous budget for the mismatch checks: big enough that a profile which
// doesn't recognize the fixture's category-specific noise has nothing left
// worth trimming once its own (smaller) floor/keep_always content is kept.
const MISMATCH_BUDGET = 3500;

describe("compression ratio: applicable profile vs its own fixture (60-90% reduction)", () => {
  it("git profile on a git diff", () => {
    const r = ratio(GIT_DIFF, compressGit(GIT_DIFF, { maxChars: APPLICABLE_BUDGET }));
    expect(r).toBeGreaterThanOrEqual(0.6);
    expect(r).toBeLessThanOrEqual(0.9);
  });

  it("test-output profile on a passing test run", () => {
    const r = ratio(VITEST_PASSING, compressTestOutput(VITEST_PASSING, { maxChars: APPLICABLE_BUDGET }));
    expect(r).toBeGreaterThanOrEqual(0.6);
    expect(r).toBeLessThanOrEqual(0.9);
  });

  it("build-output profile on a clean build", () => {
    const r = ratio(NPM_BUILD_CLEAN, compressBuildOutput(NPM_BUILD_CLEAN, { maxChars: APPLICABLE_BUDGET }));
    expect(r).toBeGreaterThanOrEqual(0.6);
    expect(r).toBeLessThanOrEqual(0.9);
  });

  it("grep profile on multi-file matches", () => {
    const r = ratio(GREP_MULTI, compressGrep(GREP_MULTI, { maxChars: APPLICABLE_BUDGET }));
    expect(r).toBeGreaterThanOrEqual(0.6);
    expect(r).toBeLessThanOrEqual(0.9);
  });
});

describe("compression ratio: mismatched profile still works, just less well (< 30% reduction)", () => {
  it("git profile on a test-output fixture", () => {
    const r = ratio(VITEST_FAILING, compressGit(VITEST_FAILING, { maxChars: MISMATCH_BUDGET }));
    expect(r).toBeLessThan(0.3);
  });

  it("test-output profile on a git diff fixture", () => {
    const r = ratio(GIT_DIFF, compressTestOutput(GIT_DIFF, { maxChars: MISMATCH_BUDGET }));
    expect(r).toBeLessThan(0.3);
  });

  it("build-output profile on a grep fixture", () => {
    const r = ratio(GREP_MULTI, compressBuildOutput(GREP_MULTI, { maxChars: MISMATCH_BUDGET }));
    expect(r).toBeLessThan(0.3);
  });

  it("grep profile on a build-output fixture", () => {
    const r = ratio(NPM_BUILD_CLEAN, compressGrep(NPM_BUILD_CLEAN, { maxChars: MISMATCH_BUDGET }));
    expect(r).toBeLessThan(0.3);
  });
});

describe("compressGrep on paginated (already-truncated) output", () => {
  it("placeholder count reflects only the excess matches visible in the input", () => {
    // grep-multi-file.txt has exactly 25 matches for src/profiles/generated.ts
    // — 20 survive as signal, the remaining 5 collapse. The engine only ever
    // sees what's actually in the string, so a caller that already paginated
    // the raw ripgrep output before calling compressGrep gets a placeholder
    // count scoped to that visible slice, never an inflated "real" total.
    const out = compressGrep(GREP_MULTI, { maxChars: 1000, minHeadLines: 0, minTailLines: 0 });
    expect(out).toContain("⋯ 5 additional matches collapsed ⋯");
  });
});

describe("compressFileRead with a numbered gutter", () => {
  function numbered(lines: string[]): string {
    return lines.map((l, i) => `${String(i + 1).padStart(6)} │ ${l}`).join("\n");
  }

  it("dedups identical content lines despite different gutter-number prefixes", () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => `unique line ${i + 1}`),
      ...Array.from({ length: 10 }, () => "    return null;"),
      ...Array.from({ length: 5 }, (_, i) => `unique line ${i + 16}`),
    ];
    const out = compressFileRead(numbered(lines), { maxChars: 50_000 });
    expect(out).toContain("unique line 1");
    expect(out).toContain("unique line 20");
    expect(out).not.toContain("    return null;\n    return null;");
  });

  it("formats a collapsed run as a line-number range", () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => `unique line ${i + 1}`),
      ...Array.from({ length: 10 }, () => "    return null;"),
      ...Array.from({ length: 5 }, (_, i) => `unique line ${i + 16}`),
    ];
    const out = compressFileRead(numbered(lines), { maxChars: 50_000 });
    expect(out).toContain("6-15 │ (repeated 10 times)");
  });

  it("preserves original gutter numbers on surviving lines", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line content ${i + 1}`);
    const out = compressFileRead(numbered(lines), { maxChars: 50_000 });
    expect(out).toContain("     1 │ line content 1");
    expect(out).toContain("     5 │ line content 5");
  });

  // Regression: reconstruct() silently omits a SINGLE dropped record with no
  // placeholder at all (by design — see budget.test.ts). postprocess() must not
  // mistake the next real surviving line for a placeholder just because it
  // doesn't match at the cursor — that would mislabel real content as a bogus
  // collapsed range and lose its true line number.
  it("gives a real surviving line its own correct gutter number even when an isolated single line before it was silently dropped", () => {
    const lines = [
      "aaa context filler one two three four five six seven eight",
      "bbb context filler one two three four five six seven eight nine",
      "has an error in it right here",
      "ccc context filler one two three four five six seven eight nine ten",
      "ddd context filler",
    ];
    const out = compressFileRead(numbered(lines), { maxChars: 60, minHeadLines: 1, minTailLines: 1 });
    // Line 5 is real, surviving content — never a fabricated "N-5" range.
    expect(out).toContain("     5 │ ddd context filler");
    expect(out).not.toMatch(/\d+-5 │/);
  });
});

// The fixture-ratio tests above exercise these rules incidentally (as part of a
// realistic multi-KB fixture) but never assert them by name. These construct
// minimal, hand-crafted inputs so each rule is proven in isolation.
describe("individual profile rules (isolated from the aggregate fixture ratios above)", () => {
  const cost = (s: string) => s.length + 1;

  it("git: collapses a lockfile diff's hunk body under budget pressure, even though its content isn't otherwise noise-shaped", () => {
    const header = "diff --git a/package-lock.json b/package-lock.json";
    const body = [
      "index abc123..def456 100644",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -10,6 +10,6 @@",
      '-    "version": "1.0.0",',
      '+    "version": "1.0.1",',
      '     "resolved": "https://registry.npmjs.org/foo",',
      '     "integrity": "sha512-abc",',
      '     "dependencies": {',
    ];
    const raw = [header, ...body].join("\n");
    // Budget for the header alone, with strictly less left over than the
    // cheapest body line — guarantees the whole (all-boilerplate, under the
    // lockfile rule) body collapses rather than partially surviving.
    const maxChars = cost(header) + Math.min(...body.map(cost)) - 1;
    const out = compressGit(raw, { maxChars, minHeadLines: 0, minTailLines: 0 });
    expect(out).toContain(header);
    expect(out).toContain("lockfile/generated");
    expect(out).not.toContain('"resolved"');
  });

  it("git: caps unchanged hunk-context lines at 3 per hunk, collapsing the rest", () => {
    const header = "diff --git a/src/foo.ts b/src/foo.ts";
    const hunkHeader = "@@ -1,10 +1,10 @@";
    const contextLines = Array.from({ length: 10 }, (_, i) => ` unchanged context line ${i}`);
    const raw = [header, hunkHeader, ...contextLines].join("\n");
    const kept = [hunkHeader, ...contextLines.slice(0, 3)];
    const overflow = contextLines.slice(3);
    // Budget for the header + the full kept-context tier, with strictly less
    // left over than the cheapest overflow line — guarantees lines 0-2 survive
    // and line 3 onward fully collapses (no partial tier fit either way).
    const maxChars = cost(header) + kept.reduce((sum, l) => sum + cost(l), 0) + Math.min(...overflow.map(cost)) - 1;
    const out = compressGit(raw, { maxChars, minHeadLines: 0, minTailLines: 0 });
    expect(out).toContain("unchanged context line 0");
    expect(out).toContain("unchanged context line 1");
    expect(out).toContain("unchanged context line 2");
    expect(out).not.toContain("unchanged context line 3");
    expect(out).toContain("diff lines collapsed");
  });

  it("test-output: keeps Jest's '●' failing-test bullet and vitest's '❯' location marker regardless of budget", () => {
    const noise = Array.from({ length: 200 }, (_, i) => `✓ passing test ${i}`).join("\n");
    const raw = [noise, "  ● Calculator › add › adds two numbers", "  ❯ src/foo.test.ts:10:20", noise].join("\n");
    const out = compressTestOutput(raw, { maxChars: 50, minHeadLines: 0, minTailLines: 0 });
    expect(out).toContain("● Calculator › add › adds two numbers");
    expect(out).toContain("❯ src/foo.test.ts:10:20");
  });

  it("build-output: keeps an eslint-style 'line:col  error  message' line regardless of budget (no TS/[Ennnn] code for the universal rule to anchor on)", () => {
    const noise = Array.from({ length: 200 }, (_, i) => `${i}% compiling`).join("\n");
    const raw = [noise, "  12:5  error  'foo' is not defined  no-undef", noise].join("\n");
    const out = compressBuildOutput(raw, { maxChars: 50, minHeadLines: 0, minTailLines: 0 });
    expect(out).toContain("12:5  error  'foo' is not defined  no-undef");
  });
});
