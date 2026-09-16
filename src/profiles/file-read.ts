import type { CategoryProfile } from "../types.js";

const SNIFF_ANCHORS = [/^\s*\d+ │ /gm];

function sniff(sample: string): number {
  let matches = 0;
  for (const re of SNIFF_ANCHORS) matches += (sample.match(re) ?? []).length;
  return Math.min(1, matches / 5);
}

// Matches read.ts's `${String(lineNum).padStart(6)} │ ${content}` gutter.
const GUTTER_RE = /^\s*(\d+) │ (.*)$/;

interface GutterLine {
  num: number | null;
  content: string;
}

function parseGutterLines(raw: string): GutterLine[] {
  return raw.split("\n").map((line) => {
    const m = GUTTER_RE.exec(line);
    if (!m) return { num: null, content: line };
    return { num: Number(m[1]), content: m[2] };
  });
}

function formatGutter(num: number, content: string): string {
  return `${String(num).padStart(6)} │ ${content}`;
}

function indexOfContent(lines: GutterLine[], content: string, from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].content === content) return i;
  }
  return -1;
}

// Matches every placeholder shape the engine can emit for this profile: the
// generic "⋯ … ⋯"-wrapped forms (context/boilerplate/progress/keep_always all
// fall back to GENERIC_PROFILE's templates when file-read doesn't define its
// own) and this profile's own bare "(repeated N times)" redundant placeholder.
// Mirrors engine.ts's ALREADY_COMPRESSED_RE — same idea, same reason: a line
// that doesn't match at the cursor is only a placeholder if it structurally
// looks like one. Otherwise it's real, surviving content that a *silently
// omitted* single dropped line (reconstruct() emits no placeholder for those —
// see budget.test.ts) has merely knocked out of lockstep with `original`.
const PLACEHOLDER_RE = /^⋯.*⋯$|^\(repeated \d+ times\)$/;

/**
 * Strip the line-number gutter before classification/dedup so two identical
 * lines of code at different offsets fold together — the gutter's line
 * number would otherwise make every line look unique even when the content
 * repeats verbatim (a common case: blank-line runs, repeated boilerplate).
 */
function preprocess(raw: string): string {
  return parseGutterLines(raw).map((l) => l.content).join("\n");
}

/**
 * Re-attach gutters to surviving lines by walking `text` and the original
 * numbered `raw` in lockstep. A line matching the original content at the
 * cursor is a survivor — reuse its original number.
 *
 * Anything else falls into one of two cases, and they must NOT be handled the
 * same way: a line that structurally looks like an engine-emitted placeholder
 * (PLACEHOLDER_RE) really did collapse a run, so look ahead for where
 * numbering resumes and render a "start-end │ placeholder" range gutter. A
 * line that DOESN'T look like a placeholder is real, surviving content —
 * reconstruct() silently omits a single dropped record with no placeholder at
 * all (see budget.test.ts), so the cursor just needs to skip forward past that
 * gap to find this line's true original number, never a fabricated range.
 */
function postprocess(text: string, raw: string): string {
  const original = parseGutterLines(raw);
  const outLines = text.split("\n");
  const result: string[] = [];
  let cursor = 0;

  for (let oi = 0; oi < outLines.length; oi++) {
    const outLine = outLines[oi];

    if (cursor < original.length && original[cursor].content === outLine) {
      const o = original[cursor];
      result.push(o.num !== null ? formatGutter(o.num, o.content) : o.content);
      cursor++;
      continue;
    }

    if (!PLACEHOLDER_RE.test(outLine)) {
      // Real content, just out of lockstep because of a silently-omitted gap —
      // find its true position rather than guessing a placeholder range.
      const idx = indexOfContent(original, outLine, cursor);
      if (idx !== -1) {
        const o = original[idx];
        result.push(o.num !== null ? formatGutter(o.num, o.content) : o.content);
        cursor = idx + 1;
      } else {
        // Not found at all (shouldn't happen for well-formed input) — never
        // fabricate a gutter for content we can't actually locate.
        result.push(outLine);
      }
      continue;
    }

    let end = original.length;
    for (let look = oi + 1; look < outLines.length; look++) {
      const idx = indexOfContent(original, outLines[look], cursor);
      if (idx !== -1) {
        end = idx;
        break;
      }
    }

    const start = original[cursor];
    const last = original[Math.max(cursor, end - 1)];
    if (start?.num != null && last?.num != null) {
      result.push(`${String(start.num).padStart(6)}-${last.num} │ ${outLine}`);
    } else {
      result.push(outLine);
    }
    cursor = Math.max(end, cursor + 1);
  }

  return result.join("\n");
}

export const FILE_READ_PROFILE: CategoryProfile = {
  name: "file-read",
  rules: [
    { tag: "signal", test: (l) => /\b(error|exception|fail(ed|ure)?)\b/i.test(l) },
  ],
  defaultBudget: 50_000,
  defaultMinHeadLines: 10,
  defaultMinTailLines: 10,
  sniff,
  placeholders: {
    redundant: (n) => `(repeated ${n} times)`,
  },
  preprocess,
  postprocess,
};
