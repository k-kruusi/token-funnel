import { describe, it, expect } from "vitest";
import { funnel } from "../index.js";

// The engine is documented as O(n) — bucket-by-tag plus one pass per priority
// tier, no sorting (see internal/budget.ts). These assert that property holds
// under adversarial-sized input rather than pinning to a specific millisecond
// figure: the thresholds are generous multiples of measured local runtime, so
// they catch an accidental O(n^2) regression (which blows up to seconds) without
// being flaky on a loaded CI box.
describe("benchmark: adversarial input sizes stay fast", () => {
  it("5MB of repeated log lines compresses in well under a second", () => {
    const line = "this is a repeated log line with some content in it";
    const repeated = Array(Math.ceil((5 * 1024 * 1024) / line.length)).fill(line).join("\n");
    const start = Date.now();
    funnel(repeated, "generic");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("5MB of unique keep_always lines hits the emergency cap but still stays fast", () => {
    const uniqueErrors = Array.from(
      { length: Math.ceil((5 * 1024 * 1024) / 40) },
      (_, i) => `Error: unique failure number ${i}`,
    ).join("\n");
    const start = Date.now();
    const out = funnel(uniqueErrors, "generic", { maxChars: 1000 });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toContain("[token-funnel: truncated at emergency cap");
  });

  it("1MB of near-backtracking input ('error ' repeated) has no catastrophic regex blowup", () => {
    const backtrackish = "error ".repeat((1024 * 1024) / 6);
    const start = Date.now();
    funnel(backtrackish, "generic");
    expect(Date.now() - start).toBeLessThan(500);
  });
});
