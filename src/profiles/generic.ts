import type { CategoryProfile } from "../types.js";

// tqdm progress bar: "96%|█████████▌| 860/898 [3:18:54<08:43, 13.76s/it]"
// Unicode block fill chars cover partial-block glyphs (▏▎▍▌▋▊▉) as well as █.
const TQDM_RE = /\d{1,3}%\|[█▏▎▍▌▋▊▉ ]+\|\s*\d+\/\d+/;

/**
 * Safe fallback profile: no category-specific rules beyond the universal
 * keep_always floor (auto-prepended by the engine), so misclassified content
 * degrades compression ratio, never correctness. Heavy minTailLines (30) since
 * for unknown content the tail is more likely to carry the final, informative
 * outcome than the head is.
 */
export const GENERIC_PROFILE: CategoryProfile = {
  name: "generic",
  rules: [
    { tag: "progress", test: (l) => TQDM_RE.test(l) },
  ],
  defaultBudget: 50_000,
  defaultMinHeadLines: 5,
  defaultMinTailLines: 30,
  // Never wins the router's content-sniffing race — generic is reached only when
  // no other profile clears the confidence floor.
  sniff: () => 0,
  placeholders: {
    boilerplate: (n) => `⋯ ${n} lines collapsed ⋯`,
    redundant: (n) => `⋯ (repeated ${n} times) ⋯`,
    context: (n) => `⋯ ${n} lines omitted ⋯`,
    progress: (n) => `⋯ progress output suppressed ⋯`,
  },
};
