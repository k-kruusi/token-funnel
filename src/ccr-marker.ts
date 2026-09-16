/**
 * ccr-marker.ts — the CCR marker grammar, minted and parsed in ONE place.
 *
 * ## Why this module exists
 *
 * The `<<ccr:HASH>>` sentinel is a wire format shared across package boundaries: this
 * library mints it, `@agentruntime/ccr-store` keys a cache by it, `packages/tools`'
 * `ccr_retrieve` tool parses it out of model-echoed text, and the eval harness counts
 * it. Before this module there were four independent hand-rolled regexes for the same
 * grammar. That is survivable while the grammar is frozen and a guaranteed drift bug the
 * moment it is not — which is exactly what adding labels does to it.
 *
 * ## The labelled form, and why the label is OPTIONAL
 *
 *   <<ccr:9a2f…>>                          bare (default — unchanged, byte for byte)
 *   <<ccr:9a2f… | 12 context lines · "…">> labelled (opt in via FunnelOptions.labelMarkers)
 *
 * A hash is an address, not a description. A model handed a bare marker cannot tell
 * whether the span behind it is the one it needs, so it either expands blindly or skips
 * recoverable content — the label is what turns a recovery mechanism into a decision.
 *
 * The default stays bare on purpose. token-funnel's CCR path is *measured* (see `eval/`),
 * and silently changing the format every consumer already parses would invalidate the
 * benchmark and any regex written against it in the same stroke. Callers that want
 * labels ask for them.
 *
 * `parseCcrMarker` accepts BOTH forms regardless of who minted them, so a labelled
 * marker produced today is still expandable by a caller written before labels existed
 * — provided that caller parses through this module.
 */

const HASH_BODY = "[0-9a-f]+";

/** Matches a bare or labelled marker. Group 1 = hash, group 2 = label (may be absent). */
export const CCR_MARKER_RE = new RegExp(`<<ccr:(${HASH_BODY})(?:\\s*\\|\\s*([^<>|]*))?>>`);

/** Global variant, for callers counting or replacing every marker in a body of text. */
export const CCR_MARKER_RE_GLOBAL = new RegExp(CCR_MARKER_RE.source, "g");

/** Max label length inside a marker. Long enough to be useful, short enough not to defeat compression. */
export const CCR_LABEL_MAX_CHARS = 80;

/**
 * Make a label safe to embed in a marker.
 *
 * `<`, `>` and `|` are grammar characters — a label containing them could forge a
 * marker boundary or swallow the closing `>>`, so they are removed rather than escaped
 * (nothing downstream would unescape them). Newlines collapse because a marker must
 * stay on one line: the engine reasons in lines, and a label that split one would
 * desynchronise the kept/dropped bookkeeping.
 */
export function sanitizeCcrLabel(label: string, maxChars: number = CCR_LABEL_MAX_CHARS): string {
  const flat = label
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= maxChars) return flat;
  return flat.slice(0, Math.max(0, maxChars - 1)) + "…";
}

/** Build a marker. An empty or whitespace-only label yields the bare form, never `<<ccr:h | >>`. */
export function mintCcrMarker(hash: string, label?: string): string {
  if (label === undefined) return `<<ccr:${hash}>>`;
  const safe = sanitizeCcrLabel(label);
  return safe === "" ? `<<ccr:${hash}>>` : `<<ccr:${hash} | ${safe}>>`;
}

/**
 * Normalize a marker (bare or labelled) or a bare hex hash to its parts.
 *
 * `null` means "not a CCR reference at all" — distinct from a well-formed reference that
 * is simply not in a cache. Callers must keep those two apart: conflating them is how a
 * typo'd marker and an evicted chunk become the same unhelpful answer.
 */
export function parseCcrMarker(markerOrHash: string): { hash: string; label?: string } | null {
  const m = CCR_MARKER_RE.exec(markerOrHash);
  if (m !== null) {
    const label = m[2] === undefined ? undefined : m[2].trim();
    return { hash: m[1], label: label === "" ? undefined : label };
  }
  const bare = markerOrHash.trim();
  return new RegExp(`^${HASH_BODY}$`).test(bare) ? { hash: bare } : null;
}
