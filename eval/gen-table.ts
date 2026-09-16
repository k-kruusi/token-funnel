/**
 * Seeded synthetic table generator (design §3.6) — the Part-2 dataset.
 *
 * Deterministic PRNG only (mulberry32) — Math.random and Date.now are
 * forbidden in every data path. `rendered` interleaves each signal row with
 * `noise` lines of seeded log framing, in the read.ts numbered-gutter format
 * (`${String(n).padStart(6)} │ ...`) so FILE_READ_PROFILE's real
 * preprocess/postprocess path runs. The noise multiplier is the load-bearing
 * dataset decision (critiques B-1/C7): a pure table is nearly all signal and
 * the funnel honestly reports ≈0 gain; seeded noise mirrors the noisy tool
 * output the funnel actually strips. `--noise 0` is the committed honest floor.
 */
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";

export type Label = "alpha" | "beta" | "gamma" | "delta" | "epsilon" | "zeta"; // N=6, integer-count tiers (C8 fix)

export const LABELS: Label[] = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

export interface Row {
  id: number;
  date: string; // ISO date, 2026-01-01 .. 2026-06-29
  user: string; // u000..u029
  headline: string;
  label: Label;
}

export interface Doc {
  rows: Row[];
  rendered: string; // gutter-numbered, noise-interleaved — what the arms actually read
  fingerprint: string; // sha256 of rows sorted by id
}

/** The one sanctioned PRNG. Never Math.random in a data path. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a — fold arbitrary strings into a PRNG seed deterministically. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ~15% of headlines carry an error-shaped word: FILE_READ_PROFILE tags those
// lines "signal" (its /error|exception|fail/ rule), which is what breaks the
// dropped middle into MULTIPLE retrievable runs instead of one giant chunk —
// the ccr path needs plural markers to be exercisable under a per-question
// retrieval budget.
const SIGNAL_HEADLINES = [
  "deploy failed on retry",
  "error budget exceeded for shard",
  "healthcheck failure during rollout",
  "ingest job failed after timeout",
];
const PLAIN_HEADLINES = [
  "cache warmed for shard",
  "rollout completed for region",
  "index rebuilt for tenant",
  "quota resized for namespace",
  "snapshot pruned for volume",
  "session drained for upgrade",
];
const SIGNAL_HEADLINE_P = 0.15;

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1); // fixed calendar origin — data, not wall clock

export function isoDate(dayOffset: number): string {
  return new Date(EPOCH + dayOffset * DAY_MS).toISOString().slice(0, 10);
}

export function renderRow(r: Row): string {
  return `ROW id=${String(r.id).padStart(4, "0")} date=${r.date} user=${r.user} label=${r.label} headline="${r.headline}"`;
}

const GUTTER = (n: number, content: string): string => `${String(n).padStart(6)} │ ${content}`;

export function genRows(seed: number, scale: number): Row[] {
  assert(Number.isInteger(scale) && scale > 0, "genRows: scale must be a positive integer row count");
  const rand = mulberry32(seed);
  const rows: Row[] = [];
  for (let id = 0; id < scale; id++) {
    const headline =
      rand() < SIGNAL_HEADLINE_P
        ? SIGNAL_HEADLINES[Math.floor(rand() * SIGNAL_HEADLINES.length)]
        : PLAIN_HEADLINES[Math.floor(rand() * PLAIN_HEADLINES.length)];
    rows.push({
      id,
      date: isoDate(Math.floor(rand() * 180)),
      user: `u${String(Math.floor(rand() * 30)).padStart(3, "0")}`,
      headline,
      label: LABELS[Math.floor(rand() * LABELS.length)],
    });
  }
  return rows;
}

/** Seeded unique log-framing noise — unique per line so dedup can't fold it for free. */
function noiseLine(rand: () => number, i: number): string {
  const hex = Math.floor(rand() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `[trace ${hex}] worker ${Math.floor(rand() * 16)} tick ${i} queue depth ${Math.floor(rand() * 512)} lease renewed`;
}

export function genDoc(seed: number, scale: number, noise: number): Doc {
  assert(Number.isInteger(noise) && noise >= 0, "genDoc: noise is a non-negative per-row line multiplier");
  const rows = genRows(seed, scale);
  const noiseRand = mulberry32(seed ^ 0x9e3779b9); // decoupled stream: noise never perturbs row content

  const lines: string[] = [`TABLE seed=${seed} scale=${scale} noise=${noise}`];
  let i = 0;
  for (const row of rows) {
    lines.push(renderRow(row));
    for (let k = 0; k < noise; k++) lines.push(noiseLine(noiseRand, i++));
  }
  lines.push(`END-OF-TABLE total-rows=${scale}`);

  const rendered = lines.map((content, idx) => GUTTER(idx + 1, content)).join("\n");
  const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
  return { rows, rendered, fingerprint };
}
