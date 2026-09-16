/**
 * The REAL model driver (design §6, A#3/A#4 fixes): concrete Anthropic
 * Messages client, temperature 0, pinned model id, `ANSWER:` extraction
 * contract documented in the system prompt, ccr_retrieve exposed as a real
 * tool with the budget errors surfaced as is_error tool_results.
 *
 * THIS DRIVER IS NEVER RUN IN CI OR THE GAUNTLET — it costs API spend and
 * requires ANTHROPIC_API_KEY. The RUNBOOK prints the exact manual command for
 * the operator's live run. The offline stub driver (stub-driver.ts) exercises
 * the identical harness contract.
 */
import { strict as assert } from "node:assert";
import { CcrBudgetExhaustedError, type CcrRetriever } from "./ccr-tool.js";

export interface AskArgs {
  system: string;
  context: string;
  question: string;
  /** null on the raw arm; the funnel arm passes the budget-bounded retriever. */
  retriever: CcrRetriever | null;
}

export interface AskResult {
  text: string;
  ccrRetrievals: number;
  /** The clear budget-exhaustion (or unknown-marker) message, when one occurred. */
  retrievalError: string | null;
}

export interface BenchDriver {
  modelId: string;
  ask(args: AskArgs): Promise<AskResult>;
}

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOOL_ITERATIONS = 40;

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface MessagesResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

const CCR_TOOL = {
  name: "ccr_retrieve",
  description:
    "Recover a compressed-away span of the table. Pass a <<ccr:HASH>> marker copied verbatim from the text. " +
    "Retrieval is debited against a limited per-question budget; when it is exhausted you must answer from what you have.",
  input_schema: {
    type: "object",
    properties: { marker: { type: "string", description: "A <<ccr:HASH>> marker from the compressed text" } },
    required: ["marker"],
  },
} as const;

export function makeAnthropicDriver(modelId: string): BenchDriver {
  assert(modelId !== "", "makeAnthropicDriver: a pinned model id is part of the report's provenance (A#3) — pass --model");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  assert(
    apiKey !== undefined && apiKey !== "",
    "makeAnthropicDriver: ANTHROPIC_API_KEY is not set — the live run is operator-initiated only (see eval/RUNBOOK.md); use --stub-driver for offline runs",
  );

  async function callApi(body: Record<string, unknown>): Promise<MessagesResponse> {
    // External API boundary: defensive — a non-2xx or malformed body becomes a
    // clear thrown error, never a fake empty answer.
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey!, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as MessagesResponse;
    if (!res.ok) {
      throw new Error(`anthropic driver: HTTP ${res.status} — ${parsed.error?.message ?? "unknown API error"}`);
    }
    if (!Array.isArray(parsed.content)) {
      throw new Error("anthropic driver: response has no content array — refusing to grade a malformed reply");
    }
    return parsed;
  }

  return {
    modelId,
    async ask({ system, context, question, retriever }: AskArgs): Promise<AskResult> {
      const messages: Array<Record<string, unknown>> = [
        { role: "user", content: `${context}\n\n---\n\n${question}` },
      ];
      let retrievalError: string | null = null;

      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const body: Record<string, unknown> = {
          model: modelId,
          max_tokens: 1024,
          temperature: 0, // pinned inference (A#3) — the report stamps it
          system,
          messages,
        };
        if (retriever !== null) body.tools = [CCR_TOOL];

        const res = await callApi(body);
        if (res.stop_reason !== "tool_use") {
          const text = res.content!
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text!)
            .join("\n");
          return { text, ccrRetrievals: retriever?.retrievals() ?? 0, retrievalError };
        }

        assert(retriever !== null, "anthropic driver: tool_use stop without a retriever — tools are only offered on the funnel arm");
        messages.push({ role: "assistant", content: res.content });
        const results: Array<Record<string, unknown>> = [];
        for (const block of res.content!) {
          if (block.type !== "tool_use") continue;
          const marker = typeof block.input?.marker === "string" ? block.input.marker : "";
          try {
            results.push({ type: "tool_result", tool_use_id: block.id, content: retriever.retrieve(marker) });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof CcrBudgetExhaustedError) retrievalError = msg;
            results.push({ type: "tool_result", tool_use_id: block.id, content: msg, is_error: true });
          }
        }
        messages.push({ role: "user", content: results });
      }
      throw new Error(`anthropic driver: exceeded ${MAX_TOOL_ITERATIONS} tool iterations on one question — the model is looping; abort rather than burn spend`);
    },
  };
}
