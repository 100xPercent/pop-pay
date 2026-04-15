// Anthropic adapter. Uses @anthropic-ai/sdk — NOT a hard dep; loaded via
// dynamic require so the harness still works when the package is absent.
//
// Install before the cross-model sweep:
//   npm install --save-dev @anthropic-ai/sdk

import type { PaymentIntent, GuardrailPolicy } from "../../../src/core/models.js";
import type { ProviderAdapter, BenchEvalResult } from "./types.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

const RETRIABLE = new Set([429, 500, 502, 503, 504, 529]);

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic" as const;
  readonly modelId: string;
  private client: any;

  constructor(opts: { apiKey: string; model: string }) {
    let Anthropic: any;
    try {
      Anthropic = require("@anthropic-ai/sdk").default ?? require("@anthropic-ai/sdk").Anthropic;
    } catch {
      throw new Error(
        "[@anthropic-ai/sdk] not installed. Run: npm install --save-dev @anthropic-ai/sdk",
      );
    }
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.modelId = opts.model;
  }

  async evaluate(intent: PaymentIntent, policy: GuardrailPolicy): Promise<BenchEvalResult> {
    const user = buildUserPrompt(intent, policy);
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await this.client.messages.create({
          model: this.modelId,
          max_tokens: 256,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: user }],
        });
        const block = (resp.content ?? []).find((b: any) => b.type === "text");
        const text = block?.text ?? "";
        const jsonStart = text.indexOf("{");
        const jsonEnd = text.lastIndexOf("}");
        const slice = jsonStart >= 0 && jsonEnd > jsonStart ? text.slice(jsonStart, jsonEnd + 1) : text;
        const parsed = JSON.parse(slice);
        return { approved: parsed.approved === true, reason: parsed.reason ?? "unknown", raw: parsed };
      } catch (e: any) {
        const status = e?.status ?? e?.statusCode;
        if (status && RETRIABLE.has(status)) {
          await new Promise((r) => setTimeout(r, Math.min(2 ** attempt * 1000, 10000)));
          continue;
        }
        return { approved: false, reason: `anthropic adapter error: ${e?.message ?? e}` };
      }
    }
    return { approved: false, reason: "anthropic adapter: max retries exceeded" };
  }
}
