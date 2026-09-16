import { describe, expect, it } from "vitest";
import { genDoc, type Row } from "../gen-table.js";
import { genQuestions } from "../questions.js";

// Independent brute-force recount — deliberately written as plain loops, a
// separate code path from questions.ts's filter/reduce derivations, so a
// shared bug can't validate itself (§8: "expected recomputed by an independent
// brute-force recount matches the committed key").
function bruteForce(rows: Row[], prompt: string): string {
  let m = /^How many rows have label = (\w+)\?$/.exec(prompt);
  if (m !== null) {
    let n = 0;
    for (const r of rows) if (r.label === m[1]) n++;
    return String(n);
  }
  m = /^How many rows have a date on or after (\S+) and before (\S+) and label = (\w+)\?$/.exec(prompt);
  if (m !== null) {
    let n = 0;
    for (const r of rows) if (r.date >= m[1] && r.date < m[2] && r.label === m[3]) n++;
    return String(n);
  }
  m = /^What is the label of the earliest row for user (\w+)\?/.exec(prompt);
  if (m !== null) {
    let earliest: Row | null = null;
    for (const r of rows) {
      if (r.user !== m[1]) continue;
      if (earliest === null || r.date < earliest.date) earliest = r;
    }
    if (earliest === null) throw new Error(`brute force: user ${m[1]} not in rows — question generator is broken`);
    return earliest.label;
  }
  throw new Error(`brute force: unrecognized prompt shape: ${prompt}`);
}

describe("questions / answer key", () => {
  it("every expected matches an independent brute-force recount of the generated rows", () => {
    const doc = genDoc(24029, 400, 8);
    const key = genQuestions(doc, 24029, 400, 8, 5);
    expect(key.questions).toHaveLength(15);
    for (const q of key.questions) {
      expect(bruteForce(doc.rows, q.prompt), q.qid).toBe(q.expected);
    }
  });

  it("the key is deterministic and stamps its provenance", () => {
    const doc = genDoc(24029, 200, 8);
    const a = genQuestions(doc, 24029, 200, 8, 5);
    const b = genQuestions(doc, 24029, 200, 8, 5);
    expect(a).toEqual(b);
    expect(a.tableFingerprint).toBe(doc.fingerprint);
    expect(a.modelId).toBeNull(); // the key is model-free by construction
  });

  it("temporal questions are only posed about users with a strictly unique earliest row", () => {
    const doc = genDoc(24029, 300, 0);
    const key = genQuestions(doc, 24029, 300, 0, 5);
    for (const q of key.questions.filter((q) => q.tier === "temporal")) {
      const user = /user (\w+)\?/.exec(q.prompt)![1];
      const dates = doc.rows.filter((r) => r.user === user).map((r) => r.date).sort();
      expect(dates.filter((d) => d === dates[0])).toHaveLength(1);
    }
  });
});
