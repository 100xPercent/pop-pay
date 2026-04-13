---
name: pop-pay
version: "0.5.4"
description: "Runtime security layer for AI agent commerce — card credentials inject directly into the browser DOM via CDP, never entering the agent's context window. No SaaS, no login, fully local."
homepage: https://github.com/100xPercent/pop-pay
author: A Hundred Percent Inc.
license: MIT
runtime: node
requires:
  node: ">=18"
  bins:
    - pop-pay
    - pop-launch
    - pop-init-vault
    - pop-unlock
  env:
    - POP_CDP_URL
    - POP_ALLOWED_CATEGORIES
    - POP_MAX_PER_TX
    - POP_MAX_DAILY
    - POP_GUARDRAIL_ENGINE
    - POP_AUTO_INJECT
    - POP_BLOCK_LOOPS
---

## What This Skill Does

Gives your OpenClaw agent the ability to pay at any online store using **your own existing credit card**. The card number is stored in a **local encrypted vault** (AES-256-GCM) and is **never placed in the agent's context window**. When a payment is approved, credentials are injected directly into the checkout form via **Chrome DevTools Protocol (CDP)** in a separate local process — if the agent is compromised by prompt injection, the attacker cannot steal the card it never saw.

Tagline: _it only takes **0.1%** of hallucination to drain **100%** of your wallet._

---

## Privacy & Data Flow

All payment logic runs **on your machine**. There are no Point One Percent / A Hundred Percent Inc. servers in the payment path.

| Component | Default | Data stays |
|---|---|---|
| Card credentials | Local encrypted vault (`~/.config/pop-pay/vault.enc`) | Your machine only |
| Spend policy | `~/.config/pop-pay/.env` | Your machine only |
| Guardrail engine | `keyword` mode (zero API calls) | Your machine only |
| Guardrail engine (optional) | `llm` mode — uses your own API key | Your chosen provider |

---

## Setup (One Time)

Install from npm (https://www.npmjs.com/package/pop-pay):

```bash
# No install needed — run on demand via npx
npx -y pop-pay pop-init-vault
```

Or install globally:

```bash
npm install -g pop-pay
pop-init-vault
```

For stronger protection (recommended — blocks any agent with shell access):

```bash
npx -y pop-pay pop-init-vault --passphrase   # one-time setup
npx -y pop-pay pop-unlock                     # run once before each session
```

Add to your OpenClaw MCP config (or `~/.openclaw/mcp_servers.json`):

```json
{
  "mcpServers": {
    "pop-pay": {
      "command": "npx",
      "args": ["-y", "pop-pay", "launch-mcp"],
      "env": {
        "POP_CDP_URL": "http://localhost:9222"
      }
    }
  }
}
```

Or via the OpenClaw CLI:

```bash
openclaw mcp add pop-pay -- npx -y pop-pay launch-mcp
```

Then launch Chrome with CDP:

```bash
npx -y pop-pay launch
```

---

## Installed Binaries

| Bin | Purpose |
|---|---|
| `pop-pay` | Main CLI entry (subcommands: `launch-mcp`, `launch`, `pop-init-vault`, `pop-unlock`) |
| `pop-launch` | Shortcut for `pop-pay launch` (starts Chrome with CDP) |
| `pop-init-vault` | Initialize the encrypted credential vault |
| `pop-unlock` | Unlock the vault with your passphrase for the current session |

---

## MCP Tools

### `request_virtual_card`

**When to call**: You are on a checkout/payment page and credit card input fields are visible.

Parameters:
- `requested_amount` (number, USD) — exact amount shown on screen
- `target_vendor` (string) — e.g. `"Amazon"` (NOT a URL)
- `reasoning` (string) — why this purchase should happen
- `page_url` (string) — current checkout page URL

Behavior:
- Evaluates purchase against spend policy (amount, daily cap, allowlist)
- Runs a guardrail check (SHOULD vs CAN) — keyword or LLM mode
- Scans the page for hidden prompt injections before issuing the card
- If approved, injects credentials directly into the form via CDP — never passed to the agent
- Returns `approved` (with last 4 digits) or `rejected` (with reason)

After approval: click Submit / Place Order. Card has already been filled.

---

### `request_purchaser_info`

**When to call**: You are on a billing/contact form with name, email, phone, or address fields but no credit card fields yet.

Parameters:
- `target_vendor` (string)
- `page_url` (string)
- `reasoning` (string)

Injects name, email, phone, address from the user's stored profile. Does NOT issue a card, does NOT charge, does NOT affect the budget.

---

### `request_x402_payment`

**When to call**: Paying for an API call that returns HTTP 402 under the x402 protocol.

Parameters:
- `endpoint` (string) — the API URL that returned 402
- `amount` (number, USD)
- `reasoning` (string)

Handles the x402 handshake and payment without exposing credentials to the agent.

---

## Usage Flow

```
Agent navigates to product page
  ↓
Clicks "Checkout" / "Proceed to payment"
  ↓
[If billing page first]
  → request_purchaser_info(vendor, page_url, reasoning)
  → click Continue
  ↓
[Payment/card fields visible]
  → request_virtual_card(amount, vendor, reasoning, page_url)
     (injection scan runs inside this call)
  ↓
[Approved]
  → click Submit / Place Order
```

---

## Security Model

| Layer | Defense |
|---|---|
| Context isolation | Card credentials never enter the agent's context window or logs |
| Encrypted vault | AES-256-GCM with XOR-split salt and native scrypt key derivation (Rust, via napi-rs) |
| TOCTOU guard | Domain verified at the moment of CDP injection — blocks redirect attacks |
| Repr redaction | Automatic masking (`****-4242`) in all MCP responses, logs, and tracebacks |
| Prompt-injection scan | Automatic on every `request_virtual_card` / `request_purchaser_info` call |

Full STRIDE analysis: [THREAT_MODEL.md](https://github.com/100xPercent/pop-pay/blob/main/docs/THREAT_MODEL.md)

---

## Spend Policy Reference

| Env var | Default | Description |
|---|---|---|
| `POP_CDP_URL` | `http://localhost:9222` | Chrome DevTools Protocol endpoint |
| `POP_ALLOWED_CATEGORIES` | `["aws","cloudflare"]` | JSON array of allowed vendor categories |
| `POP_MAX_PER_TX` | `100.0` | Max USD per transaction |
| `POP_MAX_DAILY` | `500.0` | Max USD per day |
| `POP_GUARDRAIL_ENGINE` | `keyword` | `keyword` (zero-cost) or `llm` (semantic) |
| `POP_AUTO_INJECT` | `true` | Enable CDP card injection |
| `POP_BLOCK_LOOPS` | `true` | Block hallucination/retry loops |

Full reference: [ENV_REFERENCE.md](https://github.com/100xPercent/pop-pay/blob/main/docs/ENV_REFERENCE.md)

---

## Providers

| Provider | Description |
|---|---|
| **BYOC** (default) | Bring Your Own Card — encrypted vault + local CDP injection |
| **Stripe Issuing** | Real virtual cards via Stripe API (`POP_STRIPE_KEY`) |
| **Lithic** | Multi-issuer adapter |
| **Mock** | Test mode for development |

Priority: Stripe Issuing → BYOC Local → Mock.

---

## Links

- npm: https://www.npmjs.com/package/pop-pay
- GitHub: https://github.com/100xPercent/pop-pay
- MCP Registry: `io.github.100xPercent/pop-pay`
- License: MIT
