# VAULT_THREAT_MODEL.md — pop-pay Vault Architecture Threat Model v0.2

> **v0.2 status (2026-04-21).** First audit-driven revision of the v0.1 document. All F1–F8 findings from S0.7 Round 1 have landed on both repos; RT-2 Round 2 hotfix bundle (Fixes 1–8) has shipped in `v0.5.10` (TS) / `v0.8.9` (Py). Coverage of each v0.1 threat row is mapped against its fix commits in §5, residual likelihood × impact is tabulated in §6, and three new threat rows surfaced by the Round 2 audit are documented in §2.8–§2.10. Line numbers referenced in §1 and §2 are against TS HEAD at time of writing; they may drift — commit hashes in §5 are authoritative.

## 0. Scope

This document covers the internal architecture and security properties of the **pop-pay credential vault** — the encrypted storage of payment credentials at rest and in the unlock / inject window. It focuses on the cryptographic implementation, process isolation of secrets, the **passive failure modes** that motivate the vault's existence, and — new in v0.2 — the **runtime trust boundary** between `pop-pay` and the Chrome binary it drives over CDP.

Out of scope: product-layer threats (agent-side policy violations, upstream LLM compromise) — see `THREAT_MODEL.md`.

## 1. Vault Architecture Summary

- **TS implementation**: TypeScript wrapper `src/vault.ts` orchestrating a native Rust `napi-rs` layer `native/src/lib.rs` for scrypt key derivation with compiled-salt hardening. AES-256-GCM via Node's `crypto.createCipheriv`.
- **Python implementation**: Python wrapper `pop_pay/vault.py` plus compiled Cython engine `pop_pay/engine/_vault_core.pyx` → `.so`. Byte-identical blob format with TS (enforced by `tests/vault-interop.test.ts` on the TS side).
- **KDF (machine mode)**: `scrypt` parameters N=2^14 (16384), r=8, p=1, dkLen=32. Password = `machine_id + ":" + username`.
- **KDF (passphrase mode)**: `PBKDF2-HMAC-SHA256` with 600,000 iterations, salt = `machine_id`.
- **Storage**: Encrypted blob at `~/.config/pop-pay/vault.enc`, written atomically (tmp + fsync + rename) with `0o600` permissions.
- **Blob format**: `nonce(12) || ciphertext || tag(16)` (AES-256-GCM).
- **Salt hardening (hardened builds)**: Salt is XOR-split into two compiled byte arrays `A1` and `B2` embedded in the Rust `.node` (or Cython `.so`). Reconstructed in-memory via `a1 ⊕ b2`, used once, then zeroed with the `zeroize` crate. Salt injection itself now lives in `build.rs` under `OUT_DIR` (F2 fix, commit `221cae5`) so the plaintext salt is never checked into the repo tree.
- **Downgrade defense**: `.vault_mode` marker file records `passphrase` / `machine-hardened` / `machine-oss` / `unknown` (extended schema, F4/F7, commit `3f8beb5`). `loadVault()` refuses to proceed if marker says `machine-hardened` but the native module is missing / non-hardened.
- **Process isolation (new in v0.2)**: MCP transport split into pipe (default) and StreamableHTTP+Bearer (opt-in) so a sibling process cannot attach to the unlock session without presenting a per-start 256-bit token (F6(A), TS commit `88fb79e`, Py commit `28a63ea`, spec: `docs/CROSS_PROCESS_SETUP.md`).

## 2. Active Attacks

### 2.1 `vault.enc` file theft (cold copy)
- **Threat**: Attacker with filesystem read access copies `vault.enc` to another machine for offline cracking.
- **Current defense**: AES-256-GCM authenticated encryption + machine-bound scrypt KDF. Decryption fails on another machine because `machine_id` (and/or `username`) differ.
- **Residual risk**: If attacker also exfiltrates `/etc/machine-id` (Linux) or the platform-UUID, only the compiled salt and username remain unknown — and in OSS builds salt is a public constant (see §2.10).

### 2.2 Memory dump during decryption
- **Threat**: Attacker dumps the Node.js / Python process memory while the vault is unlocked, extracting the derived AES key or the plaintext credentials.
- **Current defense**: In the Rust layer, the reconstructed salt buffer and password buffer are wiped via the `zeroize` crate immediately after scrypt. Atomic writes clear tmp files promptly. In Python, PAN/CVV/passphrase are wrapped in `SecretStr` at capture (RT-2 Fix 3.1–3.6, commits `396e235` → `cca6ffc`) so str-coercion surfaces do not leak plaintext into tracebacks.
- **Residual risk**: The derived **key** and **plaintext** necessarily live in the Node.js / Python heap for the duration of the `decipher.update`/`final` call. V8 GC does not give deterministic zeroization of heap buffers; same for CPython.

### 2.3 Native binary reverse engineering (napi `.node` / Cython `.so`)
- **Threat**: Attacker reverse-engineers the compiled native module (e.g., Ghidra, IDA Pro) to extract the two XORed salt halves and reconstruct the salt offline.
- **Current defense**: Salt stored as two `static` byte arrays (`A1`, `B2`); reconstruction happens only inside `derive_key` at runtime. Variable names obfuscated. Compiled release builds are stripped. Salt injection moved to `build.rs` / `OUT_DIR` so the salt is never committed to source.
- **Residual risk**: A determined reverse-engineer can locate both arrays and XOR them. Obfuscation raises the bar, not a cryptographic wall. **Mitigation: R2 dynamic reversing** (runtime-attach IDA scenario) is scheduled in the RT-2 stage graph (`workspace/INDEX.md`).

### 2.4 KDF weakness (brute force on passphrase)
- **Threat**: In passphrase mode, attacker brute-forces a weak user passphrase via GPU/ASIC farm.
- **Current defense**: PBKDF2-HMAC-SHA256 with 600,000 iterations (OWASP 2023 floor).
- **Residual risk**: Passphrase entropy is the ultimate limit. Users may choose weak strings despite iteration count.
- **Planned**: argon2id evaluation tracked in Deferred items (`workspace/INDEX.md`).

### 2.5 Side-channel: timing attacks on decrypt path
- **Threat**: Attacker measures decryption latency to distinguish valid vs invalid keys / tamper.
- **Current defense**: AES-GCM verifies the tag in constant time in Node's OpenSSL binding (and `RustCrypto`'s `aes-gcm` on the native path). Decryption short-circuits on tag mismatch without leaking key-comparison timing.
- **Residual risk**: Potential timing leaks in scrypt implementation or in JSON parsing of the resulting plaintext. Not currently measured.

### 2.6 Side-channel: cache attacks on key material
- **Threat**: Co-resident process (same physical CPU) uses FLUSH+RELOAD or similar cache-timing attack to extract AES round keys.
- **Current defense**: On x86-64 / arm64 with AES-NI / ARMv8 crypto extensions, the AES rounds are hardware-backed and cache-resistant. Both targets pop-pay supports.
- **Residual risk**: Non-AES-NI fallbacks in software AES libraries are theoretically vulnerable.

### 2.7 Salt recovery from binary via `strings` / static scan
- **Threat**: `strings native/pop-pay-native.node | grep ...` or equivalent on the Cython `.so` extracts the salt directly.
- **Current defense**: Salt is never present as a contiguous byte sequence in the binary — only the two XOR halves exist, and neither individually is meaningful. Salt injection in `build.rs` keeps it out of git history entirely (F2).
- **Residual risk**: Binary diffing of two hardened builds with the same salt could reveal the patterns.

### 2.8 Chrome binary tampering (new, v0.2)
- **Threat**: Attacker (or an already-present agent with local write) replaces the Chrome binary — or a code-signed-but-modified fork — on the operator's machine. `pop-pay` attaches via CDP to what it believes is a legitimate Chrome and sends unmasked card data to the injector; the tampered Chrome copies the plaintext off-host before rendering.
- **Current defense**: **None as of v0.2 baseline.** The CDP client trusts any binary reachable at `POP_CHROME_PATH` or standard locations.
- **Coverage status**: **In progress (R0.1 F9).** The 4-layer F9 check lands in parallel with this document: (1) OS codesign verification as primary, (2) static SHA-256 pin list in-repo as secondary, (3) fork whitelist (Google / Brave / Edge / Firefox) as tertiary, (4) runtime extension enumeration + CDP port scan as defense-in-depth. See `docs/DOCTOR.md` for the operator-facing check description.
- **Residual risk after F9**: OS codesign bypass via kernel / Gatekeeper compromise sits above the trust root F9 relies on — out of scope for an application-layer check. SHA-list drift (new Chrome release that has not yet been PR-bumped) will fall back to codesign + fork whitelist rather than fail-closed.
- **Rationale — why not live-fetch**: Live-querying `dl.google.com` was considered and explicitly rejected: single trust root, availability failure mode, Chrome auto-update cadence churn, fork ecosystem compatibility, and privacy side-channel on every `doctor` run. The static-list + codesign layering preserves defense-in-depth without handing Google a telemetry hook.

### 2.9 CDP port hijack (new, v0.2)
- **Threat**: A sibling process on the same host opens `127.0.0.1:9222` before `pop-pay` does, impersonating the DevTools endpoint. `pop-pay` connects, sends the unmasked credential payload for injection, and the rogue listener harvests it.
- **Current defense**: **F6(A) cross-process MCP split** (TS commit `88fb79e`, Py commit `28a63ea`) replaces raw TCP with StreamableHTTP+Bearer on the MCP transport path; token is 256-bit, written to `~/.config/pop-pay/.attach_token` mode 0600, generated at server start, rotated per launch. An attacher without the token gets 401 before any MCP frame parses. See `docs/CROSS_PROCESS_SETUP.md`.
- **Residual risk**: F6(A) covers the MCP → `pop-pay` direction. The **`pop-pay` → Chrome-DevTools direction** (the CDP socket itself) is still plain TCP by Chrome's design; layered detection via F9 Layer 4 (warn if `127.0.0.1:9222` is listening to a non-Chrome process before launch) reduces but does not eliminate this. Full mitigation would require Chrome-side auth, which does not exist.
- **Coverage**: F6(A) for MCP attach; F9 Layer 4 for CDP listener sanity; `docs/CROSS_PROCESS_SETUP.md` for operator guidance.

### 2.10 OSS-salt silent fallback (new, v0.2)
- **Threat**: An operator running an OSS build of `pop-pay` (where the compiled salt is a public constant, not a hardened XOR-split) unlocks their vault without realizing the salt is public — reducing the machine-bound KDF to a near-public key derivation. If `vault.enc` is then exfiltrated, offline cracking is substantially cheaper than against a hardened build.
- **Current defense**: **F3 OSS-salt consent gate** (TS `881c45b`, Py `3b8c98a`) requires `POP_ACCEPT_OSS_SALT=1` before an OSS build will unlock. The **F4 `.vault_mode` marker** (TS `3f8beb5`, Py `d724e41`) records `machine-oss` at init and refuses to load a vault with a `machine-hardened` marker under an OSS build (downgrade refuse).
- **Residual risk**: An operator who sets `POP_ACCEPT_OSS_SALT=1` without understanding the tradeoff, or who initializes fresh on an OSS build, still ends up with a public-salt vault. Documented in the consent gate's error message; further reduction requires UX work not yet scoped.
- **Coverage**: F3 + F4 + F7 (legacy marker migration with downgrade-refuse).

## 3. Passive Failure Mode (standalone — product-existential)

Passive failure remains the **greatest existential threat to pop-pay**. An agent that never tries to attack the vault can still leak real card data through its own reasoning traces, tool outputs, logs, or screenshots — simply by being present at the moment of unlock. The core product promise is *"the agent process never possesses raw credentials."* Every scenario below represents a way that promise can break through no adversarial intent.

### 3.1 Agent reads `console.log` / debug output capturing unlocked card
- **Scenario**: A developer left a `console.log(creds)` or a logging framework captures a tool return value that contained full credentials.
- **pop-pay defense**: **Structural isolation** at the MCP tool boundary. Tool returns to the agent are masked (`****-4242`). Raw credentials flow from `decryptCredentials` directly to the CDP injector, never crossing the MCP response layer. F5 log-redact strips PAN digit runs from any residual log payloads (TS `93548bc`, Py `e4c6f69` — seals in exception frame locals too). RT-2 Fix 4 dropped redundant `masked_card` encryption so already-redacted fields stop being treated as secret (TS `d2ae892`, Py `aa1c5f7`).
- **Residual risk**: Logging *inside* the `pop-pay` process (not the agent's) may reach shared observability sinks (Datadog, stdout piped to agent tool). pop-pay does not currently scrub its own stdout.
- **Severity**: High. This is the single most likely real-world leak path.

### 3.2 Agent reads screenshot / screen recording of dashboard or checkout
- **Scenario**: The agent takes a screenshot for verification, and the browser has the card form filled (post-injection, pre-submit).
- **pop-pay defense**: `POP_BLACKOUT_MODE` default (F6(c), TS `031cde9`, Py `5663d1b`) keeps the agent-visible DOM masked. Injection into the checkout DOM happens at the last moment before submit, minimizing the "unmasked window." Stripe Elements cross-origin iframe is the structural defense on compatible checkouts.
- **Residual risk**: A screenshot taken during the narrow unmasked window captures plaintext digits on non-iframe checkouts.
- **Severity**: Medium.

### 3.3 Error message leaks vault path or partial key material
- **Scenario**: Decryption fails; an uncaught exception bubbles with a stack trace that includes a `Buffer` preview, env var path, or key-derivation intermediate.
- **pop-pay defense**: `decryptCredentials` throws generic `Error("Failed to decrypt vault — wrong key...")` with no payload. RT-2 Fix 5 routes fatal errors through `handleCliError` (TS `b47ebd2`) so unhandled rejections do not print raw stack frames. Py `SecretStr` wrapping (RT-2 Fix 3.1–3.6) prevents traceback `repr()` from surfacing plaintext.
- **Residual risk**: Native-layer panics may still produce Rust panic strings with offsets; these are caught at the handler boundary but string content is not sanitized beyond the generic wrapper.
- **Severity**: Low in the common path; medium in the native-panic path.

### 3.4 Agent curious-read of `~/.config/pop-pay/vault.enc`
- **Scenario**: An agent with `read_file` permissions decides to "investigate" the pop-pay config directory.
- **pop-pay defense**: Encryption at rest; AES-256-GCM ciphertext is computationally indistinguishable from random without the machine-bound key. F8 stale-`.tmp` cleanup (TS `ba5ae3b`, Py `9c2f075`) + `wipeVaultArtifacts` (Py `fef1fcf` idempotent) reduces the attack surface to the encrypted blob only.
- **Residual risk**: If the same agent also reads `/etc/machine-id` and the local user's name, it has two of three key-derivation inputs; on an OSS build with F3 consent given, the third input (salt) is also public.
- **Severity**: Low (file-read only), High (file-read + shell + OSS build with consent given).

### 3.5 Tmp / swap / clipboard leakage post-unlock
- **Scenario**: OS swaps the process's plaintext page to `/var/vm/` or `pagefile.sys`; atomic-write tmp file remains briefly on disk.
- **pop-pay defense**: Atomic rename with `fsync` + `0o600` permissions for `vault.enc` tmp. No explicit `mlock` of plaintext pages. RT-2 N1/N2 (state DB hardening): `VACUUM + secure_delete` on legacy migration (TS `97b9d60`, Py `69f6f59`), `chmod 0600` on state DB + WAL + SHM (TS `38548ef`, Py `dbe56eb`), gitignore for WAL/SHM sidecars (Py `5d87561`).
- **Residual risk**: OS swap files are outside application control. `mlock` would require elevated permissions.
- **Severity**: Medium.

### 3.6 Metadata leak via file timestamps
- **Scenario**: An agent monitors `stat ~/.config/pop-pay/vault.enc` over time, correlating mtime changes with observed transactions.
- **pop-pay defense**: None currently. Deferred — behavioral privacy is low priority relative to content privacy.
- **Severity**: Low for card security.

### 3.7 LLM provider receives unlock data via tool-response chain
- **Scenario**: A future MCP tool expansion accidentally returns a raw credential field (developer error).
- **pop-pay defense**: Current MCP tool surface is strictly masked-only — no tool returns decrypted fields. Py-side `SecretStr` migration (RT-2 Fix 3.1–3.6) provides type-system-level enforcement on the critical path (`VirtualSeal`, providers, readers, injector). TS branded-type enforcement tracked in Deferred items.
- **Residual risk**: TS side still relies on code-review enforcement; type-system parity with Py is planned.
- **Severity**: Medium.

## 4. Code-Path Defense Map

| Defense area | TS path | Python path | Note |
|---|---|---|---|
| Encryption-at-rest | `src/vault.ts` | `pop_pay/vault.py` | AES-256-GCM, 12-byte random nonce |
| Decryption + auth-tag check | `src/vault.ts` | `pop_pay/vault.py` | GCM tag verified before plaintext exposure |
| KDF (machine mode) | `native/src/lib.rs` | `pop_pay/engine/_vault_core.pyx` | scrypt N=2^14, r=8, p=1 |
| KDF (passphrase mode) | `src/vault.ts` | `pop_pay/vault.py` | PBKDF2-HMAC-SHA256, 600k iters |
| Salt isolation (XOR halves) | `native/src/lib.rs` | `pop_pay/engine/_vault_core.pyx` | `A1` + `B2` compiled into native |
| Salt injection out of source tree | `native/build.rs` (F2) | Cython build step | OUT_DIR only; never committed |
| Salt / password zeroization | `native/src/lib.rs` | `pop_pay/engine/_vault_core.pyx` | `zeroize` crate (Rust) |
| Plaintext wrapping | _(planned branded type)_ | `pop_pay/secret_str.py` (F3.1) | SecretStr prevents str-coercion leaks |
| Atomic vault write | `src/vault.ts` | `pop_pay/vault.py` | tmp + fsync + rename, mode 0o600 |
| Downgrade defense (F4/F7) | `src/vault.ts` (`parseVaultMode`) | `pop_pay/vault.py` | `.vault_mode` marker, `is_hardened()` gate |
| OSS-salt consent gate (F3) | `src/vault.ts` (`enforceOssSaltConsent`) | `pop_pay/vault.py` | `POP_ACCEPT_OSS_SALT=1` required |
| Log redaction (F5) | `src/injector.ts` | `pop_pay/injector.py` | Digit-run redaction + frame-locals sealing |
| Error sanitization | `src/errors.ts` | `pop_pay/errors.py` | Typed `PopPayError` hierarchy |
| MCP masked-only surface | `src/mcp-server.ts` | `pop_pay/mcp_server.py` | No tool returns plaintext |
| Cross-process transport (F6(A)) | `src/transport.ts`, `src/mcp-server.ts` | `pop_pay/transport.py` | pipe default, StreamableHTTP+Bearer opt-in |
| State DB at rest (RT-2 N1/N2) | `src/state.ts` | `pop_pay/core/state.py` | chmod 0600, VACUUM + secure_delete |
| Chrome binary integrity (F9) | `src/doctor/` _(R0.1, landing)_ | `pop_pay/cli_doctor.py` _(R0.1, landing)_ | codesign + SHA pin + fork whitelist + runtime |

## 5. Coverage Map — v0.1 findings closure

Each row of the v0.1 threat inventory mapped to (a) fix commit, (b) remaining residual risk, (c) verification method. Commit hashes are authoritative — line numbers in §1 / §2 may drift.

| F-ID | Subject | TS fix | Py fix | Residual after fix | How verified |
|------|---------|--------|--------|-------------------|--------------|
| F1 | Plaintext PAN/CVV must not enter env / children | `db49916` | `5bc905f`, `73f3790`, `c91873d` | Env-inherit surface closed; heap residency remains (§2.2) | Regression tests: TS `af6ba63`, Py `f86b4c5` |
| F2 | Salt injection out of source tree | `221cae5` | (Cython build step) | Binary-diff risk (§2.7) | Code review + `git log` on `native/` |
| F3 | OSS-salt consent gate | `881c45b` | `3b8c98a` | Operator-acknowledged low-entropy vault (§2.10) | Unit tests in `vault.test.ts` + Py equivalent |
| F4 | Extended vault-mode marker | `3f8beb5`, `93d7aa1` | `d724e41`, `5f29426` | Schema-drift on unknown markers — defaults fail-closed | `parseVaultMode` tests |
| F5 | Log redaction for PAN digit runs + exception locals | `93548bc` | `e4c6f69` | Pop-pay-side stdout not scrubbed (§3.1) | `tests/injector.test.ts` + Py mirror |
| F6(b) | Chrome logging flag guard | `031cde9` | `5663d1b`, `9fb65f2` | Chrome flags discoverable via other paths (low) | Integration test on injector launch |
| F6(c) | `POP_BLACKOUT_MODE` default | `031cde9` | `5663d1b` | Screenshot window (§3.2) | Integration test |
| F6(A) | Cross-process MCP split (pipe + TCP+Bearer) | `88fb79e` | `28a63ea` | CDP-side hijack (§2.9) — separate channel | `docs/CROSS_PROCESS_SETUP.md` + founder walkthrough |
| F7 | Legacy marker migrate + downgrade refuse | `3f8beb5` | `d724e41` | Migration only runs once per vault | `parseVaultMode` tests include legacy fixtures |
| F8 | Stale `.tmp` cleanup + `wipeVaultArtifacts` | `ba5ae3b` | `9c2f075`, `fef1fcf` (idempotent) | — | Unit tests on wipe enumeration |
| RT-2 Fix 3 | `SecretStr` migration (Py) | _(TS planned — branded type)_ | `396e235`, `e832791`, `b01e79f`, `a95d4d3`, `cca6ffc` | TS side lacks type-system enforcement (§3.7) | Regression tests on repr / traceback |
| RT-2 Fix 4 | Drop `masked_card` encryption | `d2ae892` | `aa1c5f7` | — | Code review — already-redacted |
| RT-2 Fix 5 | Route fatal errors through handler | `b47ebd2` | (Py has typed error hierarchy) | Native panic strings (§3.3) | CLI smoke test |
| RT-2 Fix 6 | SQLite WAL/SHM hygiene | (TS state already handled) | `5d87561` | — | gitignore + manual inspection |
| RT-2 Fix 7 | `wipe_vault_artifacts` idempotent | (TS already idempotent) | `fef1fcf` | — | Idempotency test |
| RT-2 Fix 8 | Public-docs privacy hardening | `dcac814`, `3efdbba` | `dc6797c`, `36ac995` | — | Public-tree audit |
| RT-2 N1 | VACUUM + secure_delete on legacy migration | `97b9d60` | `69f6f59` | — | State-migration test |
| RT-2 N2 | chmod 0600 on state DB + WAL + SHM | `38548ef` | `dbe56eb` | — | Permission-assert test |

## 6. Residual Risk Matrix

Likelihood × Impact after hardening. `L` = remote attacker only, `M` = local attacker with user-level shell, `H` = local attacker with privileged shell or physical access. Impact `L` = metadata / behavior, `M` = partial key material, `H` = card plaintext.

| Threat | Likelihood | Impact | Residual Rating | Next mitigation |
|--------|-----------|--------|-----------------|-----------------|
| 2.1 Cold `vault.enc` copy | M | H (OSS build) / L (hardened) | Medium | §2.10 UX clarification |
| 2.2 Memory dump during decrypt | H | H | **High** | R2 dynamic reversing (planned) |
| 2.3 Native binary RE | M | H | **High** | R2 dynamic reversing (planned) |
| 2.4 KDF brute force (passphrase) | L | H | Medium | argon2id eval (Deferred) |
| 2.5 Timing side-channel | L | M | Low | Measurement out of scope |
| 2.6 Cache side-channel | L | H | Low | Hardware AES enforced |
| 2.7 Salt recovery via `strings` | L | M | Low | F2 closes direct scan |
| 2.8 Chrome binary tampering | M | H | **High** — open until F9 lands | R0.1 F9 (landing parallel with this doc) |
| 2.9 CDP port hijack (inbound) | M | H | Medium | F6(A) + F9 Layer 4 |
| 2.10 OSS-salt silent fallback | L (consented) / M (unaware) | H | Medium | F3 + F4 + UX clarification |
| 3.1 Console log leak | M | H | Medium | TS branded type (planned) |
| 3.2 Screenshot during inject | M | M | Medium | Checkout iframe coverage |
| 3.3 Error message leak | L | M | Low | Native panic wrapper refinement |
| 3.4 Curious `vault.enc` read | M | L | Low | Already encrypted |
| 3.5 Swap / tmp leak | L | H | Low | `mlock` eval (Deferred) |
| 3.6 mtime metadata | L | L | Low | Deferred |
| 3.7 LLM provider tool-chain leak | M | H | Medium | TS branded type (planned) |

**Top-3 residual risks after v0.2 hardening:**

1. **2.2 Memory dump during decrypt** — inherent to managed-runtime architectures; the derived key and plaintext must live in heap during AEAD operations. Mitigation path: R2 dynamic reversing exercise (RT-2 stage graph) to characterize the attack cost, then decide whether process isolation (vault decrypt in a separate short-lived process) is worth the complexity.
2. **2.3 Native binary reverse engineering** — obfuscation + XOR split raises the bar; does not defeat a determined analyst. Same mitigation path as 2.2: R2 dynamic reversing scopes the real cost, then architectural decision.
3. **2.8 Chrome binary tampering** — high until F9 lands. Will drop to Low-Medium once F9 ships (OS codesign + SHA pin + fork whitelist + runtime checks) and to Low once R3 public bounty gate exercises it.

For residual risks whose mitigation points at not-yet-run work, the reference is the RT-2 stage graph in `workspace/INDEX.md`, not a work item in this document.

## 7. References

- [THREAT_MODEL.md](./THREAT_MODEL.md) — Product-layer threat model.
- [CROSS_PROCESS_SETUP.md](./CROSS_PROCESS_SETUP.md) — F6(A) transport architecture + operator setup.
- [DOCTOR.md](./DOCTOR.md) — Operator-facing check descriptions, including F9 (Chrome integrity, landing with v0.2).
- [../SECURITY.md](../SECURITY.md) — Disclosure policy and contact.
- Mirror Python repo: `project-aegis/pop_pay/vault.py`, `project-aegis/pop_pay/engine/_vault_core.pyx`.
- RT-2 stage graph: `workspace/INDEX.md` (project-secretary) → "RT-2 Stage Graph (2026-04-20 locked)".
