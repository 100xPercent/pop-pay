# Security Policy

## Responsible Disclosure

At Point One Percent, we take the security of our runtime payment guardrails seriously. If you believe you have found a security vulnerability in `pop-pay`, please report it to us as described below.

## Reporting a Vulnerability

Please do **not** report security vulnerabilities via public GitHub issues.

1. **GitHub Security Advisories**: Use the [GitHub Security Advisory](https://github.com/100xPercent/pop-pay/security/advisories/new) reporting tool to submit a report privately.
2. **Email**: If you prefer, email us at [security@pop-pay.dev](mailto:security@pop-pay.dev).

## Scope

### In-Scope
We are particularly interested in vulnerabilities related to the core security primitives of `pop-pay`:
- **Vault Encryption**: Bypassing AES-256-GCM encryption or unauthorized access to `vault.enc`.
- **CDP Injection**: Vulnerabilities in the Chrome DevTools Protocol injection engine that could leak credentials to the agent process or unauthorized third parties.
- **Guardrail Bypass**: Systematic ways to bypass the Keyword or LLM guardrails (e.g., prompt injection that forces an unapproved purchase).
- **MCP Protocol**: Vulnerabilities in the Model Context Protocol implementation that could lead to privilege escalation.
- **TOCTOU Attacks**: Time-of-check to time-of-use vulnerabilities in domain verification.

### Out-of-Scope
- Vulnerabilities in the underlying browser (Chrome/Chromium).
- OS-level attacks (e.g., local root exploit to read memory).
- Social engineering or phishing.
- Theoretical vulnerabilities without a proof of concept.

## Bug Bounty Program

We operate a three-tier bounty. Submissions are triaged against these definitions; a single report may cross tiers, in which case the highest qualifying tier applies.

### Tier 1 — Guardrail Bypass ($500 + Hall of Fame)

**Scope**: A reproducible prompt-injection, TOCTOU, or policy-evasion path that causes `request_virtual_card` or the approval webhook to authorize a payment in violation of the configured `GuardrailPolicy` (allowed categories, per-tx limit, daily cap, domain lock). Must be reproducible against default policy or a plausibly configured one.

### Tier 2 — Runtime Plaintext / Active Attack ($1,000 + Hall of Fame)

**Scope**: Extract plaintext PAN or CVV from a **running** pop-pay MCP server process via any runtime channel — `process.env` / `os.environ`, the CDP injection channel, stdout/stderr logs, subprocess env inheritance, exception tracebacks with `show_locals`, MCP protocol abuse, or any other runtime surface reachable by a same-user local attacker without root.

Reports demonstrating extraction via these runtime channels — **including** cases where the agent itself is the local attacker — are Tier 2.

### Tier 3 — Vault Extraction ($2,000 + Hall of Fame)

**Scope requires**: Extract plaintext from `vault.enc` (e.g., canary `examples/vault-challenge/vault.enc.challenge`) using ONLY the encrypted file and its related on-disk artifacts. Reports relying on **the running pop-pay MCP process** to emit plaintext (via `process.env`, CDP channel, logs, subprocess inheritance, or exception tracebacks) are classified as **Tier 2 Active**, not Tier 3.

Tier 3 is a bounty on the cryptographic boundary holding. Runtime plaintext lifecycle hardening is Tier 2.

Researchers are listed in [`docs/HALL_OF_FAME.md`](./docs/HALL_OF_FAME.md). See [`examples/vault-challenge/README.md`](./examples/vault-challenge/README.md) for the Tier 3 canary.

## Response Timeline

- **Acknowledgment**: Within 48 hours of receipt.
- **Triage**: Initial assessment and severity rating within 7 days.
- **Fix**: We aim to release a fix for critical vulnerabilities within 30 days.
- **Disclosure**: Public disclosure will occur after a fix is available and users have had time to update.

## Credit Policy

We value the work of security researchers. If you follow our disclosure policy, we will:
- Acknowledge your contribution in our security advisories and CHANGELOG.
- Respect your privacy if you wish to remain anonymous.
- Not pursue legal action against you for research conducted within the scope of this policy.

## Security Architecture

`pop-pay` is designed with defense-in-depth:
- **Masking**: Card numbers are masked by default (`****-4242`).
- **Isolation**: The agent process never sees raw card credentials.
- **Native Security**: A Rust-based native layer (napi-rs) handles salt storage and key derivation.
- **Ephemeral Scope**: Approvals are single-use and domain-locked.

Thank you for helping keep the agentic commerce ecosystem safe.
