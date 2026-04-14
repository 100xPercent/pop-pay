# Security Policy

## Responsible Disclosure

At Point One Percent, we take the security of our runtime payment guardrails seriously. If you believe you have found a security vulnerability in `pop-pay`, please report it to us as described below.

## Reporting a Vulnerability

Please do **not** report security vulnerabilities via public GitHub issues.

Two parallel channels (GitHub Advisory preferred, email also monitored):

1. **GitHub Security Advisory** *(preferred)*: [file privately here](https://github.com/100xPercent/pop-pay/security/advisories/new).
2. **Email**: [security@pop-pay.ai](mailto:security@pop-pay.ai).

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

### Tier 1 — Passive Leak ($100–300 + Hall of Fame)

**Scope**: PAN, CVV, or expiry leaks out of a running pop-pay process through a passive surface — logs, screenshots, exception tracebacks (including `show_locals` / `rich.traceback`), temp files, swap, clipboard, browser cache, or metadata. No adversarial action required; the credential simply appears somewhere it shouldn't. See `docs/VAULT_THREAT_MODEL.md` §3.1–3.7 for the canonical passive scenarios.

### Tier 2 — Active Attack ($300–800 + Hall of Fame)

**Scope**: An adversarially-driven extraction or policy-violation path. Includes:
- Prompt injection / role injection that causes unauthorized purchase authorization
- TOCTOU redirect after approval
- Guardrail bypass (keyword / LLM / policy evasion)
- Runtime plaintext extraction from the MCP process via `process.env` / `os.environ`, the CDP channel, stdout/stderr logs, subprocess env inheritance, exception frame locals, or MCP/IPC abuse

Explicitly includes the F1–F8 surfaces being hardened in the S0.7 vault-hardening release. Reports demonstrating extraction via these runtime channels — **including** cases where the agent itself is the local attacker — are Tier 2.

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
