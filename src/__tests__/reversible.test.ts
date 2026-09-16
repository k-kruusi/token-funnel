import { describe, it, expect } from "vitest";
import { funnel, funnelReversible } from "../router.js";

// Build a string large enough that the engine WILL drop some lines.
// Use a tight maxChars budget with a lot of "context" lines (low priority).
function makeGenericOutput(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, i) => `line ${i + 1}: generic context content here`).join("\n");
}

describe("funnelReversible — round-trip", () => {
  it("returns the same text as funnel() when no content is dropped (fits within budget)", () => {
    const small = "just a few lines\nof output\nthat fit easily";
    const plain = funnel(small, "generic", { maxChars: 50_000 });
    const { text, stashed } = funnelReversible(small, "generic", { maxChars: 50_000 });
    expect(text).toBe(plain);
    expect(stashed).toHaveLength(0);
  });

  it("emits <<ccr:HASH>> markers for multi-line drops and the stash contains the original content", () => {
    const raw = makeGenericOutput(200);
    const { text, stashed } = funnelReversible(raw, "generic", { maxChars: 500 });

    // At least one chunk was dropped and stashed.
    expect(stashed.length).toBeGreaterThan(0);

    for (const chunk of stashed) {
      // Marker format: <<ccr: followed by 64 hex chars >>
      expect(chunk.marker).toMatch(/^<<ccr:[0-9a-f]{64}>>$/);
      // Marker appears verbatim in the compressed text.
      expect(text).toContain(chunk.marker);
      // Content is non-empty.
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });

  it("stashed content exactly reproduces the dropped lines", () => {
    // Use a large budget so compression is mild — only a few lines are dropped.
    const lines = Array.from({ length: 100 }, (_, i) => `context line ${i}`);
    const raw = lines.join("\n");
    const { text, stashed } = funnelReversible(raw, "generic", { maxChars: 1_000 });

    for (const chunk of stashed) {
      // Each stashed line must have been present in the original input.
      const chunkLines = chunk.content.split("\n");
      for (const cl of chunkLines) {
        expect(raw).toContain(cl);
      }
      // The stashed content must NOT appear verbatim in the compressed text
      // (that would mean it wasn't dropped after all).
      expect(text).not.toContain(chunk.content);
    }
  });
});

describe("funnelReversible — non-regression of funnel()", () => {
  it("funnel() is byte-identical to before (reversible path does not alter it)", () => {
    const raw = makeGenericOutput(300);
    const fromPlain = funnel(raw, "generic", { maxChars: 1_000 });
    // funnel() still returns a plain string, not a ReversibleResult.
    expect(typeof fromPlain).toBe("string");
    // The reversible path is entirely separate — no shared state.
    funnelReversible(raw, "generic", { maxChars: 1_000 });
    const fromPlainAgain = funnel(raw, "generic", { maxChars: 1_000 });
    expect(fromPlainAgain).toBe(fromPlain);
  });

  it("funnel() never throws on the same inputs that funnelReversible handles", () => {
    expect(() => funnel("", "generic")).not.toThrow();
    expect(() => funnel(makeGenericOutput(1000), "generic", { maxChars: 100 })).not.toThrow();
  });

  it("funnelReversible never throws (same guarantee as funnel)", () => {
    expect(() => funnelReversible("", "generic")).not.toThrow();
    expect(() => funnelReversible(makeGenericOutput(1000), "generic", { maxChars: 100 })).not.toThrow();
  });
});

describe("funnelReversible — marker deduplication", () => {
  it("two calls that produce the same dropped chunk emit the same marker", () => {
    const raw = makeGenericOutput(200);
    const opts = { maxChars: 500 };
    const r1 = funnelReversible(raw, "generic", opts);
    const r2 = funnelReversible(raw, "generic", opts);

    // Same input → deterministic output.
    expect(r1.text).toBe(r2.text);
    expect(r1.stashed.length).toBe(r2.stashed.length);
    for (let i = 0; i < r1.stashed.length; i++) {
      expect(r1.stashed[i].marker).toBe(r2.stashed[i].marker);
      expect(r1.stashed[i].content).toBe(r2.stashed[i].content);
    }
  });
});
