import type { CategoryProfile } from "../types.js";

const SNIFF_ANCHORS = [/^[^\s:][^\n:]*:\d+:/gm];

function sniff(sample: string): number {
  let matches = 0;
  for (const re of SNIFF_ANCHORS) matches += (sample.match(re) ?? []).length;
  return Math.min(1, matches / 5);
}

const MATCH_LINE_RE = /^([^\n]+?):(\d+):/;
const MAX_PER_FILE = 20;

/**
 * ripgrep's --line-number/--no-heading output is "path:line:content" with no
 * per-file grouping — the per-file cap counter below is what lets us tell
 * "first 20 hits in this file" from "the 21st", entirely from the flat
 * stream, without a pre-pass to group by path first.
 */
export const GREP_PROFILE: CategoryProfile = {
  name: "grep",
  rules: [
    {
      tag: "signal",
      test: (l, state) => {
        const m = MATCH_LINE_RE.exec(l);
        if (!m) return false;
        const key = `grep:${m[1]}`;
        state.counters[key] = (state.counters[key] ?? 0) + 1;
        return state.counters[key] <= MAX_PER_FILE;
      },
    },
    {
      tag: "boilerplate",
      test: (l, state) => {
        const m = MATCH_LINE_RE.exec(l);
        if (!m) return false;
        return (state.counters[`grep:${m[1]}`] ?? 0) > MAX_PER_FILE;
      },
    },
    { tag: "context", test: (l) => /^--$/.test(l) },
  ],
  defaultBudget: 50_000,
  defaultMinHeadLines: 3,
  defaultMinTailLines: 5,
  sniff,
  placeholders: {
    boilerplate: (n) => `⋯ ${n} additional matches collapsed ⋯`,
  },
};
