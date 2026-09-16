/**
 * Question tiers + answer key (design §3.7). `expected` is computed by the
 * generator from the seed — NEVER re-derived by an LLM (grade.ts and this file
 * import no model client; that absence is a verification gate). Tier 1 is an
 * integer count, not "which label is rarest", to avoid the 1/6 guess floor and
 * label ties (C8).
 */
import { strict as assert } from "node:assert";
import { LABELS, isoDate, mulberry32, type Doc, type Label, type Row } from "./gen-table.js";

export type Tier = "count" | "filter-count" | "temporal";

export interface Question {
  qid: string; // "count.0"
  tier: Tier;
  prompt: string;
  expected: string;
}

export interface AnswerKey {
  seed: number;
  scale: number;
  noise: number;
  tableFingerprint: string;
  modelId: null; // the key is model-free by construction
  questions: Question[];
}

function countLabel(rows: Row[], label: Label): number {
  return rows.filter((r) => r.label === label).length;
}

function countWindow(rows: Row[], label: Label, start: string, end: string): number {
  return rows.filter((r) => r.label === label && r.date >= start && r.date < end).length;
}

/** Users whose earliest row is strictly unique by date — the only well-posed temporal subjects. */
function temporalCandidates(rows: Row[]): Array<{ user: string; label: Label }> {
  const byUser = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byUser.get(r.user);
    if (list === undefined) byUser.set(r.user, [r]);
    else list.push(r);
  }
  const out: Array<{ user: string; label: Label }> = [];
  for (const [user, list] of [...byUser.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const minDate = list.reduce((m, r) => (r.date < m ? r.date : m), list[0].date);
    const atMin = list.filter((r) => r.date === minDate);
    if (atMin.length === 1) out.push({ user, label: atMin[0].label });
  }
  return out;
}

export function genQuestions(doc: Doc, seed: number, scale: number, noise: number, qpt: number): AnswerKey {
  assert(Number.isInteger(qpt) && qpt > 0, "genQuestions: qpt (questions per tier) must be a positive integer");
  const rand = mulberry32(seed ^ 0x5bd1e995); // question stream decoupled from row stream
  const questions: Question[] = [];

  for (let i = 0; i < qpt; i++) {
    const label = LABELS[Math.floor(rand() * LABELS.length)];
    questions.push({
      qid: `count.${i}`,
      tier: "count",
      prompt: `How many rows have label = ${label}?`,
      expected: String(countLabel(doc.rows, label)),
    });
  }

  for (let i = 0; i < qpt; i++) {
    const label = LABELS[Math.floor(rand() * LABELS.length)];
    const startDay = Math.floor(rand() * 150); // window always inside the 180-day span
    const start = isoDate(startDay);
    const end = isoDate(startDay + 30);
    questions.push({
      qid: `filter-count.${i}`,
      tier: "filter-count",
      prompt: `How many rows have a date on or after ${start} and before ${end} and label = ${label}?`,
      expected: String(countWindow(doc.rows, label, start, end)),
    });
  }

  const candidates = temporalCandidates(doc.rows);
  assert(
    candidates.length >= qpt,
    `genQuestions: only ${candidates.length} users have a unique earliest row at scale ${scale} — temporal tier needs ${qpt}; raise scale or lower qpt`,
  );
  for (let i = 0; i < qpt; i++) {
    const c = candidates[Math.floor(rand() * candidates.length)];
    questions.push({
      qid: `temporal.${i}`,
      tier: "temporal",
      prompt: `What is the label of the earliest row for user ${c.user}? (Exactly one row holds that user's earliest date.)`,
      expected: c.label,
    });
  }

  return { seed, scale, noise, tableFingerprint: doc.fingerprint, modelId: null, questions };
}
