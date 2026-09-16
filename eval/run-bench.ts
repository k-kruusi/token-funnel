/**
 * run-bench — the two-arm distributional context benchmark (design §3.8/§5).
 *
 *   Arm RAW:    hard prefix `rendered.slice(0, budget)`, unassisted.
 *   Arm FUNNEL: the REAL funnelReversible(raw, "file-read", {maxChars:budget})
 *               + the built ccr_retrieve tool, debited per question.
 *
 * Grading is deterministic exact-match against the seed-derived key (no LLM).
 * `effectiveContext.deltaCliff` = the scale gap between the arms' accuracy
 * falloffs (< 0.5) — THE number Part 2 exists to produce.
 *
 * Offline (this gauntlet, CI):
 *   npx tsx dependencies/token-funnel/eval/run-bench.ts --stub-driver --seed 24029 --scales 50,200
 * Live (OPERATOR ONLY — API spend; see RUNBOOK.md):
 *   npx tsx dependencies/token-funnel/eval/run-bench.ts --seed 24029 \
 *     --scales 50,100,200,400,800,1600 --budget 50000 --noise 8 --qpt 5 \
 *     --model claude-haiku-4-5-20251001 --temperature 0 --retrieval-budget 8000
 */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { funnelReversible } from "../dist/index.js";
import { genDoc } from "./gen-table.js";
import { genQuestions, type AnswerKey, type Tier } from "./questions.js";
import { makeCcrRetriever } from "./ccr-tool.js";
import { makeAnthropicDriver, type BenchDriver } from "./driver.js";
import { makeStubDriver } from "./stub-driver.js";
import { grade, type GraderState } from "./grade.js";

export type Arm = "raw" | "funnel";

export interface BenchItem {
  scale: number;
  qid: string;
  tier: Tier;
  arm: Arm;
  agentText: string;
  graderState: GraderState;
  ccrRetrievals: number;
  retrievalError: string | null;
  charsDelivered: number;
}

export interface BenchOptions {
  seed: number;
  scales: number[];
  budget: number;
  noise: number;
  qpt: number;
  retrievalBudget: number;
  commit: string;
}

export interface ScaleCurvePoint {
  scale: number;
  tableFingerprint: string;
  armRaw_acc: number;
  armFunnel_acc: number;
  armRaw_chars: number;
  armFunnel_chars: number;
  ccrRetrievals: number;
  retrievalBudgetExhaustions: number;
}

export interface BenchReport {
  seed: number;
  commit: string;
  budget: number;
  noise: number;
  retrievalBudget: number;
  qpt: number;
  modelId: string;
  temperature: 0;
  samplesPerQ: 1;
  generatedAt: string; // the ONLY wall-clock field
  perTier: Record<Tier, { armRaw: number; armFunnel: number }>;
  scaleCurve: ScaleCurvePoint[];
  effectiveContext: { armRaw_cliffScale: number | null; armFunnel_cliffScale: number | null; deltaCliff: number | null };
  charsDelivered: string;
  items: Array<Omit<BenchItem, "agentText" | "retrievalError"> & { retrievalError: boolean }>;
}

const SYSTEM_RAW =
  "You are answering questions about a rendered table file. Data rows look like " +
  'ROW id=NNNN date=YYYY-MM-DD user=uNNN label=word headline="...". Count carefully over ALL rows. ' +
  "End your reply with a final line of exactly `ANSWER: <value>`. If you cannot determine the answer " +
  "reliably (for example the table is visibly truncated), say so plainly and do NOT emit an ANSWER line — never guess.";

const SYSTEM_FUNNEL =
  SYSTEM_RAW +
  " Some spans of the file were compressed away and replaced by <<ccr:HASH>> markers. You may recover a span " +
  "with the ccr_retrieve tool (marker copied verbatim). Retrieval is debited against a limited budget; when it " +
  "is exhausted the tool returns a clear error and you must answer from what you have.";

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function accuracy(items: BenchItem[]): number {
  assert(items.length > 0, "accuracy: caller filters to a non-empty (scale, arm) slice — the harness generated it");
  return round3(items.filter((i) => i.graderState === "answered-correct").length / items.length);
}

/** First scale (ascending) where an arm's accuracy falls below 0.5 — null if it never does. */
function cliffScale(points: Array<{ scale: number; acc: number }>): number | null {
  for (const p of [...points].sort((a, b) => a.scale - b.scale)) {
    if (p.acc < 0.5) return p.scale;
  }
  return null;
}

export interface BenchRun {
  report: BenchReport;
  rawItems: BenchItem[];
  funnelItems: BenchItem[];
  keys: AnswerKey[];
}

export async function runBench(opts: BenchOptions, driver: BenchDriver): Promise<BenchRun> {
  assert(opts.scales.length > 0, "runBench: --scales must list at least one row count");
  assert(opts.budget > 0 && opts.retrievalBudget > 0, "runBench: budgets are positive char counts by contract");

  const rawItems: BenchItem[] = [];
  const funnelItems: BenchItem[] = [];
  const keys: AnswerKey[] = [];
  const curve: ScaleCurvePoint[] = [];

  for (const scale of [...opts.scales].sort((a, b) => a - b)) {
    const doc = genDoc(opts.seed, scale, opts.noise);
    const key = genQuestions(doc, opts.seed, scale, opts.noise, opts.qpt);
    keys.push(key);

    const rawContext = doc.rendered.slice(0, opts.budget);
    const { text: funnelText, stashed } = funnelReversible(doc.rendered, "file-read", { maxChars: opts.budget });

    const scaleRaw: BenchItem[] = [];
    const scaleFunnel: BenchItem[] = [];
    let ccrRetrievals = 0;
    let exhaustions = 0;

    for (const q of key.questions) {
      const raw = await driver.ask({ system: SYSTEM_RAW, context: rawContext, question: q.prompt, retriever: null });
      scaleRaw.push({
        scale,
        qid: q.qid,
        tier: q.tier,
        arm: "raw",
        agentText: raw.text,
        graderState: grade(raw.text, q.expected),
        ccrRetrievals: 0,
        retrievalError: null,
        charsDelivered: rawContext.length,
      });

      // Fresh retriever per question — the budget is per-question by design (A#5).
      const retriever = makeCcrRetriever(stashed, opts.retrievalBudget);
      const fun = await driver.ask({ system: SYSTEM_FUNNEL, context: funnelText, question: q.prompt, retriever });
      ccrRetrievals += fun.ccrRetrievals;
      if (fun.retrievalError !== null) exhaustions++;
      scaleFunnel.push({
        scale,
        qid: q.qid,
        tier: q.tier,
        arm: "funnel",
        agentText: fun.text,
        graderState: grade(fun.text, q.expected),
        ccrRetrievals: fun.ccrRetrievals,
        retrievalError: fun.retrievalError,
        charsDelivered: funnelText.length + retriever.spent(),
      });
    }

    rawItems.push(...scaleRaw);
    funnelItems.push(...scaleFunnel);
    curve.push({
      scale,
      tableFingerprint: doc.fingerprint,
      armRaw_acc: accuracy(scaleRaw),
      armFunnel_acc: accuracy(scaleFunnel),
      armRaw_chars: rawContext.length,
      armFunnel_chars: funnelText.length,
      ccrRetrievals,
      retrievalBudgetExhaustions: exhaustions,
    });
  }

  const perTier = {} as BenchReport["perTier"];
  for (const tier of ["count", "filter-count", "temporal"] as Tier[]) {
    perTier[tier] = {
      armRaw: accuracy(rawItems.filter((i) => i.tier === tier)),
      armFunnel: accuracy(funnelItems.filter((i) => i.tier === tier)),
    };
  }

  const rawCliff = cliffScale(curve.map((p) => ({ scale: p.scale, acc: p.armRaw_acc })));
  const funnelCliff = cliffScale(curve.map((p) => ({ scale: p.scale, acc: p.armFunnel_acc })));

  const report: BenchReport = {
    seed: opts.seed,
    commit: opts.commit,
    budget: opts.budget,
    noise: opts.noise,
    retrievalBudget: opts.retrievalBudget,
    qpt: opts.qpt,
    modelId: driver.modelId,
    temperature: 0,
    samplesPerQ: 1,
    generatedAt: new Date().toISOString(),
    perTier,
    scaleCurve: curve,
    effectiveContext: {
      armRaw_cliffScale: rawCliff,
      armFunnel_cliffScale: funnelCliff,
      deltaCliff: rawCliff !== null && funnelCliff !== null ? funnelCliff - rawCliff : null,
    },
    charsDelivered:
      "armRaw_chars/armFunnel_chars are printed per scale — maxChars is SOFT (funnel may deliver slightly " +
      "under/over), so arm fairness is auditable rather than assumed (A#7). Funnel charsDelivered per item " +
      "additionally counts retrieved chars.",
    items: [...rawItems, ...funnelItems].map(({ agentText: _a, retrievalError, ...rest }) => ({
      ...rest,
      retrievalError: retrievalError !== null,
    })),
  };

  return { report, rawItems, funnelItems, keys };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const flag = (k: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(`--${k}`);
  return i !== -1 ? process.argv[i + 1] : d;
};
const has = (k: string): boolean => process.argv.includes(`--${k}`);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function resolveCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch (err) {
    throw new Error(
      `run-bench: could not resolve git HEAD (${err instanceof Error ? err.message : String(err)}) — pass --commit <sha>`,
    );
  }
}

async function main(): Promise<void> {
  const seed = Number(flag("seed", "24029"));
  const scales = flag("scales", "50,100,200,400,800,1600")!
    .split(",")
    .map((s) => Number(s.trim()));
  assert(scales.every((s) => Number.isInteger(s) && s > 0), "run-bench: --scales must be positive integers");
  const temperature = Number(flag("temperature", "0"));
  assert(temperature === 0, "run-bench: temperature is pinned to 0 (A#3) — the report's determinism claim depends on it");

  const evalDir = fileURLToPath(new URL(".", import.meta.url));
  const opts: BenchOptions = {
    seed,
    scales,
    budget: Number(flag("budget", "50000")),
    noise: Number(flag("noise", "8")),
    qpt: Number(flag("qpt", "5")),
    retrievalBudget: Number(flag("retrieval-budget", "8000")),
    commit: flag("commit") ?? resolveCommit(),
  };

  const driver: BenchDriver = has("stub-driver")
    ? makeStubDriver(seed)
    : makeAnthropicDriver(flag("model", "claude-haiku-4-5-20251001")!);

  const tag = has("stub-driver") ? `${seed}-stub` : `${seed}`;
  const outRaw = flag("out-raw", join(evalDir, "reports", `${tag}-raw.json`))!;
  const outFunnel = flag("out-funnel", join(evalDir, "reports", `${tag}-funnel.json`))!;
  const reportPath = flag("report", join(evalDir, "reports", `${tag}-report.json`))!;
  const keysDir = flag("keys-dir", join(evalDir, "keys"))!;

  const { report, rawItems, funnelItems, keys } = await runBench(opts, driver);

  for (const key of keys) writeJson(join(keysDir, `${key.seed}-${key.scale}-${key.noise}.json`), key);
  writeJson(outRaw, { seed, commit: opts.commit, modelId: driver.modelId, items: rawItems });
  writeJson(outFunnel, { seed, commit: opts.commit, modelId: driver.modelId, items: funnelItems });
  writeJson(reportPath, report);

  console.log(
    JSON.stringify(
      {
        outRaw,
        outFunnel,
        reportPath,
        modelId: report.modelId,
        scaleCurve: report.scaleCurve,
        effectiveContext: report.effectiveContext,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}
