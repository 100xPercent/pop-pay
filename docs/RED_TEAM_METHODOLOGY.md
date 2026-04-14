# Red Team Methodology for AI Agent Commerce

> How pop-pay tests its own guardrail, and a proposed reference methodology for anyone red-teaming an agent commerce system.
>
> Version 0.1 (2026-04-14). Companion to [AGENT_COMMERCE_THREAT_MODEL.md](./AGENT_COMMERCE_THREAT_MODEL.md).

---

## 0. Why this document exists

When the pop-pay maintainer audited our prior claim of "95% accuracy over a 20-scenario benchmark" against a serious attack corpus, the claim did not survive contact. The benchmark was small, the payloads were naive, and the methodology did not report false rejects, latency variance, or layer attribution. We retired the headline and started over.

This document is the methodology we are now using, written up so that (a) anyone running pop-pay in production can reproduce our results, (b) anyone building an alternative engine has a shared methodology to compare against, and (c) anyone auditing the field has a checklist to hold vendors to.

It is not a marketing artefact. Where our harness or scoring has known limitations we say so. Where a class of attack is out of scope we say so.

Related documents:

- [AGENT_COMMERCE_THREAT_MODEL.md](./AGENT_COMMERCE_THREAT_MODEL.md) — the threat model this methodology tests against
- [GUARDRAIL_BENCHMARK.md](./GUARDRAIL_BENCHMARK.md) — the empirical results produced by this harness
- [SECURITY.md](../SECURITY.md) — disclosure policy and bug-bounty structure

---

## 1. Why agent commerce needs its own red-team methodology

Three adjacent practices already exist. None of them is sufficient.

**Web application red teaming** (OWASP ASVS, WSTG) tests authentication, input validation, injection, authorisation, transport. It assumes a human at the keyboard and a server that receives requests. In agent commerce the adversary's lever is not a malformed request — it is a page the agent *reads* and a decision the agent *makes*. The OWASP WSTG test cases for "payment pages" cover vendor-side controls, not agent-side decisions.

**LLM safety red teaming** (Anthropic's red-team reports, OpenAI's system cards, MLCommons AILuminate) tests jailbreaks, harmful content, bias, misuse. The artefact is usually "did the model say something it shouldn't." Agent commerce asks a harder question: *given that the model decided to take an action, did a guardrail layer stop a bad action and allow a good one, reproducibly, under adversarial input at every boundary?*

**Payment fraud red teaming** (issuer side — chargeback modelling, Radar rules tuning, velocity checks) is about the cardholder-and-device signal space. Agent transactions are programmatic by construction; the fraud-engine signal for "unusual behaviour" fires constantly and means nothing.

Agent commerce red teaming lives in the intersection. It needs: (a) the adversarial-input-surface rigour of LLM safety, (b) the policy-enforcement correctness of web appsec, and (c) the money-at-stake metric design of fraud testing — without inheriting the wrong assumptions from any of them.

---

## 2. Testing taxonomy

pop-pay's corpus is organised into 11 categories, A through K, derived from the [AGENT_COMMERCE_THREAT_MODEL §3](./AGENT_COMMERCE_THREAT_MODEL.md#3-attack-surface-taxonomy). Summary:

| ID | Category | Primary target |
|---|---|---|
| A | Layer-1 keyword evasion | Deterministic guardrail |
| B | Vendor / category token game | Allowlist matcher |
| C | TOCTOU / domain spoof | URL and domain layer |
| D | Prompt injection via vendor / reasoning fields | LLM guardrail |
| E | Amount / quantity semantic confusion | LLM guardrail |
| F | Multi-turn / state confusion | Stateless engine assumptions |
| G | Hidden-instruction page injection | Page scanner |
| H | Known-processor list spoofing | Processor passthrough |
| I | Client-path bypass | SDK integration surface |
| J | Env / config injection | Operator-supplied configuration |
| K | LLM-side output / format attacks | LLM response parser |

Each category has multiple *variants* (Unicode homoglyph, paraphrase, base64, padding, language switch, length exhaustion, etc.) and each variant may appear across multiple categories. The corpus aims for coverage over the Cartesian product, not uniform density.

We abstract the same taxonomy as a reference for other engines: any agent commerce guardrail can map its test corpus onto A–K and publish per-category numbers. Where the guardrail has a capability we do not (e.g. visual signal analysis), an extra category letter is fine — the point is that the taxonomy is public, stable, and comparable.

---

## 3. Payload design principles

Four principles govern how we construct and accept payloads into the corpus.

### 3.1 Determinism

Every payload must be fully specified as structured JSON: `{id, category, variant_tags, vendor, amount, reasoning, page_url, allowed_categories, page_content_fixture, expected}`. No payload depends on wall-clock randomness, a live third-party site, or an interactive step. If a payload cannot be rerun a year from now with the same bits, it does not enter the corpus.

### 3.2 Coverage, not count

A corpus of 5000 homoglyphs of the same attack is not 5000 payloads; it is one payload with 5000 variants. We target *category × variant* coverage — every category hit by at least five independent variants, every variant hit against at least two categories where it is structurally relevant. Corpus size is a consequence, not a target (current: 500+).

### 3.3 Layered attribution

Every payload records which *layer* caught or missed it: deterministic Layer 1, LLM Layer 2, hybrid, full MCP tool path (including `scanPage`), TOCTOU mock path. A headline "bypass rate" without attribution is a marketing number. A matrix showing category × layer × verdict is an engineering number.

### 3.4 Honest metrics

Every payload labelled `expected: "block"` is matched by at least one benign counterpart labelled `expected: "approve"` in the same category. If we cannot construct a plausible benign counterpart to a category, that category's "bypass rate" is meaningless without its false-reject companion. Both numbers ship. Neither is omitted.

---

## 4. Harness architecture

pop-pay's harness lives at `tests/redteam/` in the open-source repository. It is a standard `vitest` test suite gated by `POP_REDTEAM=1`. Five runner paths execute every payload:

1. **Layer 1 only** — `GuardrailEngine.evaluateIntent()` from [`src/engine/guardrails.ts`](../src/engine/guardrails.ts). Deterministic, sub-millisecond, no network.
2. **Layer 2 only** — `LLMGuardrailEngine.evaluateIntent()` from [`src/engine/llm-guardrails.ts`](../src/engine/llm-guardrails.ts). The engine reads its own provider config from env; the harness does not read `~/.config/pop-pay/.env`.
3. **Hybrid** — `HybridGuardrailEngine` (Layer 1 short-circuits; otherwise falls through to Layer 2).
4. **Full MCP path** — a local fixture server serves `page_content_fixture` HTML (category-G payloads need this), and the harness invokes the MCP tool entry point, exercising `scanPage` + both guardrails.
5. **TOCTOU / injector path** — a CDP mock that simulates a mid-flight URL change, exercising [`pop_pay/injector.py`](../../project-aegis/pop_pay/injector.py)'s `_verify_domain_toctou`.

Each path records: `{layer1_verdict, layer2_verdict, hybrid_verdict, scan_verdict, toctou_verdict, llm_latency_ms, attribution}`. Because LLM calls are non-deterministic we run each payload **N=5 times** under Layer 2 and the hybrid path, and report variance.

Concurrency: 20 in-flight LLM calls, with exponential backoff on 429s (the production engine already has this; we do not bypass it in the harness).

Reproducibility: every run emits `tests/redteam/runs/<timestamp>.jsonl` containing the prompt hash, raw LLM response, and per-payload verdicts. A reviewer can cryptographically verify two runs are over the same corpus by comparing the corpus hash recorded at the top of the JSONL.

CI: the harness is tagged `requires:llm` and skipped when no provider is configured (detected by a tiny ping intent, not by reading the env file). The bypass-rate regression test fails the build if any category's bypass rate increases between commits.

---

## 5. Scoring and reporting

The report produced from a run is deliberately long-form. Bullet-point summaries hide the layer attribution and the false-reject trade-off, which are the two numbers that actually matter.

### 5.1 Metrics we publish

- **Bypass rate per category.** `approved_when_expected_block / total_attack_payloads` for each of A–K. Reported for each of the five runner paths.
- **False-reject rate per category.** `blocked_when_expected_approve / total_benign_payloads`. Always paired with bypass rate.
- **Layer attribution.** For each category, which layer did the blocking? (Pure Layer 1 / pure Layer 2 / both / neither / TOCTOU / scanPage.) Tells you whether your deterministic layer is pulling its weight.
- **Latency distribution.** p50 / p95 / p99 across Layer 2 and hybrid. Without p99 you cannot answer "will this guardrail time out in production."
- **LLM variance.** Across N=5 runs of the same payload, how often does the verdict flip? Reported per category. A category with >10% flip rate is a red flag: the defence is effectively a coin-toss.
- **Time-to-detect.** The latency until the *first* layer that blocks the payload returns. A system that blocks in Layer 1 at 1 ms is architecturally better than one that only blocks after a 600 ms LLM call, even if the aggregate bypass rate is identical.

### 5.2 What we will not report

- A single "accuracy" number. It does not exist. It hides both false-rejects and layer attribution.
- A "security score" out of 10. Category coverage and attribution matter more than any roll-up.
- Any metric over a corpus smaller than 500 with fewer than five variant classes per category.

### 5.3 Limitations we declare in every report

Every published run includes a "limitations" section:

- Corpus size and category distribution.
- The exact LLM providers / model IDs tested. (`gpt-4o-mini-2024-07-18`, etc.)
- Variants *not yet* in the corpus.
- Known payloads that should pass but currently false-reject.
- The wall-clock date of the run and the git SHA of the engine.

"We did not test X yet" is more useful to an adopter than "we pass 99% of tests."

---

## 6. Community participation

### 6.1 Bug bounty (three tiers)

pop-pay runs a public bounty governed by [SECURITY.md](../SECURITY.md). Three tiers reflect the three threat classes:

| Tier | Scope | Bounty |
|---|---|---|
| **Passive failure** | A demonstration that card data, vault contents, or other in-scope secrets can be read from any observable surface (log line, trace export, screenshot, memory of a co-resident process) without the agent explicitly asking for it. | **$100 – $300** |
| **Active bypass** | A demonstration that a guardrail-rejected intent can be turned into an approved intent, or that a spoofed domain can pass injector verification. | **$300 – $800** |
| **Vault extraction** | A demonstration that the `vault.enc` file can be decrypted to plaintext by an attacker who has the file (but not the live machine's memory). | **$2000 flat + Hall of Fame** |

Vault extraction is a product-existential threat and is rewarded on its own tier. Hall-of-Fame reputation is explicitly part of the reward — for the right researcher it is worth more than the dollar amount.

### 6.2 Contribution path

External payloads are welcome via pull request to `tests/redteam/payloads/`. A payload contribution must include: structured JSON, a written rationale describing which category it targets and why it should (or should not) be caught by a given layer, and an expected verdict. New categories are welcome with a rationale for why they do not fit A–K.

### 6.3 Coordinated disclosure

Default timeline: **90 days**, extendable by mutual agreement. Report privately via the channel listed in [SECURITY.md](../SECURITY.md). Do not open a public issue for an unpatched vulnerability. We will credit the reporter in the release notes and in the Hall of Fame, unless the reporter prefers anonymity.

This is the same timeline used by Google Project Zero and the CERT/CC coordinated disclosure framework ([kb.cert.org/vuls/guidance/](https://kb.cert.org/vuls/guidance/)).

---

## 7. Scope limits (what we will not test)

A methodology is only as credible as its stated limits.

- **Upstream browser security.** If the attack requires a zero-day in Chromium, CDP, or V8, it is out of scope — report it to [crbug.com](https://bugs.chromium.org/) and we will credit you.
- **OS and kernel exploits.** Privilege escalation, kernel-mode memory read, filesystem race conditions at the OS layer: out of scope. These are Linux / macOS / Windows problems.
- **LLM provider security.** If your attack requires compromise of OpenAI's, Anthropic's, or any other provider's infrastructure, it is their incident.
- **Physical-device and biometric primitives.** pop-pay does not claim to defend a stolen laptop with an unlocked session.
- **Post-compromise persistence.** Once an attacker has code execution as the user running the agent, they can do things we cannot prevent. We document the blast radius; we do not promise to prevent it.
- **Social engineering of the human operator.** If the user is convinced to paste `POP_ALLOWED_PAYMENT_PROCESSORS='["evil.io"]'` into their shell, we note this (category J) but the primary defence is operator education and signed config, not engine logic.

Everything else — guardrail semantics, injector correctness, vault hardening against local adversaries with `vault.enc`, scanPage coverage, client-path bypasses, TOCTOU, any attack on the pop-pay engine itself — is in scope.

---

## 8. Reproducing a run

To reproduce a pop-pay red-team run:

```bash
git clone https://github.com/100xPercent/pop-pay
cd pop-pay
git checkout <SHA from the benchmark report>
npm ci
export POP_LLM_PROVIDER=openai
export POP_LLM_API_KEY=sk-...
export POP_LLM_MODEL=gpt-4o-mini-2024-07-18
export POP_REDTEAM=1
npx vitest --run tests/redteam
```

The run emits a JSONL artefact under `tests/redteam/runs/`. Compare its corpus hash to the one at the top of [GUARDRAIL_BENCHMARK.md](./GUARDRAIL_BENCHMARK.md); if they match, you are running the same corpus.

We encourage third parties to publish their own JSONL artefacts against pop-pay and against competing engines. A shared methodology is only useful if multiple independent parties run it.

---

## 9. Contributing to the methodology itself

This methodology will be wrong. The industry will discover categories we missed, metrics we underweighted, limitations we did not declare. Pull requests against this file and against the threat-model companion are the canonical channel for improvement. Substantive changes are reviewed by the pop-pay maintainer and by any external reviewer who signs up in [CONTRIBUTING.md](../CONTRIBUTING.md).

If you want to cite this methodology in your own work or tooling, cite a pinned git SHA of `docs/RED_TEAM_METHODOLOGY.md`. Live `main` may move.

---

*Last updated 2026-04-14. Maintainers: the pop-pay project.*
