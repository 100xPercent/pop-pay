# pop-pay

**Point One Percent** — Semantic Payment Guardrail for AI Agents.

> It only takes 0.1% of hallucination to drain 100% of your wallet.

TypeScript + Rust implementation of the pop-pay runtime security layer for AI agent commerce.

## Features

- **Vault**: AES-256-GCM encrypted credential storage with Rust native security layer
- **Guardrails**: Keyword + LLM-based payment intent validation
- **MCP Server**: Model Context Protocol server for AI agent integration
- **Providers**: Stripe Issuing, BYOC (Bring Your Own Card), Mock
- **Security Scan**: Prompt injection detection on checkout pages

## Installation

```bash
npm install pop-pay
```

## Quick Start

```bash
# Initialize vault
pop-init-vault

# Launch MCP server
pop-launch
```

## License

MIT
