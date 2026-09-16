import type { CategoryProfile, ClassificationRule, FunnelOptions, LineRecord, LineTag, ReversibleResult, ScanState } from "./types.js";
import { DEFAULT_MAX_CHARS } from "./types.js";
import { splitLines } from "./internal/lines.js";
import { UNIVERSAL_KEEP_ALWAYS } from "./internal/signals.js";
import { allocateBudget, reconstruct, reconstructReversible } from "./internal/budget.js";

// Tags the engine widens to "context" when the caller has flagged the output as
// a known failure (FunnelOptions.isError === true) — see classifyLine below.
const WIDENED_ON_ERROR: ReadonlySet<LineTag> = new Set(["boilerplate", "progress"]);

function classifyLine(
  line: string,
  state: ScanState,
  rules: ClassificationRule[],
  widenOnError: boolean,
): LineTag {
  for (const rule of rules) {
    if (rule.test(line, state)) {
      return widenOnError && WIDENED_ON_ERROR.has(rule.tag) ? "context" : rule.tag;
    }
  }
  return "context";
}

/**
 * Fold each maximal run of consecutive, identical lines into a single record
 * tagged "redundant" carrying the run's length — the record that survives
 * downstream always renders as "(repeated N times)" regardless of budget
 * outcome (see internal/budget.ts reconstruct). A run of length 1 keeps its
 * original tag untouched; only actual duplication becomes "redundant".
 *
 * keep_always runs are never folded: collapsing repeated failure text into a
 * bare "(repeated N times)" count would erase the literal error content the
 * Honest Response Principle requires — a never-drop guarantee has to mean the
 * text survives, not just a tally of how many times it appeared.
 */
function foldConsecutiveDuplicates(lines: string[], tags: LineTag[]): LineRecord[] {
  const out: LineRecord[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (tags[i] === "keep_always") {
      out.push({ line: lines[i], tag: "keep_always", repeats: 1 });
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && lines[j] === lines[i] && tags[j] === tags[i]) j++;
    const runLength = j - i;
    if (runLength > 1) {
      out.push({ line: lines[i], tag: "redundant", repeats: runLength });
    } else {
      out.push({ line: lines[i], tag: tags[i], repeats: 1 });
    }
    i = j;
  }
  return out;
}

// How far past a keep_always line to look for the next non-blank line to also
// protect. Bounded so a pathological run of blank lines can't turn this into
// an O(n²) scan — 5 is enough to skip the blank-line separator most compilers
// (tsc, rustc) put between an error header and its source snippet.
const CONTEXT_CAPTURE_LOOKAHEAD = 5;

/**
 * A classification rule can tag the error line itself, but it can't reach
 * forward to protect the line that explains it (the source snippet under a
 * tsc/rustc error, the payload under an AssertionError) — first-match-wins
 * classification only ever sees one line at a time. This post-pass promotes
 * the next non-blank line after every keep_always line to keep_always too,
 * so "the error never gets dropped" also means "neither does its context."
 */
function captureTrailingContext(lines: string[], tags: LineTag[]): void {
  // Snapshot which lines were keep_always BEFORE any widening — otherwise a
  // just-widened line would itself act as a new source on the next iteration,
  // cascading across a dense run of failures instead of capturing one line.
  const sources = tags.map((t) => t === "keep_always");
  for (let i = 0; i < tags.length; i++) {
    if (!sources[i]) continue;
    for (let j = i + 1, scanned = 0; j < tags.length && scanned < CONTEXT_CAPTURE_LOOKAHEAD; j++, scanned++) {
      if (lines[j].trim() === "") continue;
      tags[j] = "keep_always";
      break;
    }
  }
}

// Recognizes a line the engine itself produced on a prior pass: the "⋯ … ⋯"
// wrapped placeholders every profile uses, file-read's bare/gutter-ranged
// "(repeated N times)", and the trailing "[token-funnel: ...]" budget markers.
const ALREADY_COMPRESSED_RE = /^⋯.*⋯$|\(repeated \d+ times\)$|^\[token-funnel:/;

/**
 * Protect lines that are themselves the OUTPUT of a previous compression pass
 * (a caller re-running funnel() on already-funneled content — bash.ts's output
 * reaching traffic-mirror, say). Without this, several adjacent placeholders
 * from pass one all default to plain "context" on pass two, and a tight
 * enough budget bundles them into a single new placeholder that summarizes
 * OTHER summaries — a nested placeholder that both violates the "no more than
 * 10% shorter" idempotency guarantee and throws away the original per-region
 * counts. Promoting them to "signal" keeps each one intact and keeps it from
 * ever being grouped with unrelated neighboring content.
 */
function protectAlreadyCompressedMarkers(lines: string[], tags: LineTag[]): void {
  for (let i = 0; i < lines.length; i++) {
    if (tags[i] === "keep_always") continue;
    if (ALREADY_COMPRESSED_RE.test(lines[i])) tags[i] = "signal";
  }
}

/**
 * The single compression engine every compressX()/funnel() call runs through.
 * Category-specific behavior comes entirely from `profile` — the pipeline
 * itself never branches on category name.
 */
export function runEngine(raw: string, profile: CategoryProfile, opts: FunnelOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const emergencyCap = opts.emergencyCap ?? maxChars * 4;
  const minHeadLines = opts.minHeadLines ?? profile.defaultMinHeadLines;
  const minTailLines = opts.minTailLines ?? profile.defaultMinTailLines;
  const widenOnError = opts.isError === true;

  const preprocessed = profile.preprocess ? profile.preprocess(raw) : raw;
  const lines = splitLines(preprocessed);

  const rules: ClassificationRule[] = [...UNIVERSAL_KEEP_ALWAYS, ...profile.rules];
  const state: ScanState = { index: 0, totalLines: lines.length, counters: {} };
  const tags: LineTag[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    state.index = i;
    tags[i] = classifyLine(lines[i], state, rules, widenOnError);
  }
  protectAlreadyCompressedMarkers(lines, tags);
  captureTrailingContext(lines, tags);

  const records = foldConsecutiveDuplicates(lines, tags);
  const { kept, markers } = allocateBudget(records, maxChars, emergencyCap, minHeadLines, minTailLines, profile);
  const text = reconstruct(records, kept, profile, markers);

  return profile.postprocess ? profile.postprocess(text, raw) : text;
}

/**
 * Reversible variant of runEngine: identical compression pipeline, but multi-line
 * dropped runs are replaced with <<ccr:HASH>> markers instead of generic
 * placeholders. Returns the text alongside the stashed chunks so callers can
 * persist them. postprocess is applied to text only (CCR markers survive it —
 * they reference content from the preprocessed stage, before framing is re-added).
 */
export function runEngineReversible(raw: string, profile: CategoryProfile, opts: FunnelOptions = {}): ReversibleResult {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const emergencyCap = opts.emergencyCap ?? maxChars * 4;
  const minHeadLines = opts.minHeadLines ?? profile.defaultMinHeadLines;
  const minTailLines = opts.minTailLines ?? profile.defaultMinTailLines;
  const widenOnError = opts.isError === true;

  const preprocessed = profile.preprocess ? profile.preprocess(raw) : raw;
  const lines = splitLines(preprocessed);

  const rules: ClassificationRule[] = [...UNIVERSAL_KEEP_ALWAYS, ...profile.rules];
  const state: ScanState = { index: 0, totalLines: lines.length, counters: {} };
  const tags: LineTag[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    state.index = i;
    tags[i] = classifyLine(lines[i], state, rules, widenOnError);
  }
  protectAlreadyCompressedMarkers(lines, tags);
  captureTrailingContext(lines, tags);

  const records = foldConsecutiveDuplicates(lines, tags);
  const { kept, markers } = allocateBudget(records, maxChars, emergencyCap, minHeadLines, minTailLines, profile);
  const { text: rawText, stashed } = reconstructReversible(records, kept, profile, markers, opts.labelMarkers === true);

  const text = profile.postprocess ? profile.postprocess(rawText, raw) : rawText;
  return { text, stashed };
}
