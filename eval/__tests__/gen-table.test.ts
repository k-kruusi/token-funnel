import { describe, expect, it } from "vitest";
import { genDoc, genRows, isoDate, mulberry32 } from "../gen-table.js";

describe("gen-table determinism", () => {
  it("regenerating from the same seed twice yields an identical fingerprint AND rendered bytes", () => {
    const a = genDoc(24029, 120, 4);
    const b = genDoc(24029, 120, 4);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.rendered).toBe(b.rendered);
    expect(a.rows).toEqual(b.rows);
  });

  it("a different seed yields a different table", () => {
    expect(genDoc(24029, 120, 4).fingerprint).not.toBe(genDoc(24030, 120, 4).fingerprint);
  });

  it("noise changes rendering but never the rows (decoupled streams)", () => {
    const quiet = genDoc(24029, 80, 0);
    const noisy = genDoc(24029, 80, 8);
    expect(quiet.fingerprint).toBe(noisy.fingerprint);
    expect(quiet.rows).toEqual(noisy.rows);
    expect(noisy.rendered.length).toBeGreaterThan(quiet.rendered.length * 3);
  });

  it("rendered carries the gutter format, every row, and the end sentinel", () => {
    const doc = genDoc(7, 10, 2);
    expect(doc.rendered).toMatch(/^\s+1 │ TABLE seed=7 scale=10 noise=2/);
    expect(doc.rendered).toContain("END-OF-TABLE total-rows=10");
    expect([...doc.rendered.matchAll(/ROW id=/g)]).toHaveLength(10);
    // Gutter numbers are sequential over all lines: 1 header + 10 rows + 20 noise + 1 footer.
    expect(doc.rendered.split("\n")).toHaveLength(32);
  });

  it("mulberry32 is stable and uniform-ish in [0,1)", () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    const seq1 = [r1(), r1(), r1()];
    const seq2 = [r2(), r2(), r2()];
    expect(seq1).toEqual(seq2);
    for (const v of seq1) expect(v >= 0 && v < 1).toBe(true);
  });

  it("isoDate maps day offsets onto the fixed 2026 calendar origin", () => {
    expect(isoDate(0)).toBe("2026-01-01");
    expect(isoDate(179)).toBe("2026-06-29");
  });

  it("row fields stay in their declared domains", () => {
    for (const r of genRows(99, 300)) {
      expect(r.date >= "2026-01-01" && r.date <= "2026-06-29").toBe(true);
      expect(r.user).toMatch(/^u\d{3}$/);
      expect(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]).toContain(r.label);
    }
  });
});
