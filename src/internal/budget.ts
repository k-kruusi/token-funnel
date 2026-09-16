import type { CategoryProfile, LineRecord, LineTag, StashedChunk } from "../types.js";
import { GENERIC_PROFILE } from "../profiles/generic.js";
import { sha256Hex } from "./hash.js";
import { mintCcrMarker } from "../ccr-marker.js";

export interface BudgetMarkers {
  softBudgetExceededChars?: number;
  emergencyTruncatedChars?: number;
}

export interface AllocationResult {
  // Parallel to the input records array — true if that record survives.
  kept: boolean[];
  markers: BudgetMarkers;
}

const TIER_ORDER: LineTag[] = ["signal", "context", "boilerplate", "redundant", "progress"];

/**
 * A "redundant" record (repeats > 1) always renders as its short placeholder —
 * see reconstruct() below, which collapses it unconditionally regardless of the
 * budget outcome. Costing it at its pre-fold line length would charge the
 * budget for text that never actually appears in the output, silently starving
 * whatever lower-priority tier (progress) comes after it in TIER_ORDER.
 */
function recordCost(r: LineRecord, profile: CategoryProfile): number {
  if (r.tag === "redundant" && r.repeats > 1) {
    return placeholderFor(profile, "redundant")(r.repeats).length + 1;
  }
  return r.line.length + 1; // + newline
}

/**
 * Decide which records survive the budget, in four O(n) passes (bucket by tag,
 * one pass per priority tier) — no sorting.
 *
 * Priority, in order: keep_always (always survives; only emergencyCap can trim
 * it) > forced head/tail minimum > signal > context > boilerplate > redundant >
 * progress. Each of the five priced tiers is trimmed from the MIDDLE when it
 * doesn't fit — i.e. we keep alternating from the tier's own head and tail —
 * which is what preserves both ends of a long run instead of always favoring
 * whichever came first (the head-only truncation bug this replaces).
 */
export function allocateBudget(
  records: LineRecord[],
  budget: number,
  emergencyCap: number,
  minHeadLines: number,
  minTailLines: number,
  profile: CategoryProfile,
): AllocationResult {
  const n = records.length;
  const kept: boolean[] = new Array(n).fill(false);
  const markers: BudgetMarkers = {};

  // 1. keep_always — always included; only the emergency cap can trim it.
  let keepAlwaysChars = 0;
  for (let i = 0; i < n; i++) {
    if (records[i].tag === "keep_always") {
      kept[i] = true;
      keepAlwaysChars += recordCost(records[i], profile);
    }
  }

  let remaining = budget - keepAlwaysChars;
  if (remaining < 0) {
    markers.softBudgetExceededChars = -remaining;
    remaining = 0;
  }

  // 2. minHeadLines / minTailLines — force-kept regardless of remaining budget
  // (they are a floor, not a request); this is what guarantees a caller always
  // sees at least the configured head/tail even on a fully-noise input.
  const headEnd = Math.min(minHeadLines, n);
  const tailStart = Math.max(n - minTailLines, headEnd);
  for (let i = 0; i < headEnd; i++) {
    if (!kept[i]) {
      kept[i] = true;
      remaining -= recordCost(records[i], profile);
    }
  }
  for (let i = tailStart; i < n; i++) {
    if (!kept[i]) {
      kept[i] = true;
      remaining -= recordCost(records[i], profile);
    }
  }
  if (remaining < 0) remaining = 0;

  // 2b. Emergency cap — the true hard ceiling. Re-checked here (not just
  // against the initial keep_always pass) because the head/tail floor above
  // can re-include a keep_always record it just decided to trim: on a short
  // input, minTailLines often covers the whole array, and without this second
  // pass the floor would silently defeat the cap. Only keep_always records are
  // in scope — the floor's own non-keep_always lines are a fixed, bounded cost
  // (minHeadLines + minTailLines), never the unbounded blowout this cap guards
  // against.
  let keepAlwaysTotal = 0;
  for (let i = 0; i < n; i++) {
    if (records[i].tag === "keep_always" && kept[i]) keepAlwaysTotal += recordCost(records[i], profile);
  }
  if (keepAlwaysTotal > emergencyCap) {
    let running = 0;
    let omitted = 0;
    for (let i = 0; i < n; i++) {
      if (records[i].tag !== "keep_always" || !kept[i]) continue;
      const c = recordCost(records[i], profile);
      if (running + c > emergencyCap) {
        kept[i] = false;
        omitted += c;
      } else {
        running += c;
      }
    }
    markers.emergencyTruncatedChars = omitted;
    markers.softBudgetExceededChars = undefined; // superseded — we're past the emergency cap, not just the soft one
  }

  // 3. Remaining budget spent in priority order, trimming each tier from the
  // middle (alternating head/tail of the TIER's own line list) if it overflows.
  for (const tag of TIER_ORDER) {
    const idxs: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!kept[i] && records[i].tag === tag) idxs.push(i);
    }
    if (idxs.length === 0) continue;

    let tierCost = 0;
    for (const i of idxs) tierCost += recordCost(records[i], profile);

    if (tierCost <= remaining) {
      for (const i of idxs) kept[i] = true;
      remaining -= tierCost;
      continue;
    }

    let lo = 0;
    let hi = idxs.length - 1;
    let fromHead = true;
    let used = 0;
    while (lo <= hi) {
      const idx = fromHead ? idxs[lo] : idxs[hi];
      const c = recordCost(records[idx], profile);
      if (used + c > remaining) break;
      kept[idx] = true;
      used += c;
      if (fromHead) lo++;
      else hi--;
      fromHead = !fromHead;
    }
    remaining -= used;
  }

  return { kept, markers };
}

function placeholderFor(
  profile: CategoryProfile,
  tag: LineTag,
): (count: number) => string {
  return (
    profile.placeholders[tag] ??
    GENERIC_PROFILE.placeholders[tag] ??
    ((count: number) => `⋯ ${count} lines omitted ⋯`)
  );
}

/**
 * Walk records in original order, emitting kept lines verbatim and collapsing
 * each maximal run of ≥2 consecutive DROPPED records sharing a tag into one
 * profile-supplied placeholder. A single dropped line is silently omitted — no
 * placeholder spam for one line. Redundant records with repeats > 1 always
 * render as the collapsed "(repeated N times)" form regardless of budget
 * outcome — that's deduplication, not budget trimming, so it applies even when
 * the record survived the budget pass untouched.
 */
export function reconstruct(
  records: LineRecord[],
  kept: boolean[],
  profile: CategoryProfile,
  markers: BudgetMarkers,
): string {
  const out: string[] = [];
  const n = records.length;
  let i = 0;

  while (i < n) {
    const r = records[i];

    // Redundant (folded-duplicate) records always collapse to the placeholder,
    // whether or not budget allocation kept them — this is dedup, not budget
    // trimming, and it must be checked BEFORE the kept/dropped branch below so
    // a kept redundant record doesn't render its raw (pre-fold) line instead.
    if (r.tag === "redundant" && r.repeats > 1) {
      out.push(placeholderFor(profile, "redundant")(r.repeats));
      i++;
      continue;
    }

    if (kept[i]) {
      out.push(r.line);
      i++;
      continue;
    }

    const tag = records[i].tag;
    let j = i;
    let runLines = 0;
    while (j < n && !kept[j] && records[j].tag === tag) {
      runLines += records[j].repeats;
      j++;
    }
    if (j - i > 1) {
      out.push(placeholderFor(profile, tag)(runLines));
    }
    // else: a single dropped record — omit silently, no placeholder spam
    i = j;
  }

  if (markers.softBudgetExceededChars) {
    out.push(
      `[token-funnel: ${markers.softBudgetExceededChars} chars of error detail exceeded soft budget]`,
    );
  }
  if (markers.emergencyTruncatedChars) {
    out.push(
      `[token-funnel: truncated at emergency cap, ${markers.emergencyTruncatedChars} chars of error detail omitted]`,
    );
  }

  return out.join("\n");
}

/**
 * Reversible variant of reconstruct: replaces multi-line dropped runs with
 * <<ccr:HASH>> markers instead of generic "⋯ N lines omitted ⋯" placeholders,
 * and returns the dropped content alongside the text so callers can stash it.
 *
 * Single-line drops are still silently omitted — same behavior as reconstruct —
 * because the noise of per-line markers outweighs their retrieval value.
 * Redundant (deduplicated) records still collapse to placeholders — those are
 * dedup, not budget-driven drops, and restoring N identical lines rarely helps.
 */
/**
 * Describe a dropped run from what the engine already knows — no LLM, no extra pass.
 *
 * The three facts a caller needs to decide whether to expand are how MUCH is behind the
 * marker, what KIND of content it was, and a peek at where it starts. All three are free
 * here: the run length, the shared LineTag, and the first dropped line. A semantic label
 * good enough to choose by does not require inference; it requires not throwing away what
 * classification already computed.
 */
function describeDroppedRun(droppedLines: string[], tag: LineTag): string {
  const kind = tag.replace(/_/g, " ");
  const count = `${droppedLines.length} ${kind} line${droppedLines.length === 1 ? "" : "s"}`;
  const first = droppedLines[0] ?? "";
  const peek = first.trim().slice(0, 48);
  return peek === "" ? count : `${count} · ${peek}`;
}

export function reconstructReversible(
  records: LineRecord[],
  kept: boolean[],
  profile: CategoryProfile,
  markers: BudgetMarkers,
  labelMarkers: boolean = false,
): { text: string; stashed: StashedChunk[] } {
  // allocateBudget guarantees kept[] is a parallel boolean array; a length
  // mismatch would silently access undefined instead of a real decision.
  if (records.length !== kept.length) {
    throw new Error(
      `reconstructReversible: records.length (${records.length}) !== kept.length (${kept.length}) — allocateBudget contract violated`,
    );
  }

  const out: string[] = [];
  const stashed: StashedChunk[] = [];
  const n = records.length;
  let i = 0;

  while (i < n) {
    const r = records[i];

    // Redundant folded-duplicate records: always collapse, same as reconstruct().
    if (r.tag === "redundant" && r.repeats > 1) {
      out.push(placeholderFor(profile, "redundant")(r.repeats));
      i++;
      continue;
    }

    if (kept[i]) {
      out.push(r.line);
      i++;
      continue;
    }

    // Dropped run: collect consecutive records sharing the same tag.
    // Non-redundant records always have repeats === 1 (foldConsecutiveDuplicates
    // only sets tag:"redundant" when runLength > 1, and those are handled above).
    const tag = records[i].tag;
    let j = i;
    const droppedLines: string[] = [];
    while (j < n && !kept[j] && records[j].tag === tag) {
      droppedLines.push(records[j].line);
      j++;
    }

    if (j - i > 1) {
      // Multi-line drop: emit a CCR recovery marker and stash the original content.
      const content = droppedLines.join("\n");
      const hash = sha256Hex(content);
      const label = labelMarkers ? describeDroppedRun(droppedLines, tag) : undefined;
      const marker = mintCcrMarker(hash, label);
      out.push(marker);
      stashed.push(label === undefined ? { marker, content } : { marker, content, label });
    }
    // Single-line drop: silently omit (matches reconstruct() behavior).

    i = j;
  }

  if (markers.softBudgetExceededChars) {
    out.push(
      `[token-funnel: ${markers.softBudgetExceededChars} chars of error detail exceeded soft budget]`,
    );
  }
  if (markers.emergencyTruncatedChars) {
    out.push(
      `[token-funnel: truncated at emergency cap, ${markers.emergencyTruncatedChars} chars of error detail omitted]`,
    );
  }

  return { text: out.join("\n"), stashed };
}
