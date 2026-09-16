// Category a chunk of tool/command output has been classified as. Drives which
// CategoryProfile the engine runs — each category's noise shape is different
// (a passing test suite's boilerplate is not a clean git diff's boilerplate).
export type Category =
  | "git"
  | "test-output"
  | "build-output"
  | "grep"
  | "file-read"
  | "generic";

// Priority tag assigned to every line during classification. Budget allocation
// spends in this order (keep_always first, progress last) — see internal/budget.ts.
export type LineTag =
  | "keep_always" // errors, failures, stack frames — NEVER dropped
  | "signal" // informative lines (file paths, test names, diagnostics) — high priority
  | "context" // ordinary content — medium priority
  | "boilerplate" // known-noise structure — low priority, collapsible
  | "redundant" // consecutive duplicate lines — lowest content priority
  | "progress"; // ANSI/\r spam — dropped first

// Mutable scan context threaded through classification so stateful rules (e.g.
// grep's "first 20 matches per file") can track state across lines without a
// separate pre-pass.
export interface ScanState {
  index: number;
  totalLines: number;
  counters: Record<string, number>;
}

export interface ClassificationRule {
  tag: LineTag;
  test: (line: string, state: ScanState) => boolean;
}

export interface CategoryProfile {
  name: Category;
  rules: ClassificationRule[];
  defaultBudget: number;
  defaultMinHeadLines: number;
  defaultMinTailLines: number;
  // 0..1 confidence that `sample` belongs to this category — used by the router's
  // content-sniffing path when no hint is available.
  sniff: (sample: string) => number;
  placeholders: Partial<Record<LineTag, (count: number) => string>>;
  // Strip category-specific framing (e.g. file-read's line-number gutter) before
  // classification so it doesn't interfere with dedup/pattern matching.
  preprocess?: (raw: string) => string;
  // Re-add framing stripped by preprocess after reconstruction.
  postprocess?: (text: string, raw: string) => string;
}

export interface FunnelOptions {
  // Soft budget in characters. Default DEFAULT_MAX_CHARS.
  maxChars?: number;
  // Ground-truth failure signal from the caller. true widens what counts as
  // "context" instead of noise; false/undefined applies normal compression.
  // keep_always rules always fire regardless of this flag.
  isError?: boolean;
  minHeadLines?: number;
  minTailLines?: number;
  // Hard ceiling in characters — even keep_always content is truncated past this,
  // with an explicit marker. Default 4 * maxChars.
  emergencyCap?: number;
  // Reversible path only: describe each <<ccr:…>> marker with what it replaced
  // ("12 context lines · …"), so a model can decide WHICH span to expand instead of
  // guessing from an opaque hash. Default false — the bare format is what every
  // existing consumer parses and what eval/ measures, so labelling is opt-in.
  labelMarkers?: boolean;
}

// Internal only — never exported from index.ts.
export interface LineRecord {
  line: string;
  tag: LineTag;
  repeats: number; // 1 = unique, >1 = consecutive duplicate run (dedup, not budget)
  reason?: string; // which rule matched — debug/test visibility
}

export const DEFAULT_MAX_CHARS = 50_000;
export const SNIFF_SAMPLE_SIZE = 4096;

// A single chunk of content that was dropped by the reversible funnel path.
// marker is the <<ccr:HASH>> sentinel left in the compressed text; content is
// the exact dropped bytes (preprocessed lines joined with \n).
export interface StashedChunk {
  marker: string;
  content: string;
  // Human/model-readable description of what was dropped, present only when the
  // caller passed labelMarkers. Carried separately from `marker` (which already
  // embeds it) so a store can answer "what was this?" without re-parsing the
  // grammar, and so a retrieval tool can name the chunk it is handing back.
  label?: string;
}

export interface ReversibleResult {
  text: string;
  stashed: StashedChunk[];
}
