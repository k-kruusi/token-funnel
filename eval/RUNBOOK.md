# token-funnel eval — distributional context benchmark RUNBOOK

Part 2 of the adjudicated loop-sensors design (genesis cards `d5919316`,
`81f2165b`). Measures whether `funnelReversible` + CCR retrieval buys
**effective context**: the scale gap (`deltaCliff`) between the raw arm's and
the funnel arm's accuracy falloff on a seeded synthetic table.

## What runs against what

| Arm | Delivery |
|---|---|
| **raw** | `doc.rendered.slice(0, budget)` — hard prefix, unassisted |
| **funnel** | the REAL `funnelReversible(rendered, "file-read", {maxChars: budget})` from `dist/` + the built `ccr_retrieve` tool (`ccr-tool.ts`), debited against `--retrieval-budget` per question |

`token-funnel/src` is untouched — the eval imports the public API from `dist/`
(`npm run build` first if missing). Grading is deterministic exact-match
against the seed-derived answer key (`grade.ts` — tri-state
`answered-correct | answered-wrong | gaveUp`, gaveUp = no parseable
`ANSWER:` line). **No LLM anywhere in the key or grade path.**

## Determinism

- All data flows from `mulberry32(seed)` (gen-table.ts). `Math.random` and
  `Date.now` are forbidden in data paths; the report's `generatedAt` is the
  only wall-clock field.
- Same seed → byte-identical table `fingerprint` and answer key.
- With the real driver, inference is pinned (`--temperature 0`, `--model
  <fixed id>` stamped into the report); the grade is deterministic, accuracy
  is model-conditioned — expect a narrow band across re-runs, not bit-equality.
- Flag naming: the design sketch inherited `--out-pass/--out-served` from
  eval-serve-collect; this harness's two arms are named honestly:
  `--out-raw` / `--out-funnel`.

## Offline run (stub driver — CI / gauntlet; zero network, zero spend)

```
npx tsx dependencies/token-funnel/eval/run-bench.ts --stub-driver \
  --seed 24029 --scales 50,200 --commit $(git rev-parse HEAD)
```

The stub (`stub-driver.ts`) is a deterministic scripted agent: it parses the
delivered rows, retrieves markers until the budget refuses (exercising the
clear exhaustion error), and emits a seeded mix of correct / wrong / gaveUp
responses as a function of what each arm delivered at each scale. Its gaveUp
pool intentionally mixes in-family surrender phrasings with out-of-family
paraphrases so `calibrate-join` measures a real, nonzero `silentFailRate`.
Stub numbers exercise the machinery; they say **nothing** about any model.

## Live run (OPERATOR ONLY — real API spend)

The real driver (`driver.ts`, Anthropic Messages, temperature 0, pinned model
id, `ccr_retrieve` as a genuine tool loop) ships but is **never run by CI or
agents without the operator**. The exact manual command:

```
ANTHROPIC_API_KEY=<key> npx tsx dependencies/token-funnel/eval/run-bench.ts \
  --seed 24029 --scales 50,100,200,400,800,1600 --budget 50000 --noise 8 --qpt 5 \
  --model claude-haiku-4-5-20251001 --temperature 0 --retrieval-budget 8000 \
  --commit $(git rev-parse HEAD)
```

Then the honest floor (control — expect `deltaCliff ≈ 0`, confirming gains
come from stripping noise, not magic):

```
ANTHROPIC_API_KEY=<key> npx tsx dependencies/token-funnel/eval/run-bench.ts \
  --seed 24029 --scales 50,100,200,400,800,1600 --budget 50000 --noise 0 --qpt 5 \
  --model claude-haiku-4-5-20251001 --temperature 0 --retrieval-budget 8000 \
  --commit $(git rev-parse HEAD) \
  --report dependencies/token-funnel/eval/reports/24029-noise0-report.json \
  --out-raw dependencies/token-funnel/eval/reports/24029-noise0-raw.json \
  --out-funnel dependencies/token-funnel/eval/reports/24029-noise0-funnel.json
```

Commit the resulting `keys/` and `reports/` files with safe-commit.

## The join (Part 1 handshake)

```
npx tsx packages/loop-sensors/scripts/calibrate-join.ts \
  --arm-raw dependencies/token-funnel/eval/reports/<tag>-raw.json \
  --out packages/loop-sensors/reports/join-calibration.json
```

Runs the loop-sensors **phrase-family layer only** (gate bypassed — disclosed
in the output) over each arm-raw `agentText`, cross-tabbed against
`graderState`. Because the seed proves every failure was answerable, this is
the only source of a real `phraseRecall` / `silentFailRate` for the Part-1
families. Benchmark give-up phrasing may differ from repo-task phrasing — the
output carries that caveat.

## What deltaCliff means — and doesn't

- **Means:** on THIS noise-shaped corpus, the funnel let the same model answer
  distributional questions at N× the scale before falling off — i.e. the
  funnel bought effective context by stripping strippable noise under a fixed
  char budget.
- **Doesn't mean:** a universal context multiplier. The `--noise 0` control is
  committed precisely to show the honest floor (≈0 gain on an all-signal
  table); prefix-vs-whole delivery differences are auditable via the per-scale
  `armRaw_chars` / `armFunnel_chars` columns (maxChars is soft).
