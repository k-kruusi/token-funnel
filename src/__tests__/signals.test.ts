import { describe, it, expect } from "vitest";
import { UNIVERSAL_KEEP_ALWAYS } from "../internal/signals.js";

function matches(line: string): boolean {
  const state = { index: 0, totalLines: 1, counters: {} };
  return UNIVERSAL_KEEP_ALWAYS.some((rule) => rule.test(line, state));
}

describe("UNIVERSAL_KEEP_ALWAYS", () => {
  it.each([
    "FAIL src/foo.test.ts",
    "FAILED: something broke",
    "  AssertionError: expected 1 to equal 2",
    "Error: connection refused",
    "    at Object.<anonymous> (/src/foo.ts:12:5)",
    "Traceback (most recent call last):",
    "error TS2345: argument of type X",
    "error[E0308]: mismatched types",
    "[exit code: 1]",
    "[process killed / timed out]",
    "  × should reject invalid input",
    "  ✗ should reject invalid input",
    "  ✖ should reject invalid input",
    "ERROR: build failed",
    "FATAL: out of memory",
  ])("matches %j", (line) => {
    expect(matches(line)).toBe(true);
  });

  it.each([
    "PASS src/foo.test.ts",
    "  ✓ should accept valid input",
    "Running 40 tests...",
    "index abc123..def456 100644",
    "webpack 45% compiling",
    "this line mentions error handling in prose",
    "at the store, buy milk",
  ])("does not false-positive on %j", (line) => {
    expect(matches(line)).toBe(false);
  });
});
