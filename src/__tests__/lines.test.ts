import { describe, it, expect } from "vitest";
import { stripAnsi, collapseCarriageReturn, splitLines } from "../internal/lines.js";

describe("stripAnsi", () => {
  it("removes color codes", () => {
    expect(stripAnsi("[32mPASS[0m")).toBe("PASS");
  });

  it("removes cursor movement sequences", () => {
    expect(stripAnsi("[2K[1Gloading...")).toBe("loading...");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
  });
});

describe("collapseCarriageReturn", () => {
  it("normalizes CRLF without eating content", () => {
    expect(collapseCarriageReturn("foo\r\nbar\r\n")).toBe("foo\nbar\n");
  });

  it("collapses a \\r progress overwrite to the last segment", () => {
    expect(collapseCarriageReturn("10%\r50%\r100% done\n")).toBe("100% done\n");
  });

  it("keeps a bare trailing \\r's content when nothing overwrote it", () => {
    expect(collapseCarriageReturn("abc\r")).toBe("abc");
  });

  it("leaves lines with no \\r untouched", () => {
    expect(collapseCarriageReturn("line one\nline two")).toBe("line one\nline two");
  });
});

describe("splitLines", () => {
  it("splits on newline after collapsing \\r and stripping ANSI", () => {
    expect(splitLines("a\nb\rc\n[31mred[0m")).toEqual(["a", "c", "red"]);
  });

  it("caps an individual line's length", () => {
    const huge = "x".repeat(20_000);
    const [line] = splitLines(huge);
    expect(line.length).toBeLessThan(huge.length);
    expect(line).toContain("[line truncated, 20000 chars total]");
  });

  it("does not truncate lines under the cap", () => {
    const line = "y".repeat(9000);
    expect(splitLines(line)[0]).toBe(line);
  });
});
