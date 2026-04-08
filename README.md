[![npm version](https://img.shields.io/npm/v/pop-pay.svg)](https://www.npmjs.com/package/pop-pay) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![CI](https://github.com/TPEmist/pop-pay/actions/workflows/ci.yml/badge.svg)](https://github.com/TPEmist/pop-pay/actions/workflows/ci.yml) [![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

<p align="center">
    <picture>
        <img src="https://raw.githubusercontent.com/TPEmist/pop-pay-python/main/project_banner.png" alt="Point One Percent (AgentPay)" width="800">
    </picture>
</p>

# Point One Percent — pop-pay
<p align="left"><i>it only takes <b>0.1%</b> of Hallucination to drain <b>100%</b> of your wallet.</i></p>

### The runtime security layer for AI agent commerce.

> Your card never enters the agent's context. One hallucinated prompt can't drain a wallet it can't see.

<p align="center">
  <img src="https://raw.githubusercontent.com/TPEmist/pop-pay-python/main/assets/runtime_demo.gif" alt="Point One Percent — live CDP injection demo" width="800">
</p>

pop-pay is an open-source (MIT) runtime security layer that protects AI agents during online purchases. It works with OpenClaw, NemoClaw, Claude Code, OpenHands, and any MCP-compatible framework.

## Architecture: Five Security Primitives

| Primitive | What it does |
|-----------|-------------|
| **Context Isolation Layer** | Card credentials are injected directly into the browser DOM via CDP — they never enter the agent's process or LLM context window. Prompt injection can't steal what the agent doesn't have. |
| **Intent Verification Engine** | Hybrid keyword + LLM guardrail evaluates whether a purchase *should* happen — not just whether it *can*. [95% accuracy on 20-scenario benchmark.](./docs/GUARDRAIL_BENCHMARK.md) |
| **Human Trust Anchor** | Configurable human-in-the-loop approval for high-value or unrecognized transactions. |
| **Zero-Knowledge Card Surface** | Agent only sees masked tokens (`****-4242`). Real data is stored in an AES-256-GCM encrypted vault. |
| **Ephemeral Authorization Scope** | Each payment approval is single-use with TOCTOU domain guard — an approved session can't be redirected to a malicious merchant. |

> See [THREAT_MODEL.md](./docs/THREAT_MODEL.md) for the full STRIDE analysis and [COMPLIANCE_FAQ.md](./docs/COMPLIANCE_FAQ.md) for enterprise compliance details.

## Guardrail Benchmark

| Layer | Score | Notes |
|-------|-------|-------|
| Keyword only | 14/20 (70%) | Fast, zero-cost, catches obvious violations |
| **Hybrid (Keyword + LLM)** | **19/20 (95%)** | LLM resolves 5 of 6 keyword failures |

| Feature | AgentPayy | AgentWallet | Prava | **pop-pay** |
|---------|-----------|-------------|-------|------------|
| Enforcement | Mock alert() | Rule-based | Spending limits | **Semantic validation** |
| Intent check | None | Agent-provided text | None | **Context-aware LLM** |
| Injection-proof | No | No | No | **Yes** |

## Two Deployment Modes

### BYOC — Bring Your Own Card (Local)
The agent **never** receives the true card number — it only sees `****-4242`. When checkout is reached, the Context Isolation Layer attaches via CDP, traverses all cross-origin iframes (Stripe Elements, Adyen, etc.), and injects credentials directly into the DOM. Runs entirely on your machine via Node.js — no SaaS, no login, no external account.

### Enterprise — Stripe Issuing
For cloud-hosted AI fleets: programmatically issue single-use virtual cards via Stripe API, with per-agent budgets and full audit trails.

---

## Ecosystem Position

pop-pay is the agent's **Policy Enforcement Point** — it evaluates, approves, and injects. It does NOT navigate websites or solve CAPTCHAs — that's the browser agent's job.

### The Handshake: How Point One Percent and Browser Agents Work Together

The real power emerges when Point One Percent is paired with a browser automation agent (e.g., OpenHands, browser-use, Skyvern). The workflow is a clean division of labor:

```
1. [Browser Agent]  Navigates to a site, scrapes product info, reaches checkout.
        │
        │  (Hit a paywall / payment form)
        ▼
2. [Browser Agent → POP MCP]  Calls request_virtual_card(amount, vendor, reasoning)
        │
        │  (Point One Percent evaluates: budget OK? vendor approved? no hallucination?)
        ▼
3. [POP]  Issues a one-time virtual card (Stripe mode) or uses BYOC vault credentials.
            Full card credentials handled only by the local trusted process —
            never exposed to the agent or LLM context.
        │
        ▼
4. [POP]  Injects real credentials into the checkout form via CDP.
            The agent receives only a transaction confirmation — no card details.
        │
        ▼
5. [Browser Agent]  Clicks the submit button to complete the transaction.
        │
        ▼
6. [The Vault]  Logs the transaction. Card session is immediately burned.
```

### Supported Integrations

| Integration path | Works with |
|---|---|
| **MCP Tool** | Claude Code, OpenClaw, NemoClaw, OpenHands, any MCP-compatible host |
| **Node.js SDK** | Custom Playwright scripts, Puppeteer automation, gemini-cli |

> **Any browser-capable agent** (Claude Code, OpenClaw, browser-use, Skyvern, etc.) gets full CDP injection — card is auto-filled into the payment form, the agent only ever sees the masked confirmation (`****-****-****-4242`). See the **[Integration Guide](./docs/INTEGRATION_GUIDE.md)** for setup instructions and System Prompt templates.

---

## Installation

```bash
npm install pop-pay
```

## Quick Start for Claude Code / OpenHands

If you're using Claude Code, OpenHands, or any MCP-compatible agentic framework, you can get Point One Percent running in under 2 minutes:

### Step 1: Initialize the Credential Vault

Credentials are stored in an AES-256-GCM encrypted vault — no plaintext `.env` required.

```bash
npx pop-init-vault
```

This will prompt for your card credentials (input is hidden), encrypt them into `~/.config/pop-pay/vault.enc`, and securely wipe any existing `.env`. The MCP server auto-decrypts the vault at startup.

**Passphrase mode (stronger — protects against agents with shell access):**

```bash
npx pop-init-vault --passphrase   # one-time setup
npx pop-unlock                     # run once before each MCP server session
```

`pop-unlock` derives the key from your passphrase and stores it in the OS keyring. The MCP server reads it automatically at startup.

**Security levels (lowest → highest):**

| Mode | Protects against |
|---|---|
| `.env` file (legacy) | Nothing — plaintext on disk |
| Vault, machine key, OSS source | File-read agents |
| Vault, machine key, `npm install pop-pay` | File-read agents + casual shell inspection |
| Vault + passphrase | File-read agents + shell agents |
| Stripe Issuing (commercial) | All local threats — no credentials stored |

> **Policy & non-credential config** (allowed vendors, spending limits, CDP URL) is still read from `~/.config/pop-pay/.env`. Only card credentials moved to the vault.

### Step 2: Launch Chrome & Get MCP Commands

```bash
npx pop-launch --print-mcp
```

This launches Chrome with CDP enabled and prints the exact `claude mcp add` commands to run.

### Step 3: Add to Claude Code

```bash
claude mcp add pop-pay -- npx pop-pay launch-mcp
```

> `--scope user` (optional) stores the registration in `~/.claude.json` — available in every Claude Code session.

### Step 4: Configure Policy

Edit `~/.config/pop-pay/.env` to set your spending limits and allowed vendors:

| Variable | Default | Description |
|---|---|---|
| `POP_ALLOWED_CATEGORIES` | `["aws","cloudflare"]` | Vendors the agent is allowed to pay — see [Categories Cookbook](./docs/CATEGORIES_COOKBOOK.md) |
| `POP_MAX_PER_TX` | `100.0` | Max $ per transaction |
| `POP_MAX_DAILY` | `500.0` | Max $ per day |
| `POP_BLOCK_LOOPS` | `true` | Block hallucination/retry loops |
| `POP_AUTO_INJECT` | `true` | Enable CDP card injection |
| `POP_GUARDRAIL_ENGINE` | `keyword` | Guardrail engine: `keyword` (zero-cost, default) or `llm` (semantic, two-layer) — see [Guardrail Mode](#guardrail-mode-keyword-vs-llm) |
| `POP_BILLING_FIRST_NAME` / `POP_BILLING_LAST_NAME` | _(empty)_ | Auto-fill name fields on checkout pages |
| `POP_BILLING_EMAIL` | _(empty)_ | Auto-fill email |
| `POP_BILLING_PHONE` | _(empty)_ | E.164 format — auto-fill combined phone input |
| `POP_BILLING_PHONE_COUNTRY_CODE` | _(empty)_ | ISO code (`"US"`) or dial prefix (`"+1"`) — fills country code dropdown |
| `POP_BILLING_STREET` / `POP_BILLING_CITY` / `POP_BILLING_STATE` / `POP_BILLING_COUNTRY` / `POP_BILLING_ZIP` | _(empty)_ | Auto-fill address fields; state and country matched fuzzily |
| `POP_ALLOWED_PAYMENT_PROCESSORS` | `[]` | Extra third-party payment processor domains to trust (pop-pay ships with 20 built-in) |
| `POP_WEBHOOK_URL` | _(empty)_ | Webhook URL for Slack/Teams/PagerDuty notifications |

> **After editing `.env`, fully close and reopen Claude Code.** The MCP server loads configuration at startup — `!claude mcp list` alone is not sufficient to pick up `.env` changes.

#### Guardrail Mode: Keyword vs LLM

Point One Percent ships with two guardrail engines. You switch between them with a single env var:

| | `keyword` (default) | `llm` |
|---|---|---|
| **How it works** | Blocks requests whose `reasoning` string contains suspicious keywords (e.g. "retry", "failed again", "ignore previous instructions") | Sends the agent's `reasoning` to an LLM for deep semantic analysis |
| **What it catches** | Obvious loops, hallucination phrases, prompt injection attempts | Subtle off-topic purchases, logical inconsistencies, policy violations that keyword matching misses |
| **Cost** | Zero — no API calls, instant | One LLM call per `request_virtual_card` invocation |
| **Dependencies** | None | Any OpenAI-compatible endpoint |
| **Best for** | Development, low-risk workflows, cost-sensitive setups | Production, high-value transactions, untrusted agent pipelines |

> **Tip:** `keyword` mode requires no extra config. To enable LLM mode, see the [full configuration reference in the Integration Guide §1](./docs/INTEGRATION_GUIDE.md#guardrail-mode-configuration).

### Step 5: Use It

Your agent now has access to these tools:

| Tool | When to use |
|---|---|
| `request_purchaser_info` | Billing/contact info page (name, email, phone, address) — no card fields visible yet |
| `request_virtual_card` | Payment page — card fields are visible. Prompt injection scan runs automatically inside this call. |

**Single-page checkout** (e.g. Wikipedia donate): agent calls `request_virtual_card`.
**Two-page checkout** (e.g. billing info → payment): agent calls `request_purchaser_info` first, then `request_virtual_card`.

When it encounters a paywall:

```
Agent: "I need to purchase an API key from AWS for $15 to continue."
[Tool Call] request_virtual_card(amount=15.0, vendor="AWS", reasoning="Need API key for deployment")
[POP] Payment approved. Card Issued: ****4242, Expiry: 12/25, Amount: 15.0
Agent: "Purchase successful, continuing workflow."
```

If the agent hallucinates or tries to overspend:
```
Agent: "Let me retry buying compute... the previous attempt failed again."
[Tool Call] request_virtual_card(amount=50.0, vendor="AWS", reasoning="failed again, retry loop")
[POP] Payment rejected. Reason: Hallucination or infinite loop detected in reasoning
```

---

## Setup

**Standard config** works across most MCP-compatible tools:

```json
{
  "mcpServers": {
    "pop-pay": {
      "command": "npx",
      "args": ["-y", "pop-pay", "launch-mcp"],
      "env": {
        "POP_CDP_URL": "http://localhost:9222",
        "POP_ALLOWED_CATEGORIES": "[\"aws\",\"cloudflare\"]",
        "POP_MAX_PER_TX": "100.0",
        "POP_MAX_DAILY": "500.0",
        "POP_GUARDRAIL_ENGINE": "keyword"
      }
    }
  }
}
```

[<img src="https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20MCP%20Server&color=0098FF" alt="Install in VS Code">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522pop-pay%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522pop-pay%2522%252C%2522launch-mcp%2522%255D%252C%2522env%2522%253A%257B%2522POP_CDP_URL%2522%253A%2522http%253A%252F%252Flocalhost%253A9222%2522%257D%257D) [<img alt="Install in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-VS_Code_Insiders?style=flat-square&label=Install%20MCP%20Server&color=24bfa5">](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522pop-pay%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522pop-pay%2522%252C%2522launch-mcp%2522%255D%252C%2522env%2522%253A%257B%2522POP_CDP_URL%2522%253A%2522http%253A%252F%252Flocalhost%253A9222%2522%257D%257D)

<details>
<summary>Claude Code</summary>

```bash
claude mcp add pop-pay -- npx -y pop-pay launch-mcp
```

To configure spending limits and allowed vendors, set environment variables:

```bash
claude mcp add pop-pay \
  -e POP_CDP_URL=http://localhost:9222 \
  -e POP_ALLOWED_CATEGORIES='["aws","cloudflare"]' \
  -e POP_MAX_PER_TX=100.0 \
  -e POP_MAX_DAILY=500.0 \
  -e POP_GUARDRAIL_ENGINE=keyword \
  -- npx -y pop-pay launch-mcp
```

Add `--scope user` to make the registration available across all projects.

</details>

<details>
<summary>Cursor</summary>

[<img src="https://img.shields.io/badge/Cursor-Cursor?style=flat-square&label=Install%20MCP%20Server&color=5C2D91" alt="Install in Cursor">](cursor://anysphere.cursor-deeplink/mcp/install?name=pop-pay&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInBvcC1wYXkiLCJsYXVuY2gtbWNwIl0sImVudiI6eyJQT1BfQ0RQX1VSTCI6Imh0dHA6Ly9sb2NhbGhvc3Q6OTIyMiJ9fQ==)

Or add manually to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pop-pay": {
      "command": "npx",
      "args": ["-y", "pop-pay", "launch-mcp"],
      "env": {
        "POP_CDP_URL": "http://localhost:9222",
        "POP_ALLOWED_CATEGORIES": "[\"aws\",\"cloudflare\"]",
        "POP_MAX_PER_TX": "100.0",
        "POP_MAX_DAILY": "500.0",
        "POP_GUARDRAIL_ENGINE": "keyword"
      }
    }
  }
}
```

</details>

<details>
<summary>Windsurf</summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "pop-pay": {
      "command": "npx",
      "args": ["-y", "pop-pay", "launch-mcp"],
      "env": {
        "POP_CDP_URL": "http://localhost:9222",
        "POP_ALLOWED_CATEGORIES": "[\"aws\",\"cloudflare\"]",
        "POP_MAX_PER_TX": "100.0",
        "POP_MAX_DAILY": "500.0",
        "POP_GUARDRAIL_ENGINE": "keyword"
      }
    }
  }
}
```

</details>

<details>
<summary>VS Code (Copilot)</summary>

Add to `.vscode/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "pop-pay": {
      "command": "npx",
      "args": ["-y", "pop-pay", "launch-mcp"],
      "env": {
        "POP_CDP_URL": "http://localhost:9222",
        "POP_ALLOWED_CATEGORIES": "[\"aws\",\"cloudflare\"]",
        "POP_MAX_PER_TX": "100.0",
        "POP_MAX_DAILY": "500.0",
        "POP_GUARDRAIL_ENGINE": "keyword"
      }
    }
  }
}
```

</details>

<details>
<summary>OpenClaw / NemoClaw</summary>

pop-pay works as an MCP tool with OpenClaw and NemoClaw. Use the standard config above, or see the [Integration Guide §4](./docs/INTEGRATION_GUIDE.md) for detailed setup instructions and System Prompt templates.

</details>

<details>
<summary>Docker</summary>

```bash
docker-compose up -d
```

Runs pop-pay MCP server + headless Chromium with CDP. Mount your encrypted vault from the host. See `docker-compose.yml` for configuration.

</details>

> **Environment variables reference:** See [ENV_REFERENCE.md](./docs/ENV_REFERENCE.md) for the full list of `POP_*` variables (guardrail engine, LLM config, billing info, card credentials, webhooks, and more).

---

## MCP Tools

| Tool | Description |
|:---|:---|
| `request_virtual_card` | Issue a one-time virtual card for an automated purchase. Runs security scan on the checkout page. |
| `request_purchaser_info` | Auto-fill billing/contact info from pre-configured profile. |
| `request_x402_payment` | Pay for API calls via the x402 HTTP payment protocol. |
| `page_snapshot` | Security scan a checkout page for hidden prompt injections and anomalies. |

## Providers

| Provider | Description |
|:---|:---|
| **BYOC** (default) | Bring Your Own Card — uses your encrypted vault credentials for local CDP injection. |
| **Stripe Issuing** | Real virtual cards via Stripe Issuing API. Requires `POP_STRIPE_KEY`. |
| **Lithic** | Multi-issuer adapter skeleton (Stripe Issuing / Lithic). |
| **Mock** | Test mode with generated card numbers for development. |

**Provider priority (high → low):** Stripe Issuing → BYOC Local → Mock.

If `POP_STRIPE_KEY` is set, Stripe takes precedence. If `POP_BYOC_NUMBER` is set (but no Stripe key), `LocalVaultProvider` is used. If neither is set, `MockProvider` is used for development.

> **CDP injection limitation with Stripe Issuing:** The Stripe Issuing API returns only the last 4 digits of the card number for security reasons. CDP auto-injection (`POP_AUTO_INJECT=true`) requires the full PAN and therefore **does not work** with Stripe Issuing. Use BYOC (`POP_BYOC_NUMBER`) if you need CDP injection; use Stripe Issuing if you need a real card and will handle form submission yourself.

---

## Security Statement

Security is a first-class citizen in pop-pay. The SDK **masks card numbers by default** (e.g., `****-****-****-4242`) when returning authorization results to the agent.

**Defense-in-depth hardening:**

| Layer | Defense |
|---|---|
| **Encrypted vault** | Card credentials stored as AES-256-GCM ciphertext (`vault.enc`); plaintext never touches disk after `pop-init-vault` |
| **Passphrase mode** | Key derived from user passphrase via scrypt; stored in OS keyring — agents with shell access cannot derive the key |
| **Database** | SQLite only stores masked card (`****-4242`); `card_number` and `cvv` columns removed entirely |
| **Injection-time TOCTOU guard** | Domain verified against guardrail-approved vendor at the moment of injection — prevents redirect-to-attacker attacks |
| **Repr redaction** | Masked card output in all logs and responses; credentials cannot leak via tracebacks |
| **Process isolation** | Agent communicates via MCP JSON-RPC as a separate process — cannot access MCP server memory or env vars through the protocol |
| **Native security layer** | XOR-split salt storage and scrypt key derivation handled in a stripped Rust binary (napi-rs) |

See [THREAT_MODEL.md](./docs/THREAT_MODEL.md) for the full STRIDE analysis and red team results.

## Architecture

- **TypeScript** — MCP server, CDP injection engine, guardrails, CLI
- **Rust (napi-rs)** — Native security layer: XOR-split salt storage, scrypt key derivation
- **Node.js crypto** — AES-256-GCM vault encryption (OpenSSL binding)
- **Chrome DevTools Protocol** — Direct DOM injection via raw WebSocket

## Documentation

- [Threat Model](docs/THREAT_MODEL.md) — STRIDE analysis, 5 security primitives, 10 attack scenarios
- [Guardrail Benchmark](docs/GUARDRAIL_BENCHMARK.md) — 95% accuracy across 20 test scenarios, competitive comparison
- [Compliance FAQ](docs/COMPLIANCE_FAQ.md) — Enterprise security and PCI DSS/SOC 2/GDPR details
- [Environment Reference](docs/ENV_REFERENCE.md) — All POP_* environment variables
- [Integration Guide](docs/INTEGRATION_GUIDE.md) — Detailed setup for Claude Code, Node.js SDK, and browser agents
- [Categories Cookbook](docs/CATEGORIES_COOKBOOK.md) — POP_ALLOWED_CATEGORIES patterns and examples

## License

MIT
