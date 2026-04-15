// POP_BENCH_* dispatcher. Reads bench-only env (never POP_LLM_*) and returns
// the set of ProviderAdapters the harness can sweep across.
//
// Env schema:
//   POP_BENCH_ANTHROPIC_API_KEY   POP_BENCH_ANTHROPIC_MODEL
//   POP_BENCH_OPENAI_API_KEY      POP_BENCH_OPENAI_MODEL      POP_BENCH_OPENAI_BASE_URL
//   POP_BENCH_GEMINI_API_KEY      POP_BENCH_GEMINI_MODEL      POP_BENCH_GEMINI_BASE_URL
//   POP_BENCH_OLLAMA_BASE_URL     POP_BENCH_OLLAMA_MODEL      (key unused)
//
// Each block is independent: if one provider's env is set, that adapter is
// included. Empty set = no sweep (harness falls back to POP_LLM_* engine
// path used by the baseline runs).

import type { ProviderAdapter } from "./types.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { AnthropicAdapter } from "./anthropic.js";

export function resolveBenchAdapters(): ProviderAdapter[] {
  const adapters: ProviderAdapter[] = [];

  const aKey = process.env.POP_BENCH_ANTHROPIC_API_KEY;
  const aModel = process.env.POP_BENCH_ANTHROPIC_MODEL;
  if (aKey && aModel) adapters.push(new AnthropicAdapter({ apiKey: aKey, model: aModel }));

  const oKey = process.env.POP_BENCH_OPENAI_API_KEY;
  const oModel = process.env.POP_BENCH_OPENAI_MODEL;
  if (oKey && oModel) {
    adapters.push(
      new OpenAICompatAdapter({
        name: "openai",
        apiKey: oKey,
        model: oModel,
        baseUrl: process.env.POP_BENCH_OPENAI_BASE_URL,
      }),
    );
  }

  const gKey = process.env.POP_BENCH_GEMINI_API_KEY;
  const gModel = process.env.POP_BENCH_GEMINI_MODEL;
  const gUrl = process.env.POP_BENCH_GEMINI_BASE_URL;
  if (gKey && gModel && gUrl) {
    adapters.push(
      new OpenAICompatAdapter({ name: "gemini", apiKey: gKey, model: gModel, baseUrl: gUrl }),
    );
  }

  const olUrl = process.env.POP_BENCH_OLLAMA_BASE_URL;
  const olModel = process.env.POP_BENCH_OLLAMA_MODEL;
  if (olUrl && olModel) {
    adapters.push(
      new OpenAICompatAdapter({
        name: "ollama",
        apiKey: "not-needed",
        model: olModel,
        baseUrl: olUrl,
      }),
    );
  }

  return adapters;
}

export function describeAdapters(adapters: ProviderAdapter[]): string {
  if (adapters.length === 0) return "(none — POP_BENCH_* unset)";
  return adapters.map((a) => `${a.name}:${a.modelId}`).join(", ");
}

export type { ProviderAdapter, BenchEvalResult } from "./types.js";
