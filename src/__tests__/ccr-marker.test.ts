import { describe, it, expect } from "vitest";
import {
  parseCcrMarker,
  mintCcrMarker,
  sanitizeCcrLabel,
  CCR_MARKER_RE_GLOBAL,
  CCR_LABEL_MAX_CHARS,
  funnelReversible,
} from "../index.js";

describe("mint / parse round-trip", () => {
  it("mints the BARE form when no label is given — byte-identical to the pre-label format", () => {
    // Every existing consumer parses this exact string, and eval/ measures it.
    expect(mintCcrMarker("9a2f")).toBe("<<ccr:9a2f>>");
  });

  it("mints the labelled form and parses both halves back", () => {
    const m = mintCcrMarker("9a2f", "12 context lines · Hello community.");
    expect(m).toBe("<<ccr:9a2f | 12 context lines · Hello community.>>");
    expect(parseCcrMarker(m)).toEqual({ hash: "9a2f", label: "12 context lines · Hello community." });
  });

  it("parses the bare form and a naked hash, so pre-label callers keep working", () => {
    expect(parseCcrMarker("<<ccr:9a2f>>")).toEqual({ hash: "9a2f", label: undefined });
    expect(parseCcrMarker("9a2f")).toEqual({ hash: "9a2f" });
    expect(parseCcrMarker("  9a2f  ")).toEqual({ hash: "9a2f" });
  });

  it("finds the hash in a LABELLED marker even when a caller pastes surrounding text", () => {
    // The model echoes back whole lines, not tidy sentinels.
    const found = parseCcrMarker("...text <<ccr:beef | 4 boilerplate lines>> more...");
    expect(found).toEqual({ hash: "beef", label: "4 boilerplate lines" });
  });

  it("returns null for non-references instead of inventing a key", () => {
    expect(parseCcrMarker("<<ccr:zz>>")).toBeNull();
    expect(parseCcrMarker("<<ccr:>>")).toBeNull();
    expect(parseCcrMarker("not a marker")).toBeNull();
    expect(parseCcrMarker("")).toBeNull();
  });

  it("an empty or whitespace label degrades to the bare form, never `<<ccr:h | >>`", () => {
    expect(mintCcrMarker("9a2f", "")).toBe("<<ccr:9a2f>>");
    expect(mintCcrMarker("9a2f", "   ")).toBe("<<ccr:9a2f>>");
  });
});

describe("label sanitising — the label lives inside the grammar", () => {
  it("strips the grammar characters a label could forge a boundary with", () => {
    // Left in, `>>` would end the marker early and `|` would fake a label split.
    expect(sanitizeCcrLabel("a>>b|c<<d")).toBe("abcd");
    const forged = mintCcrMarker("aa", "evil>> <<ccr:bb");
    expect(forged).toBe("<<ccr:aa | evil ccr:bb>>");
    // ...and the forged text yields exactly ONE marker, resolving to the real hash.
    expect(forged.match(CCR_MARKER_RE_GLOBAL)).toHaveLength(1);
    expect(parseCcrMarker(forged)?.hash).toBe("aa");
  });

  it("collapses newlines, because a marker must stay on one line", () => {
    // The engine reasons in lines; a label that split one would desync kept/dropped.
    expect(sanitizeCcrLabel("first\nsecond\r\nthird")).toBe("first second third");
  });

  it("caps length with an ellipsis so a label cannot defeat the compression", () => {
    const out = sanitizeCcrLabel("x".repeat(500));
    expect(out.length).toBe(CCR_LABEL_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("funnelReversible labelling", () => {
  // Long enough to force real dropping at a small budget.
  const raw = Array.from({ length: 400 }, (_, i) => `ordinary content line ${i}`).join("\n");

  it("defaults to BARE markers — labelling must be opt-in", () => {
    const { text } = funnelReversible(raw, "generic", { maxChars: 500 });
    const markers = text.match(CCR_MARKER_RE_GLOBAL) ?? [];
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) expect(parseCcrMarker(m)?.label).toBeUndefined();
  });

  it("labels every marker when asked, and the label says how much and what kind", () => {
    const { text, stashed } = funnelReversible(raw, "generic", { maxChars: 500, labelMarkers: true });
    const markers = text.match(CCR_MARKER_RE_GLOBAL) ?? [];
    expect(markers.length).toBeGreaterThan(0);

    for (const m of markers) {
      const parsed = parseCcrMarker(m);
      expect(parsed).not.toBeNull();
      // "<N> <kind> lines · <peek>" — the three facts needed to choose.
      expect(parsed!.label).toMatch(/^\d+ [a-z ]+ lines?( · .*)?$/);
    }
    // The stash carries the label too, so a store can name a chunk without re-parsing.
    expect(stashed.length).toBeGreaterThan(0);
    for (const s of stashed) expect(typeof s.label).toBe("string");
  });

  it("labelling does not change WHICH content is recoverable — only how it is described", () => {
    // The compression decision must be independent of presentation, or a labelled run
    // would recover different bytes than an unlabelled one at the same budget.
    const bare = funnelReversible(raw, "generic", { maxChars: 500 });
    const labelled = funnelReversible(raw, "generic", { maxChars: 500, labelMarkers: true });
    expect(labelled.stashed.map((s) => s.content)).toEqual(bare.stashed.map((s) => s.content));
    expect(labelled.stashed.map((s) => parseCcrMarker(s.marker)!.hash))
      .toEqual(bare.stashed.map((s) => parseCcrMarker(s.marker)!.hash));
  });
});
