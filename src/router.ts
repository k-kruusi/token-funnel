import type { Category, CategoryProfile, FunnelOptions, ReversibleResult } from "./types.js";
import { DEFAULT_MAX_CHARS, SNIFF_SAMPLE_SIZE } from "./types.js";
import { runEngine, runEngineReversible } from "./engine.js";
import { stripAnsi } from "./internal/lines.js";
import { GIT_PROFILE } from "./profiles/git.js";
import { TEST_OUTPUT_PROFILE } from "./profiles/test-output.js";
import { BUILD_OUTPUT_PROFILE } from "./profiles/build-output.js";
import { GREP_PROFILE } from "./profiles/grep.js";
import { FILE_READ_PROFILE } from "./profiles/file-read.js";
import { GENERIC_PROFILE } from "./profiles/generic.js";

const PROFILES: Record<Category, CategoryProfile> = {
  git: GIT_PROFILE,
  "test-output": TEST_OUTPUT_PROFILE,
  "build-output": BUILD_OUTPUT_PROFILE,
  grep: GREP_PROFILE,
  "file-read": FILE_READ_PROFILE,
  generic: GENERIC_PROFILE,
};

// generic has no anchors of its own — it's reached only by falling below the
// confidence floor on every sniffable category, never by winning a sniff race.
const SNIFFABLE_CATEGORIES: Category[] = ["git", "test-output", "build-output", "grep", "file-read"];
const SNIFF_CONFIDENCE_FLOOR = 0.15;

function isCategory(value: string): value is Category {
  return Object.prototype.hasOwnProperty.call(PROFILES, value);
}

// Tool names that map to exactly one category — no need to sniff content.
const TOOL_NAME_TO_CATEGORY: Record<string, Category> = {
  Grep: "grep",
  grep_search: "grep",
  Read: "file-read",
  read_file: "file-read",
};

// Tool names whose output could be anything (a shell can run git, a test
// runner, a build, or ad-hoc commands) — content-sniff instead of guessing.
const AMBIGUOUS_TOOL_NAMES = new Set(["Bash", "run_command", "mcp__ar-tools__run_command"]);

export function classifyCommand(command: string): Category {
  if (/^\s*git\b/.test(command)) return "git";
  if (/\b(vitest|jest|pytest|mocha|npm\s+(run\s+)?test|npx\s+vitest)\b/.test(command)) return "test-output";
  if (/\b(tsc|webpack|esbuild|rollup|vite\s+build|npm\s+run\s+build)\b/.test(command)) return "build-output";
  return "generic";
}

function sniffSample(raw: string): string {
  if (raw.length <= SNIFF_SAMPLE_SIZE * 2) return raw;
  return raw.slice(0, SNIFF_SAMPLE_SIZE) + raw.slice(-SNIFF_SAMPLE_SIZE);
}

export function sniffContent(raw: string): Category {
  const sample = sniffSample(raw);
  let best: Category = "generic";
  let bestScore = 0;
  for (const category of SNIFFABLE_CATEGORIES) {
    const score = PROFILES[category].sniff(sample);
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return bestScore >= SNIFF_CONFIDENCE_FLOOR ? best : "generic";
}

export function resolveCategory(raw: string, hint?: string): Category {
  if (!hint) return sniffContent(raw);
  if (isCategory(hint)) return hint;
  if (TOOL_NAME_TO_CATEGORY[hint]) return TOOL_NAME_TO_CATEGORY[hint];
  if (AMBIGUOUS_TOOL_NAMES.has(hint)) return sniffContent(raw);

  const classified = classifyCommand(hint);
  if (classified !== "generic") return classified;
  return sniffContent(raw);
}

const DEFAULT_EMERGENCY_CAP = DEFAULT_MAX_CHARS * 4;

/**
 * The one entry point every consumer should call. Never throws: a failure
 * inside the resolved profile's rules (or the engine itself) falls back to
 * the generic profile, and a failure there falls back to a plain ANSI-stripped
 * truncation — an MCP tool that funnels its output through this should never
 * see an exception bubble up from compression.
 */
export function funnel(raw: string, hint?: string, opts: FunnelOptions = {}): string {
  const category = resolveCategory(raw, hint);
  try {
    return runEngine(raw, PROFILES[category], opts);
  } catch {
    try {
      return runEngine(raw, GENERIC_PROFILE, opts);
    } catch {
      const cap = opts.emergencyCap ?? DEFAULT_EMERGENCY_CAP;
      const stripped = stripAnsi(raw);
      if (stripped.length <= cap) return stripped;
      const omitted = stripped.length - cap;
      return `${stripped.slice(0, cap)}\n[token-funnel: emergency fallback, ${omitted} chars truncated]`;
    }
  }
}

/**
 * Reversible variant of funnel: identical compression, but multi-line dropped
 * runs produce <<ccr:HASH>> markers instead of generic placeholders, and the
 * dropped content is returned in `stashed` for the caller to persist.
 *
 * Falls back to non-reversible funnel() on engine failure (same never-throws
 * guarantee as funnel), returning an empty stash. Existing callers that don't
 * opt in to this path are unaffected — funnelReversible is additive.
 */
export function funnelReversible(raw: string, hint?: string, opts: FunnelOptions = {}): ReversibleResult {
  const category = resolveCategory(raw, hint);
  try {
    return runEngineReversible(raw, PROFILES[category], opts);
  } catch {
    // On engine failure, degrade gracefully: compress without stash so the
    // caller still gets a usable output. An empty stash is honest — nothing
    // was stashed because the reversible path didn't run.
    return { text: funnel(raw, hint, opts), stashed: [] };
  }
}

export function compressGit(raw: string, opts?: FunnelOptions): string {
  return runEngine(raw, GIT_PROFILE, opts);
}
export function compressFileRead(raw: string, opts?: FunnelOptions): string {
  return runEngine(raw, FILE_READ_PROFILE, opts);
}
export function compressGrep(raw: string, opts?: FunnelOptions): string {
  return runEngine(raw, GREP_PROFILE, opts);
}
export function compressTestOutput(raw: string, opts?: FunnelOptions): string {
  return runEngine(raw, TEST_OUTPUT_PROFILE, opts);
}
export function compressBuildOutput(raw: string, opts?: FunnelOptions): string {
  return runEngine(raw, BUILD_OUTPUT_PROFILE, opts);
}
export function compressGeneric(raw: string, opts?: FunnelOptions): string {
  return runEngine(raw, GENERIC_PROFILE, opts);
}
