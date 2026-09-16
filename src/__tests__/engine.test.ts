import { describe, it, expect } from "vitest";
import { runEngine } from "../engine.js";
import { GENERIC_PROFILE } from "../profiles/generic.js";
import { TEST_OUTPUT_PROFILE } from "../profiles/test-output.js";
import type { CategoryProfile } from "../types.js";

describe("runEngine", () => {
  it("passes short input through unchanged", () => {
    const raw = "line one\nline two\nline three";
    expect(runEngine(raw, GENERIC_PROFILE)).toBe(raw);
  });

  it("never drops a universal keep_always line regardless of budget", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `context line ${i}`);
    lines.splice(250, 0, "Error: something exploded");
    const raw = lines.join("\n");
    const out = runEngine(raw, GENERIC_PROFILE, { maxChars: 200 });
    expect(out).toContain("Error: something exploded");
  });

  it("collapses consecutive duplicate lines into a repeat count", () => {
    const raw = ["start", "dup", "dup", "dup", "end"].join("\n");
    const out = runEngine(raw, GENERIC_PROFILE);
    expect(out).toContain("(repeated 3 times)");
    expect(out.split("\n")).toEqual(["start", "⋯ (repeated 3 times) ⋯", "end"]);
  });

  it("widens boilerplate/progress to context when isError is true", () => {
    const raw = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? `✓ passing test ${i}` : `context ${i}`)).join("\n");
    const compressedNormal = runEngine(raw, TEST_OUTPUT_PROFILE, { maxChars: 40, minHeadLines: 0, minTailLines: 0 });
    const compressedError = runEngine(raw, TEST_OUTPUT_PROFILE, { maxChars: 40, minHeadLines: 0, minTailLines: 0, isError: true });
    // isError widens boilerplate to context, which competes for budget on equal
    // footing with the rest of the content instead of being collapsed first.
    expect(compressedError).not.toBe(compressedNormal);
  });

  it("calls preprocess before classification and postprocess after reconstruction", () => {
    const profile: CategoryProfile = {
      ...GENERIC_PROFILE,
      preprocess: (raw) => raw.toUpperCase(),
      postprocess: (text) => `[${text}]`,
    };
    const out = runEngine("hello", profile);
    expect(out).toBe("[HELLO]");
  });

  it("respects a profile's default min head/tail lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const profile: CategoryProfile = { ...GENERIC_PROFILE, defaultMinHeadLines: 2, defaultMinTailLines: 2 };
    const out = runEngine(lines.join("\n"), profile, { maxChars: 0 });
    expect(out).toContain("line 0");
    expect(out).toContain("line 1");
    expect(out).toContain("line 49");
    expect(out).toContain("line 48");
  });

  it("FunnelOptions head/tail overrides win over the profile defaults", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const out = runEngine(lines.join("\n"), GENERIC_PROFILE, { maxChars: 0, minHeadLines: 1, minTailLines: 1 });
    expect(out).toContain("line 0");
    expect(out).toContain("line 49");
    expect(out).not.toContain("line 25");
  });
});
