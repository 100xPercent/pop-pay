# pop-pay

**The runtime security layer for AI agent commerce.**

> It only takes 0.1% of hallucination to drain 100% of your wallet.

pop-pay prevents autonomous AI agents from leaking card data, making hallucinated purchases, or falling for prompt injection on checkout pages. It sits between the agent and the payment — enforcing intent verification, credential isolation, and domain-level trust boundaries.

## How It Works

```
Agent calls request_virtual_card() via MCP
     ↓
Intent Verification Engine (keyword + LLM guardrails)
     ↓
Encrypted Vault (AES-256-GCM, Rust napi-rs native layer)
     ↓
CDP Injection (card data injected directly into browser DOM)
     ↓
Agent never sees raw card data — only ****-4242
```

## Security Properties

- **Context Isolation**: Card credentials never enter the agent's LLM context. Injected via CDP directly into the browser DOM, including cross-origin iframes and Shadow DOM.
- **Semantic Guardrails**: Hybrid keyword + LLM intent verification achieves [95% accuracy](docs/GUARDRAIL_BENCHMARK.md) across 20 attack scenarios. Detects prompt injection, hallucination loops, and anomalous purchases.
- **TOCTOU Domain Guard**: Verifies the checkout page domain matches the approved vendor at injection time. Known payment processor passthrough (Stripe, PayPal, Square, Adyen, etc.).
- **Encrypted Vault**: AES-256-GCM with scrypt key derivation. Hardened builds compile salt into a stripped Rust native binary (XOR-split).
- **Burn-After-Use**: Each virtual card seal is single-use. Second attempt is rejected.

For a complete security analysis, see the [Threat Model](docs/THREAT_MODEL.md).

## Installation

```bash
npm install pop-pay
```

## Quick Start

```bash
# 1. Initialize encrypted vault
pop-init-vault

# 2. Launch Chrome with CDP
pop-launch --print-mcp

# 3. Add to Claude Code
claude mcp add pop-pay -- npx pop-pay launch-mcp
```

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
| **BYOC** (default) | Bring Your Own Card — uses your encrypted vault credentials. |
| **Stripe Issuing** | Real virtual cards via Stripe Issuing API. |
| **Lithic** | Multi-issuer adapter skeleton (Stripe Issuing / Lithic). |
| **Mock** | Test mode with generated card numbers. |

## Configuration

Set policy via `~/.config/pop-pay/.env`:

```bash
POP_ALLOWED_CATEGORIES=["aws", "cloudflare", "openai", "github"]
POP_MAX_PER_TX=100.0
POP_MAX_DAILY=500.0
POP_BLOCK_LOOPS=true
POP_AUTO_INJECT=true
POP_CDP_URL=http://localhost:9222
```

## Docker

```bash
docker-compose up -d
```

Runs pop-pay MCP server + headless Chromium with CDP. Mount your encrypted vault from the host.

## Architecture

- **TypeScript** — MCP server, CDP injection engine, guardrails, CLI
- **Rust (napi-rs)** — Native security layer: XOR-split salt storage, scrypt key derivation
- **Node.js crypto** — AES-256-GCM vault encryption (OpenSSL binding)
- **Chrome DevTools Protocol** — Direct DOM injection via raw WebSocket

## Documentation

- [Threat Model](docs/THREAT_MODEL.md) — STRIDE analysis, 5 security primitives, 10 attack scenarios
- [Guardrail Benchmark](docs/GUARDRAIL_BENCHMARK.md) — 95% accuracy across 20 test scenarios, competitive comparison

## License

MIT
