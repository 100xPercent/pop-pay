# Bench adapters — cross-model Layer-2 sweep

Scaffolded 2026-04-14 for the benchmark cross-model comparison. Separate from
the engine (`src/engine/llm-guardrails.ts`) by design: engine reads
`POP_LLM_*`, bench reads `POP_BENCH_*`. No shared env keys.

## Files

| File | Role |
|---|---|
| `types.ts` | `ProviderAdapter` interface — every provider exposes `evaluate(intent, policy) → {approved, reason}` |
| `prompt.ts` | Shared Layer-2 prompt (v2). MUST stay byte-identical to `src/engine/llm-guardrails.ts` |
| `openai-compat.ts` | OpenAI SDK adapter — serves OpenAI proper, Gemini (OpenAI-compat), Ollama (OpenAI-compat `/v1`) |
| `anthropic.ts` | Anthropic SDK adapter. Requires `npm install --save-dev @anthropic-ai/sdk` |
| `index.ts` | `resolveBenchAdapters()` — reads `POP_BENCH_*` env and returns the ordered set |

## Usage (when keys arrive)

```bash
export POP_BENCH_ANTHROPIC_API_KEY=sk-ant-...
export POP_BENCH_ANTHROPIC_MODEL=claude-haiku-4-5-20251001

export POP_BENCH_OPENAI_API_KEY=sk-...
export POP_BENCH_OPENAI_MODEL=gpt-4o-mini

export POP_BENCH_GEMINI_API_KEY=AI...
export POP_BENCH_GEMINI_MODEL=gemini-2.5-flash
export POP_BENCH_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/

export POP_BENCH_OLLAMA_BASE_URL=http://localhost:11434/v1   # optional
export POP_BENCH_OLLAMA_MODEL=llama3.1:8b-instruct

POP_REDTEAM=1 npx tsx tests/redteam/run-corpus.ts --n=5 --concurrency=15 --model-sweep
```

`--model-sweep` is parsed by `run-corpus.ts` and iterates the set returned by
`resolveBenchAdapters()`. Each row is tagged with `model_id`
(`provider:modelId`) so the aggregated report splits per-model metrics.

## Status

- Adapter classes: implemented, unit-tested locally via interface check only
- `resolveBenchAdapters()` dispatcher: implemented
- `--model-sweep` CLI wiring in `run-corpus.ts`: **TODO** (scheduled when Step 2 completes)
- `@anthropic-ai/sdk` dev-dep: **NOT yet installed** — install when Anthropic key arrives
- No API calls have been made from this code path yet
