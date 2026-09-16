import { describe, expect, it } from "vitest";
import { CcrBudgetExhaustedError, makeCcrRetriever } from "../ccr-tool.js";

const STASH = [
  { marker: "<<ccr:aaaa>>", content: "chunk-A ".repeat(10).trim() }, // 79 chars
  { marker: "<<ccr:bbbb>>", content: "chunk-B ".repeat(10).trim() },
];

describe("ccr-tool", () => {
  it("resolves marker → exact stashed content and counts the retrieval", () => {
    const r = makeCcrRetriever(STASH, 1000);
    expect(r.retrieve("<<ccr:aaaa>>")).toBe(STASH[0].content);
    expect(r.retrievals()).toBe(1);
    expect(r.spent()).toBe(STASH[0].content.length);
  });

  it("unknown marker is a clear, actionable error — never empty success", () => {
    const r = makeCcrRetriever(STASH, 1000);
    expect(() => r.retrieve("<<ccr:nope>>")).toThrow(/unknown marker/);
    expect(() => r.retrieve("<<ccr:nope>>")).toThrow(/copied verbatim/);
    expect(r.retrievals()).toBe(0);
  });

  it("budget exhaustion throws the clear CcrBudgetExhaustedError and stops delivery", () => {
    const r = makeCcrRetriever(STASH, 100); // enough for one chunk, not two
    r.retrieve("<<ccr:aaaa>>");
    let caught: unknown;
    try {
      r.retrieve("<<ccr:bbbb>>");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CcrBudgetExhaustedError);
    expect((caught as Error).message).toMatch(/retrieval budget exhausted/);
    expect((caught as Error).message).toMatch(/answer from what you already have/);
    expect(r.retrievals()).toBe(1); // the refused retrieval is not counted as delivered
  });

  it("re-retrieving the same marker is charged again (budget prices delivered chars)", () => {
    const r = makeCcrRetriever(STASH, 1000);
    r.retrieve("<<ccr:aaaa>>");
    r.retrieve("<<ccr:aaaa>>");
    expect(r.spent()).toBe(STASH[0].content.length * 2);
  });

  it("a zero budget is a loud misconfiguration", () => {
    expect(() => makeCcrRetriever(STASH, 0)).toThrow(/retrieval-budget/);
  });
});
