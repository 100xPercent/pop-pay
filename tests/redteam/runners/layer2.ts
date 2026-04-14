// Layer-2 runner. Engine reads its OWN env (POP_LLM_*). Harness does NOT read ~/.config/pop-pay/.env.
// If no LLM is configured (detected by a missing POP_LLM_API_KEY and no OPENAI_API_KEY in process.env),
// verdict is "skip" and the caller should tag the run as requires:llm unavailable.

import { LLMGuardrailEngine } from "../../../src/engine/llm-guardrails.js";
import type { AttackPayload, RunnerResult } from "../types.js";

let cachedEngine: LLMGuardrailEngine | null = null;
let cachedAvailable: boolean | null = null;

function llmAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  const key = process.env.POP_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
  cachedAvailable = Boolean(key);
  return cachedAvailable;
}

function getEngine(): LLMGuardrailEngine {
  if (cachedEngine) return cachedEngine;
  cachedEngine = new LLMGuardrailEngine({
    apiKey: process.env.POP_LLM_API_KEY ?? process.env.OPENAI_API_KEY,
    baseUrl: process.env.POP_LLM_BASE_URL,
    model: process.env.POP_LLM_MODEL ?? "gpt-4o-mini",
  });
  return cachedEngine;
}

export async function runLayer2(p: AttackPayload): Promise<RunnerResult> {
  if (!llmAvailable()) {
    return { runner: "layer2", verdict: "skip", reason: "no LLM configured (requires:llm)", latency_ms: 0 };
  }
  const start = performance.now();
  try {
    const engine = getEngine();
    const [approved, reason] = await engine.evaluateIntent(
      {
        agentId: `redteam-${p.id}`,
        requestedAmount: p.amount,
        targetVendor: p.vendor,
        reasoning: p.reasoning,
        pageUrl: p.page_url,
      },
      {
        allowedCategories: p.allowed_categories,
        maxAmountPerTx: 1_000_000,
        maxDailyBudget: 1_000_000,
        blockHallucinationLoops: true,
        webhookUrl: null,
      },
    );
    return {
      runner: "layer2",
      verdict: approved ? "approve" : "block",
      reason,
      latency_ms: performance.now() - start,
    };
  } catch (e: any) {
    return {
      runner: "layer2",
      verdict: "error",
      reason: String(e?.message ?? e),
      latency_ms: performance.now() - start,
      error: String(e?.stack ?? e),
    };
  }
}
