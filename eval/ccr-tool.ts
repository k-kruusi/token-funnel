/**
 * The CCR retrieval shim (design §6, resolving critiques A#5/B#4): a BUILT
 * `ccr_retrieve(marker)` resolving funnelReversible's stashed
 * `marker → content`, debited against a per-question retrieval budget.
 *
 * Honest Response Principle: exhaustion and unknown markers return CLEAR,
 * actionable errors — never empty strings — so arm B cannot silently
 * reconstitute the whole doc and the model gets a signal it can act on.
 */
import { strict as assert } from "node:assert";
import type { StashedChunk } from "../dist/index.js";

export class CcrBudgetExhaustedError extends Error {
  constructor(marker: string, contentLength: number, remaining: number) {
    super(
      `ccr_retrieve: retrieval budget exhausted — ${marker} holds ${contentLength} chars but only ` +
        `${remaining} of the per-question retrieval budget remain. No further retrievals are possible; ` +
        `answer from what you already have, or state plainly that you cannot.`,
    );
    this.name = "CcrBudgetExhaustedError";
  }
}

export interface CcrRetriever {
  /** Resolve a <<ccr:HASH>> marker to its stashed content, debiting the budget. Throws on unknown marker or exhaustion. */
  retrieve(marker: string): string;
  retrievals(): number;
  spent(): number;
  budget(): number;
}

export function makeCcrRetriever(stashed: StashedChunk[], budgetChars: number): CcrRetriever {
  assert(budgetChars > 0, "makeCcrRetriever: a zero retrieval budget means arm B was misconfigured — pass --retrieval-budget > 0");
  const byMarker = new Map<string, string>();
  for (const chunk of stashed) byMarker.set(chunk.marker, chunk.content);

  let spent = 0;
  let retrievals = 0;

  return {
    retrieve(marker: string): string {
      const content = byMarker.get(marker);
      if (content === undefined) {
        // Model-facing boundary: a hallucinated or mistyped marker gets an
        // actionable error, not a silent empty success.
        throw new Error(
          `ccr_retrieve: unknown marker ${JSON.stringify(marker)} — valid markers look like <<ccr:HASH>> and ` +
            `must be copied verbatim from the compressed text (${byMarker.size} markers exist for this question).`,
        );
      }
      const remaining = budgetChars - spent;
      if (content.length > remaining) throw new CcrBudgetExhaustedError(marker, content.length, remaining);
      // Re-retrieving the same marker is charged again on purpose: the budget
      // prices delivered chars, and a driver that re-reads pays for it.
      spent += content.length;
      retrievals++;
      return content;
    },
    retrievals: () => retrievals,
    spent: () => spent,
    budget: () => budgetChars,
  };
}
