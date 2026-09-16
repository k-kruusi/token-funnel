/**
 * Deterministic seeded stub driver — the ONE ADDITIVE ALLOWANCE beyond the
 * design doc. No network, no model: it parses the delivered context like a
 * scripted agent, retrieves ccr markers until done or budget-exhausted, and
 * emits a seeded mix of correct ANSWER:, wrong ANSWER:, and no-ANSWER gaveUp
 * responses as a function of what the arm actually delivered at each scale —
 * so the two-arm harness, the grade.ts tri-state, the ccr budget path, and
 * calibrate-join are integration-tested end-to-end offline.
 *
 * Determinism: every choice flows from mulberry32(fnv1a(seed|question|arm)).
 * The gaveUp pool deliberately mixes in-family surrender phrasings (join TP)
 * with out-of-family paraphrases (join FN → a real, nonzero silentFailRate),
 * and a slice of wrong answers carries a hedging family phrase (join FP).
 */
import { fnv1a, mulberry32, type Label } from "./gen-table.js";
import { CcrBudgetExhaustedError } from "./ccr-tool.js";
import type { AskArgs, AskResult, BenchDriver } from "./driver.js";

export const STUB_MODEL_ID = "stub-deterministic-v1";

const ROW_RE = /ROW id=(\d+) date=(\S+) user=(\S+) label=(\w+) headline="([^"]*)"/g;
const MARKER_RE = /<<ccr:[0-9a-f]+>>/g;
const TOTAL_RE = /END-OF-TABLE total-rows=(\d+)/;

interface VisibleRow {
  id: number;
  date: string;
  user: string;
  label: string;
}

function parseRows(text: string, into: Map<number, VisibleRow>): void {
  for (const m of text.matchAll(ROW_RE)) {
    const id = Number(m[1]);
    into.set(id, { id, date: m[2], user: m[3], label: m[4] });
  }
}

/** Answer the three tier shapes from whatever rows are visible. */
function computeAnswer(question: string, rows: VisibleRow[]): string | null {
  let m = /^How many rows have label = (\w+)\?$/.exec(question);
  if (m !== null) return String(rows.filter((r) => r.label === (m![1] as Label)).length);
  m = /^How many rows have a date on or after (\S+) and before (\S+) and label = (\w+)\?$/.exec(question);
  if (m !== null) {
    const [, start, end, label] = m;
    return String(rows.filter((r) => r.label === label && r.date >= start && r.date < end).length);
  }
  m = /^What is the label of the earliest row for user (\w+)\?/.exec(question);
  if (m !== null) {
    const mine = rows.filter((r) => r.user === m![1]).sort((a, b) => (a.date === b.date ? a.id - b.id : a.date.localeCompare(b.date)));
    return mine.length > 0 ? mine[0].label : null;
  }
  return null;
}

// 3/5 in-family (join TP), 2/5 out-of-family paraphrase (join FN — the honest
// silent-fail residual the join exists to measure).
const GAVE_UP_POOL = [
  "The table is truncated in what I can see, so I can't determine the exact count.",
  "I don't have enough information to give an exact figure — rows are missing from the visible portion.",
  "Parts of the table are inaccessible here and I don't have access to the missing rows.",
  "The visible portion cuts off partway, so a reliable total is not derivable from it.",
  "Too many rows are hidden for a trustworthy figure; any number would be a guess.",
];

export function makeStubDriver(seed: number): BenchDriver {
  return {
    modelId: STUB_MODEL_ID,
    async ask({ context, question, retriever }: AskArgs): Promise<AskResult> {
      const visible = new Map<number, VisibleRow>();
      parseRows(context, visible);

      let retrievalError: string | null = null;
      if (retriever !== null) {
        // Scripted retrieval policy: recover every marker in order until the
        // budget refuses — the refusal is the clear error under test.
        for (const m of context.match(MARKER_RE) ?? []) {
          try {
            parseRows(retriever.retrieve(m), visible);
          } catch (err) {
            retrievalError = err instanceof Error ? err.message : String(err);
            if (err instanceof CcrBudgetExhaustedError) break;
            throw err; // an unknown-marker error here is a harness bug — markers came from the text
          }
        }
      }

      const totalMatch = TOTAL_RE.exec(context);
      const knownTotal = totalMatch !== null ? Number(totalMatch[1]) : null;
      const rows = [...visible.values()];
      const complete = knownTotal !== null && rows.length === knownTotal;
      const computed = computeAnswer(question, rows);
      const ccrRetrievals = retriever?.retrievals() ?? 0;

      if (complete && computed !== null) {
        return {
          text: `Counting from the fully visible table.\nANSWER: ${computed}`,
          ccrRetrievals,
          retrievalError,
        };
      }

      // Incomplete view: seeded mix of gaveUp vs wrong-answer, a function of
      // the question + arm identity — stable across runs by construction.
      const rand = mulberry32(fnv1a(`${seed}|${question}|${retriever === null ? "raw" : "funnel"}|${rows.length}`));
      if (rand() < 0.55 || computed === null) {
        const pick = GAVE_UP_POOL[Math.floor(rand() * GAVE_UP_POOL.length)];
        return { text: pick, ccrRetrievals, retrievalError };
      }
      const hedged = rand() < 0.15; // FP slice: an ANSWER accompanied by a family phrase
      const prefix = hedged
        ? "I cannot verify every row from here, but based on the visible portion:"
        : "Based on the visible rows:";
      return { text: `${prefix}\nANSWER: ${computed}`, ccrRetrievals, retrievalError };
    },
  };
}
