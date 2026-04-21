# `pop-pay doctor`

Diagnose your pop-pay installation: environment, vault, policy config, guardrail reachability.

## Usage

```
$ pop-pay doctor
$ pop-pay doctor --json          # machine-readable
$ pop-pay doctor --strict        # F9: only Google Chrome, SHA must match known-good list
$ pop-pay doctor --permissive    # F9: accept any Chrome-family binary with a valid code signature
```

Exit codes:
- `0` — no blocking failures (may include warnings / non-blocking errors)
- `1` — at least one **blocker** failed (pop-pay cannot start)
- `2` — doctor itself crashed

## Checks (15 total)

| id | What it verifies | Blocker? |
|---|---|---|
| `node_version` | Node.js ≥ 18 | yes |
| `chromium` | Chrome / Chromium executable present (or `POP_CHROME_PATH`) | yes |
| `cdp_port` | CDP port (default 9222 or `POP_CDP_URL`) is free | no |
| `config_dir` | `~/.config/pop-pay/` exists | no |
| `vault` | `vault.enc` present & non-trivial size (or `POP_VAULT_PATH`) | no |
| `env_vars` | All known `POP_*` env vars **parse correctly** (format-only; values never read) | no |
| `policy_config` | `POP_ALLOWED_CATEGORIES` / `POP_ALLOWED_PAYMENT_PROCESSORS` are valid JSON arrays | no |
| `layer1_probe` | Layer 1 guardrail module loads | yes |
| `layer2_probe` | LLM API host reachable (TCP only; **no request sent**, no quota burned) | no |
| `injector_smoke` | `chrome --version` succeeds | no |
| `f9_l1_codesign` | Chrome binary has a valid OS code signature (macOS codesign / Linux dpkg-rpm / Windows Authenticode) | **yes** |
| `f9_l2_sha_pin` | Chrome binary SHA-256 matches the in-repo known-good list (`data/chrome-known-good-sha256.json`) | no (yes under `--strict`) |
| `f9_l3_fork` | Chrome vendor is on the fork whitelist — default accepts Google, Brave, Microsoft, Mozilla; `--strict` accepts only Google; `--permissive` accepts any signed vendor | **yes** |
| `f9_l4_extensions` | Enumerate installed Chrome/Brave/Edge extensions (informational) | no |
| `f9_l4_cdp_port` | Warn if the CDP port is already listening before we bind — possible hijack (see VAULT_THREAT_MODEL §2.9) | no |

## F9 — Chrome binary integrity

F9 closes the trust boundary between pop-pay and the Chrome binary it drives over CDP. See `docs/VAULT_THREAT_MODEL.md` §2.8 for the threat model.

**Four layers:**

1. **OS codesign (primary, load-bearing).** macOS: `codesign --verify` + parse the `Authority=Developer ID Application: <vendor> (<team-id>)` line. Linux: `dpkg -V` on Debian family / `rpm -V` on RPM family. Windows: `Get-AuthenticodeSignature`. A failure here blocks startup — it means either a tampered binary or a missing OS-level signing chain.
2. **Static SHA-256 pin (secondary).** The Chrome executable is SHA-256-hashed and compared against `data/chrome-known-good-sha256.json`. The list is bumped manually by PR per Chrome major release — the PR review step IS the supply-chain defense. A miss under default mode is a **warn** (Chrome auto-updates frequently; the list lags by design), but escalates to **fail** under `--strict`.
3. **Fork whitelist (tertiary).** Default mode accepts Chrome, Brave, Edge, and Firefox. `--strict` accepts only Google Chrome (use this in high-assurance setups). `--permissive` accepts any binary with a valid code signature (use this for uncommon forks like Arc, Thorium, Vivaldi when you trust the vendor yourself).
4. **Defense-in-depth (runtime).** Enumerates user-installed extensions (informational — pop-pay does not block extensions in v1, but the list appears in the `--json` output for CI/audit tooling) and checks whether the CDP port is already listening before pop-pay binds (possible hijack — see §2.9).

**Never live-fetches `dl.google.com`.** Six-reason rationale (single trust root, availability, Chrome update lag, channel sprawl, fork ecosystem, privacy side-channel) is in `VAULT_THREAT_MODEL.md` §2.8.

**Bumping the known-good list:** open a PR adding an entry to `data/chrome-known-good-sha256.json`. Required fields: `vendor`, `channel`, `version`, `platform`, `arch`, `sha256`. On macOS discover Team ID via `codesign -dv --verbose=4 /Applications/Google\ Chrome.app` against a known-good install.

## Privacy & safety

- **`env_vars` is format-only.** doctor checks *presence* and, for JSON-array envs, *parseability*. It never prints or otherwise exposes any env var's value. `POP_LLM_API_KEY` set → reported as `set`, nothing more.
- **`layer2_probe` does not authenticate.** It opens a TCP connection to the LLM host and closes it. Your API key is never transmitted. This catches network / DNS problems without burning quota.

## Remediation catalog

Text messages live in `config/doctor-remediation.yaml` — editable without a code change. Flat schema:

```yaml
<check_id>:
  remediation: "<one-line action>"
  blocker: true|false
```

## KNOWN LIMITATIONS

- **Typed-engine-failure classification is deferred — this is intentional, not oversight.** doctor ships with its own local error handler and does **not** depend on the engine's `errors.ts`. When Layer 1 / Layer 2 / injector fail, doctor reports a generic `fail` rather than a typed engine error code. This gap exists because doctor was shipped in parallel with (and independent of) the **Error Model Refactor** track (currently paused, pending founder decision — see `workspace/projects/pop-pay/redteam-plan-2026-04-13.md`). Once that refactor lands, a post-refactor round 2 will upgrade doctor to map typed engine failures → specific remediation entries.
- **`cdp_port` is a TCP probe.** A port that accepts a connection is reported as `in use`, but doctor cannot distinguish "existing pop-pay Chrome" from "unrelated process." Treat warnings accordingly.
- **`injector_smoke` does not launch a page.** It invokes `chrome --version`. Full headless boot coverage lives in the integration test suite.
- **No CATEGORIES-specific checks yet.** Per red-team plan S0.3, CATEGORIES policy checks are gated on the S0.2 B-class bypass-rate decision (shipped in S1.1).

## Output shape (JSON)

```json
[
  {
    "id": "node_version",
    "name": "Node.js v20.11.0 (≥18 required)",
    "status": "pass",
    "blocker": false
  }
]
```

`status` ∈ `"pass" | "warn" | "fail"`. `blocker` is `true` only when `status === "fail"` AND the check is marked blocker in the remediation catalog.
