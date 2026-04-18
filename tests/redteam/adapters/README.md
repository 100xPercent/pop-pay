# Bench adapters — cross-model Layer-2 sweep

Scaffolded 2026-04-14 for the benchmark cross-model comparison. Separate from
the engine (`src/engine/llm-guardrails.ts`) by design: engine reads
`POP_LLM_*`, bench reads `POP_BENCH_*`. No shared env keys.

## Files

| File | Role |
|---|---|
| `types.ts` | `ProviderAdapter` interface — every provider exposes `evaluate(intent, policy) → {approved, reason}` |
| `prompt.ts` | Shared Layer-2 prompt (v3). MUST stay byte-identical to `src/engine/llm-guardrails.ts` |
| `openai-compat.ts` | OpenAI SDK adapter — serves OpenAI proper, Gemini (OpenAI-compat), Ollama (OpenAI-compat `/v1`) |
| `anthropic.ts` | Anthropic SDK adapter (`@anthropic-ai/sdk` dev-dep) |
| `index.ts` | `resolveBenchAdapters()` — reads `POP_BENCH_*` env and returns the ordered set |

## Usage

```bash
export POP_BENCH_ANTHROPIC_API_KEY=sk-ant-...
export POP_BENCH_ANTHROPIC_MODEL=claude-haiku-4-5-20251001

export POP_BENCH_OPENAI_API_KEY=sk-...
export POP_BENCH_OPENAI_MODEL=gpt-4o-mini

export POP_BENCH_GEMINI_API_KEY=AI...
export POP_BENCH_GEMINI_MODEL=gemini-2.5-flash
export POP_BENCH_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/

export POP_BENCH_OLLAMA_BASE_URL=http://localhost:11434/v1
export POP_BENCH_OLLAMA_MODEL=gemma4:e2b-it-q4_K_M

POP_REDTEAM=1 npx tsx tests/redteam/run-corpus.ts --n=5 --concurrency=15 --model-sweep
```

`--model-sweep` iterates the set returned by `resolveBenchAdapters()`. Each
row is tagged with `model_id` (`provider:modelId`) so the aggregated report
splits per-model metrics. Use `--only=<provider>` to restrict to a single
provider (e.g., `--only=ollama`).

## Provider architecture

Provider discovery is **env-driven, not auto-discovered**. `resolveBenchAdapters()`
in `index.ts` checks each provider's env block; if the required keys are set,
that adapter is included in the sweep. If a provider's env is unset, it is
silently skipped.

| Provider | Required env | Adapter class | Notes |
|---|---|---|---|
| Anthropic | `POP_BENCH_ANTHROPIC_API_KEY` + `_MODEL` | `AnthropicAdapter` | Uses Anthropic SDK (non-OpenAI protocol) |
| OpenAI | `POP_BENCH_OPENAI_API_KEY` + `_MODEL` | `OpenAICompatAdapter` | Optional `_BASE_URL` |
| Gemini | `POP_BENCH_GEMINI_API_KEY` + `_MODEL` + `_BASE_URL` | `OpenAICompatAdapter` | Via Google's OpenAI-compat endpoint |
| Ollama | `POP_BENCH_OLLAMA_BASE_URL` + `_MODEL` | `OpenAICompatAdapter` | No API key needed (local) |

### Adding a new provider

If the new provider exposes an **OpenAI-compatible API** (most do):

1. Add an env block in `index.ts` (~5 lines):
   ```ts
   const xKey = process.env.POP_BENCH_NEWPROVIDER_API_KEY;
   const xModel = process.env.POP_BENCH_NEWPROVIDER_MODEL;
   if (xKey && xModel) {
     adapters.push(new OpenAICompatAdapter({ name: "newprovider", apiKey: xKey, model: xModel, baseUrl: process.env.POP_BENCH_NEWPROVIDER_BASE_URL }));
   }
   ```
2. Add the provider name to the `ProviderName` union in `types.ts`.
3. Export the env vars and run `--model-sweep`.

If the provider uses a **non-OpenAI protocol** (e.g., Anthropic Messages API):

1. Create a new adapter class implementing `ProviderAdapter` (see `anthropic.ts` as reference).
2. Add the env block in `index.ts`.
3. Add the provider name to `ProviderName` in `types.ts`.

### Removing a provider

Do not export that provider's `POP_BENCH_*` env vars. No code change needed.

## Status

- All four provider adapters implemented and verified via v1.0 benchmark (2026-04-17)
- `--model-sweep` and `--only=<provider>` CLI flags operational
- `@anthropic-ai/sdk` installed as dev-dep
- v1.0 benchmark produced 14,625 rows across 4 models with 0 adapter-level errors
