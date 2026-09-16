import type { CategoryProfile } from "../types.js";

const SNIFF_ANCHORS = [/diff --git/g, /^@@/gm, /^--- /gm, /^\+\+\+ /gm, /^index /gm, /^new file mode/gm];

function sniff(sample: string): number {
  let matches = 0;
  for (const re of SNIFF_ANCHORS) matches += (sample.match(re) ?? []).length;
  return Math.min(1, matches / 5);
}

const FILE_HEADER_RE = /^diff --git a\/(\S+) b\/(\S+)/;
const LOCKFILE_RE = /lock|\.generated\./i;

/**
 * Everything between one "diff --git" header and the next is one file's diff.
 * Detecting the header is also where we decide, per file, whether the hunk
 * bodies that follow are a lockfile/generated diff (collapse wholesale) — the
 * header line is the only place a file boundary is unambiguous, so the
 * boilerplate rule below just reads the flag this rule sets in state.counters.
 */
export const GIT_PROFILE: CategoryProfile = {
  name: "git",
  rules: [
    {
      tag: "signal",
      test: (l, state) => {
        const m = FILE_HEADER_RE.exec(l);
        if (!m) return false;
        state.counters.isLockfileFile = LOCKFILE_RE.test(m[2] || m[1]) ? 1 : 0;
        state.counters.hunkContextCount = 0;
        return true;
      },
    },
    { tag: "signal", test: (l) => /^rename (from|to) /.test(l) },
    { tag: "signal", test: (l) => /^new file mode/.test(l) },
    { tag: "signal", test: (l) => /^deleted file mode/.test(l) },
    { tag: "signal", test: (l) => /^Binary files/.test(l) },
    {
      // Lockfile/generated diffs: collapse the whole hunk body (+, -, context,
      // and the @@/+++/--- markers), not just the unchanged-context overflow.
      tag: "boilerplate",
      test: (l, state) => state.counters.isLockfileFile === 1 && !FILE_HEADER_RE.test(l),
    },
    { tag: "boilerplate", test: (l) => /^index [0-9a-f]+\.\.[0-9a-f]+/.test(l) },
    {
      tag: "context",
      test: (l, state) => {
        if (!/^@@/.test(l)) return false;
        state.counters.hunkContextCount = 0;
        return true;
      },
    },
    {
      // First 3 unchanged (" "-prefixed) context lines per hunk stay as
      // context; anything past that is redundant surrounding-code noise.
      tag: "context",
      test: (l, state) => {
        if (!/^ /.test(l)) return false;
        state.counters.hunkContextCount = (state.counters.hunkContextCount ?? 0) + 1;
        return state.counters.hunkContextCount <= 3;
      },
    },
    {
      tag: "boilerplate",
      test: (l, state) => /^ /.test(l) && (state.counters.hunkContextCount ?? 0) > 3,
    },
  ],
  defaultBudget: 50_000,
  defaultMinHeadLines: 5,
  defaultMinTailLines: 10,
  sniff,
  placeholders: {
    boilerplate: (n) => `⋯ ${n} diff lines collapsed (lockfile/generated) ⋯`,
    context: (n) => `⋯ ${n} diff context lines collapsed ⋯`,
  },
};
