export {
  funnel,
  funnelReversible,
  compressGit,
  compressFileRead,
  compressGrep,
  compressTestOutput,
  compressBuildOutput,
  compressGeneric,
  classifyCommand,
  sniffContent,
} from "./router.js";
export { stripAnsi, collapseCarriageReturn } from "./internal/lines.js";
// The CCR marker grammar. Exported because it is a wire format crossing package
// boundaries (ccr-store keys on it, packages/tools parses it out of model-echoed text,
// eval/ counts it) — every consumer must share ONE definition, not hand-roll a fifth regex.
export {
  parseCcrMarker,
  mintCcrMarker,
  sanitizeCcrLabel,
  CCR_MARKER_RE,
  CCR_MARKER_RE_GLOBAL,
  CCR_LABEL_MAX_CHARS,
} from "./ccr-marker.js";
export type { Category, FunnelOptions, LineTag, StashedChunk, ReversibleResult } from "./types.js";
export { DEFAULT_MAX_CHARS } from "./types.js";
