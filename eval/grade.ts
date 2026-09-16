/**
 * Deterministic grader (design §5): normalize the agent's `ANSWER: <value>`
 * line, exact-match against the seed-derived key. Tri-state graderState;
 * gaveUp = no parseable ANSWER line. NO LLM anywhere in this path — that
 * absence is a §8 verification gate (this module imports no model client).
 */
export type GraderState = "answered-correct" | "answered-wrong" | "gaveUp";

const ANSWER_RE = /^ANSWER:\s*(.+?)\s*$/gm;

/** The LAST ANSWER: line wins — a model may think aloud before committing. */
export function extractAnswer(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(ANSWER_RE)) last = m[1];
  return last;
}

export function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase().replace(/\.+$/, "").replace(/\s+/g, " ");
}

export function grade(text: string, expected: string): GraderState {
  const answer = extractAnswer(text);
  if (answer === null) return "gaveUp";
  return normalizeAnswer(answer) === normalizeAnswer(expected) ? "answered-correct" : "answered-wrong";
}
