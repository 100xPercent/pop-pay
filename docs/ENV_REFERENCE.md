# Environment Variable Reference

All `POP_*` environment variables for pop-pay. Set in `~/.config/pop-pay/.env` or export in shell.

## Guardrail Policy

| Variable | Default | Description |
|----------|---------|-------------|
| `POP_ALLOWED_CATEGORIES` | `[]` | JSON array of allowed vendor keywords |
| `POP_MAX_PER_TX` | *(required)* | Max amount per transaction (USD) |
| `POP_MAX_DAILY` | *(required)* | Max total spend per day (USD) |
| `POP_BLOCK_LOOPS` | `true` | Block repeated identical purchase attempts |
| `POP_PURCHASER_INFO_BLOCKING` | `true` | When `true` (default, zero-trust), `request_purchaser_info` rejects vendors not in `POP_ALLOWED_CATEGORIES`. When set to any other string (e.g. `false`), the vendor allowlist becomes advisory — the bypass is recorded in `audit_log` with `outcome='blocked_bypassed'`. Security scan and domain-mismatch checks are NEVER bypassed. |
| `POP_EXTRA_BLOCK_KEYWORDS` | `""` | Comma-separated extra keywords to block |
| `POP_GUARDRAIL_ENGINE` | `keyword` | `keyword` (local) or `llm` (semantic) |
| `POP_REQUIRE_HUMAN_APPROVAL` | `false` | Require human confirmation before every payment |

## LLM Guardrail (opt-in)

| Variable | Default | Description |
|----------|---------|-------------|
| `POP_LLM_API_KEY` | `""` | API key for LLM guardrail |
| `POP_LLM_BASE_URL` | *(none)* | Custom base URL (Ollama, vLLM, OpenRouter) |
| `POP_LLM_MODEL` | `gpt-4o-mini` | Model name |

## Card Credentials (auto-loaded from encrypted vault, NOT from .env)

| Variable | Default | Description |
|----------|---------|-------------|
| `POP_BYOC_NUMBER` | *(from vault)* | Card number — auto-set at startup from vault.enc |
| `POP_BYOC_CVV` | *(from vault)* | CVV — auto-set at startup |
| `POP_BYOC_EXP_MONTH` | *(from vault)* | Exp month — auto-set at startup |
| `POP_BYOC_EXP_YEAR` | *(from vault)* | Exp year — auto-set at startup |

> These are set as `process.env` defaults in the MCP server at startup.
> Users never need to set these manually — `npx pop-init-vault` handles it.

## Billing Info

| Variable | Default | Description |
|----------|---------|-------------|
| `POP_BILLING_FIRST_NAME` | `""` | Billing first name |
| `POP_BILLING_LAST_NAME` | `""` | Billing last name |
| `POP_BILLING_STREET` | `""` | Street address |
| `POP_BILLING_CITY` | `""` | City |
| `POP_BILLING_STATE` | `""` | State (2-letter code auto-expands: CA → California) |
| `POP_BILLING_ZIP` | `""` | Zip / postal code |
| `POP_BILLING_COUNTRY` | `""` | Country |
| `POP_BILLING_EMAIL` | `""` | Email |
| `POP_BILLING_PHONE` | `""` | Phone (E.164) |
| `POP_BILLING_PHONE_COUNTRY_CODE` | `""` | Dial code (e.g. +1) |

## Browser / CDP

| Variable | Default | Description |
|----------|---------|-------------|
| `POP_CDP_URL` | `http://localhost:9222` | Chrome DevTools Protocol endpoint |
| `POP_AUTO_INJECT` | `false` | Auto-inject card after guardrail approval |
| `POP_BLACKOUT_MODE` | `after` | `before` / `after` / `off` — screenshot masking timing |
| `POP_ALLOWED_PAYMENT_PROCESSORS` | *(built-in)* | Extra allowed domains for TOCTOU |

## Webhooks / Approval

| Variable | Default | Description |
|----------|---------|-------------|
| `POP_WEBHOOK_URL` | *(disabled)* | POST payment notifications (Slack/Teams) |
| `POP_APPROVAL_WEBHOOK` | *(disabled)* | POST approval requests; expects `{"approved": bool}` (120s timeout) |

## Enterprise / Stripe

| Variable | Default | Description |
|----------|---------|-------------|
| `POP_STRIPE_KEY` | *(none)* | Stripe API key for virtual card issuing |

## x402 (experimental)

| Variable | Default | Description |
|----------|---------|-------------|
| `POP_X402_WALLET_KEY` | *(none)* | Wallet key for x402 micropayments (stubbed) |
