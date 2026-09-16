# @agentruntime/token-funnel

A pure, dependency-free (node builtins only) library that compresses tool/command output
before it reaches an LLM's context — without ever dropping the content that tells the
caller what actually went wrong. Shared by `packages/tools` (bash/grep/read) and
`packages/traffic-mirror` so both sites count tokens against compressed, not raw, output.

## The Honest Response Principle

An MCP tool must never return ambiguous garbage. A truncated failure — half a stack
trace, a summary with no error detail — is worse than no compression at all, because the
caller can't tell "nothing went wrong" from "the evidence got cut." token-funnel's core
guarantee: **any line that looks like a failure signal is never dropped**, no matter how
tight the budget, short of an explicit, labeled emergency cap.

## Usage

```ts
import { funnel } from "@agentruntime/token-funnel";

// hint is a category token ("git", "test-output", …) OR a tool name/shell
// command — token-funnel resolves it to a category, sniffing content if the
// hint doesn't disambiguate on its own.
const compressed = funnel(rawStdout, "git", { maxChars: 50_000, isError: exitCode !== 0 });
```

Direct category access, when the caller already knows the category:

```ts
import { compressGit, compressTestOutput, compressBuildOutput, compressGrep, compressFileRead, compressGeneric } from "@agentruntime/token-funnel";
```

`funnel()` never throws: a failure inside a profile's rules (or the engine itself) falls
back to the generic profile, and a failure there falls back to a plain ANSI-stripped
truncation. No consumer should ever see an exception bubble up from compression.

## How it works

```
raw string, hint?, opts?
  → router: resolveCategory(raw, hint)     — hint dispatch, or scored content-sniffing
  → engine: runEngine(raw, profile, opts)
      → splitLines(raw)                     — collapse \r overwrites, strip ANSI, cap line length
      → classify(lines, profile)             — universal keep_always rules first, then the
                                                profile's own rules; first match wins
      → foldConsecutiveDuplicates(records)   — an adjacent identical run becomes one
                                                "redundant" record carrying its repeat count
      → allocateBudget(records, budget, …)   — keep_always never dropped (except by the
                                                emergency cap); remaining budget spent in
                                                priority order: signal → context →
                                                boilerplate → redundant → progress
      → reconstruct(records, profile)        — original order; a run of ≥2 dropped
                                                consecutive records becomes one
                                                profile-supplied placeholder
  → compressed string
```

One engine, category-blind. Everything category-specific — what counts as noise, what
placeholder text to show, how confident a content sample looks for this category — comes
from the `CategoryProfile` the router picked.

### Categories

| Category | What it targets |
|---|---|
| `git` | `git status`/`diff`/`push`/`pull` output — keeps file lists and real diff hunks, collapses lockfile/generated-file diffs and unchanged context beyond the first few lines per hunk |
| `test-output` | jest/vitest/pytest-shaped test runs — collapses passing-test noise, always keeps failing-test names, assertion messages, and stack/location lines |
| `build-output` | tsc/eslint/webpack-shaped build output — always keeps compiler/linter errors and warnings, collapses progress spinners and percentage-compiling spam |
| `grep` | ripgrep-shaped `path:line:` match output — caps matches per file, collapses the overflow |
| `file-read` | numbered-gutter file reads — dedups identical lines despite differing line-number prefixes, re-attaches gutters as line-number ranges on collapsed runs |
| `generic` | safe fallback — only the universal keep_always floor applies; a caller that misclassifies content degrades compression, never correctness |

### The universal `keep_always` floor

Every profile runs a shared set of cross-category rules *before* its own — failing-test
markers, `AssertionError`, `Error:`, JS/pytest stack frames, tsc/rustc/eslint error lines,
`[exit code: N]`, unicode fail markers (× ✗ ✖). These fire regardless of which category
the router picked, so a misclassified command (e.g. a `git` hint routed to a build that
actually failed) still can't lose its error content — only its compression ratio suffers.

### Budget allocation

1. `keep_always` records are always included; only `emergencyCap` (default `4 × maxChars`)
   can trim them, and only with an explicit `[token-funnel: truncated at emergency cap, …]`
   marker.
2. `minHeadLines`/`minTailLines` (per-profile defaults, overridable via `FunnelOptions`)
   are force-kept as a floor.
3. Remaining budget is spent in priority order — `signal` → `context` → `boilerplate` →
   `redundant` → `progress`. A tier that overflows the remaining budget is trimmed from
   its own middle (alternating head/tail), so both ends of a long run survive instead of
   always favoring whichever came first.

### `isError`

Pass the caller's own ground truth when it's known (e.g. a shell command's exit code).
`isError: true` widens `boilerplate`/`progress` lines to `context` — competing for budget
instead of being collapsed first — without disabling compression outright. `keep_always`
rules fire regardless of this flag either way; content truth always wins over the caller's
signal.

## Testing

```
npm test          # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc
```

`src/__tests__/honest-response.test.ts` is the Honest Response invariant suite;
`idempotency.test.ts` checks `funnel(funnel(x))` doesn't cascade into further mangling
(the property double-compression across `bash.ts` → `traffic-mirror` relies on);
`benchmark.test.ts` guards the O(n) budget-allocation pass against an accidental
quadratic regression on adversarial input sizes.
