// OpenAI-compat adapter. Serves: OpenAI proper, Gemini (OpenAI-compat
// endpoint), Ollama (OpenAI-compat /v1). Uses the same openai SDK already
// required by the engine — no new dep.

import type { PaymentIntent, GuardrailPolicy } from "../../../src/core/models.js";
import type { ProviderAdapter, ProviderName, BenchEvalResult } from "./types.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import { ProviderUnreachable, InvalidResponse, RetryExhausted } from "../../../src/errors.js";

const RETRIABLE = new Set([429, 500, 502, 503, 504]);

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly name: ProviderName;
  readonly modelId: string;
  private client: any;
  private useJsonMode: boolean;

  private requestTimeoutMs: number;

  constructor(opts: {
    name: ProviderName;
    apiKey: string;
    baseUrl?: string;
    model: string;
    useJsonMode?: boolean;
    requestTimeoutMs?: number;
  }) {
    const { default: OpenAI } = require("openai");
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      timeout: this.requestTimeoutMs,
    });
    this.name = opts.name;
    this.modelId = opts.model;
    this.useJsonMode = opts.useJsonMode ?? true;
  }

  async evaluate(intent: PaymentIntent, policy: GuardrailPolicy): Promise<BenchEvalResult> {
    const kwargs: any = {
      model: this.modelId,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(intent, policy) },
      ],
    };
    if (this.useJsonMode) kwargs.response_format = { type: "json_object" };

    const maxRetries = 15;
    let lastRetriable: unknown = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await this.client.chat.completions.create(kwargs, {
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        const text = resp.choices[0].message.content;
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch (pe: any) {
          throw new InvalidResponse(`JSON parse failed: ${pe?.message ?? pe}`, { cause: pe });
        }
        return { approved: parsed.approved === true, reason: parsed.reason ?? "unknown", raw: parsed };
      } catch (e: any) {
        if (e instanceof InvalidResponse) throw e;
        const status = e?.status ?? e?.statusCode;
        const isAbort =
          e?.name === "AbortError" ||
          e?.name === "TimeoutError" ||
          e?.code === "ABORT_ERR" ||
          /aborted|timeout/i.test(String(e?.message ?? ""));
        const transientName = e?.name === "APIConnectionError" || e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT";
        if ((status && RETRIABLE.has(status)) || transientName || isAbort) {
          lastRetriable = e;
          await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 20000)));
          continue;
        }
        throw new ProviderUnreachable(this.name, { cause: e });
      }
    }
    throw new RetryExhausted({ cause: lastRetriable });
  }
}
