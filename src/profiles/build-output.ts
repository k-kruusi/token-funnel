import type { CategoryProfile } from "../types.js";

const SNIFF_ANCHORS = [/error TS/g, /ERROR in/g, /Module not found/g, /\bBuild\b/g, /warning:/gi];

function sniff(sample: string): number {
  let matches = 0;
  for (const re of SNIFF_ANCHORS) matches += (sample.match(re) ?? []).length;
  return Math.min(1, matches / 5);
}

/**
 * Warnings are non-fatal but worth keeping (they're often the actual thing a
 * caller needs to act on); progress spinners and percentage-compiling lines
 * are pure noise. Repeated identical warnings collapse for free via the
 * engine's consecutive-duplicate fold — no rule needed for that case.
 */
export const BUILD_OUTPUT_PROFILE: CategoryProfile = {
  name: "build-output",
  rules: [
    // eslint's default "stylish" formatter has no "TS"/"[Ennnn]" code for the
    // universal keep_always regex to latch onto — just the bare word "error"
    // after a "line:col" prefix ("  12:5  error  'foo' is not defined  no-undef").
    // Without this, eslint errors have no rule marking them keep_always at all.
    { tag: "keep_always", test: (l) => /^\s*\d+:\d+\s+error\b/.test(l) },
    { tag: "signal", test: (l) => /(^|\s)warning[:\s]/i.test(l) },
    { tag: "boilerplate", test: (l) => /^\s*\d{1,3}%\s+(compiling|building|emitting|sealing|hashing)/i.test(l) },
    { tag: "boilerplate", test: (l) => /^\s*[\|\/\-\\]\s*(compiling|building|waiting)/i.test(l) },
  ],
  defaultBudget: 50_000,
  defaultMinHeadLines: 3,
  defaultMinTailLines: 20,
  sniff,
  placeholders: {
    boilerplate: (n) => `⋯ ${n} build output lines collapsed ⋯`,
  },
};
