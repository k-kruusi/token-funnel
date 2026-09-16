import type { CategoryProfile } from "../types.js";

const SNIFF_ANCHORS = [/\bPASS\b/g, /\bFAIL\b/g, /✓/g, /✗/g, /Tests:/g, /test suite/gi, /describe\(/g];

function sniff(sample: string): number {
  let matches = 0;
  for (const re of SNIFF_ANCHORS) matches += (sample.match(re) ?? []).length;
  return Math.min(1, matches / 5);
}

/**
 * Passing runs are dominated by ✓/PASS-prefixed lines — one per test, offering
 * near-zero marginal information once the suite is known to be green. Those
 * collapse to "boilerplate" while suite summaries (Tests:, Test Files, Time:)
 * stay as "signal" — the durable takeaway of a test run even when every
 * individual assertion is dropped.
 */
export const TEST_OUTPUT_PROFILE: CategoryProfile = {
  name: "test-output",
  rules: [
    // Jest failing-test bullet ("● Calculator › add › adds two numbers") and
    // vitest's failure-location marker ("❯ src/foo.test.ts:10:20") both name
    // exactly which assertion failed and where — the universal FAIL/AssertionError
    // rules already keep the file-level summary, but without these two, the
    // per-test detail underneath it can still be dropped under budget pressure.
    { tag: "keep_always", test: (l) => /^\s*●\s/.test(l) },
    { tag: "keep_always", test: (l) => /^\s*❯\s+\S+:\d+:\d+/.test(l) },
    { tag: "signal", test: (l) => /^\s*(Tests:|Tests\s|Test Suites:|Test Files|Duration|Start at|Snapshots:|Time:)/.test(l) },
    { tag: "signal", test: (l) => /^\s*(describe|it|test)\(/.test(l) },
    { tag: "boilerplate", test: (l) => /^\s*(✓|✔)\s/.test(l) || /^\s*PASS\b/.test(l) },
  ],
  defaultBudget: 50_000,
  defaultMinHeadLines: 3,
  defaultMinTailLines: 30,
  sniff,
  placeholders: {
    boilerplate: (n) => `⋯ ${n} passing tests collapsed ⋯`,
    redundant: (n) => `⋯ (repeated ${n} times) ⋯`,
    progress: (n) => `⋯ progress output suppressed ⋯`,
  },
};
