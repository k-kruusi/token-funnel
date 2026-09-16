import { describe, it, expect, vi } from "vitest";
import { funnel } from "../router.js";
import { stripAnsi } from "../internal/lines.js";

// funnel()'s contract is that it never throws: a failure inside a profile's
// rules (or the engine itself) falls back to the generic profile, and a
// failure there falls back to a plain ANSI-stripped truncation (see engine.ts
// and router.ts). None of the real, committed profiles actually throw on any
// valid string input — they're written defensively on purpose — so the only
// way to exercise that fallback chain is to inject a failure. splitLines() is
// called unconditionally by every profile attempt (the git-profile try AND
// the generic-profile retry both go through it), so mocking it to throw
// forces both catches and lands on the innermost emergency fallback.
vi.mock("../internal/lines.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../internal/lines.js")>();
  return {
    ...actual,
    splitLines: () => {
      throw new Error("simulated engine failure");
    },
  };
});

describe("funnel(): exception fallback chain", () => {
  it("falls back to a plain ANSI-stripped result when every profile-level attempt throws", () => {
    const raw = "line one\nline two\nline three";
    expect(funnel(raw, "git")).toBe(stripAnsi(raw));
  });

  it("never throws even when every profile-level attempt fails", () => {
    expect(() => funnel("anything", "test-output")).not.toThrow();
    expect(() => funnel("", "generic")).not.toThrow();
  });

  it("still applies the emergency-cap marker when the stripped fallback exceeds it", () => {
    const raw = "x".repeat(1000);
    const out = funnel(raw, "generic", { emergencyCap: 100 });
    expect(out).toContain("[token-funnel: emergency fallback,");
    expect(out.length).toBeLessThan(1000);
  });
});
