# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.8] - 2026-04-14

### Added
- **`pop-pay doctor` diagnostic subcommand** — 10 generic connectivity / environment checks: `node_version`, `chromium`, `cdp_port`, `config_dir`, `vault`, `env_vars`, `policy_config`, `layer1_probe`, `layer2_probe`, `injector_smoke`. Emits pass/warn/fail per check with actionable remediation; exits `0` when clean, `1` on blocker failure, `2` on internal crash. Supports `--json` for machine-readable output.
- **Remediation catalog** at `config/doctor-remediation.yaml` — text messaging decoupled from code, editable without a release.
- **`docs/DOCTOR.md`** — full documentation + KNOWN LIMITATIONS section explaining the intentional engine-classify gap (doctor ships with its own local handler; typed-engine-failure classification deferred to post-refactor round 2, pending the paused Error Model Refactor track).

### Security
- **`check_env_vars` is format-only and content-blind.** Reports `present (hidden)` / `missing` for all `POP_LLM_*` secrets (no length, prefix, or hash). JSON-array envs report entry count only.
- **`check_layer2_probe` is TCP-only.** Opens and closes a connection to the LLM host — no HTTP request is issued, no API key is ever transmitted, no quota is burned.

## [0.5.7] - 2026-04-13

### Fixed
- **Dual-publish workflow regression**: 0.5.6 failed to publish because the new workflow had drifted from the v0.5.5 working config. Reverted `actions/checkout` and `actions/setup-node` from `@v4` back to `@v6`, `node-version` from `'20'` back to `'24'`, and removed the explicit `--provenance --access public` flags (Trusted Publisher auto-enables provenance; `access` is set via `publishConfig` in `package.json`). Dual-publish structure (primary → scoped → verify) preserved.

### Notes
- 0.5.6 tag exists but no tarball was published to the registry (`E404` on PUT after sigstore attestation was signed). This 0.5.7 release ships the same content as 0.5.6 plus the workflow fix.

## [0.5.6] - 2026-04-13

### Changed
- **README restructured to CLI-first**: MCP server demoted to a sub-section; Install section is fully collapsed (Homebrew / curl / npm / npx each in its own `<details>`, no default-expanded recommendation).
- **Install paths expanded**: Homebrew tap (`brew install 100xPercent/tap/pop-pay`) and `curl | sh` bootstrap installer (`install.sh`) added alongside existing npm / npx paths.
- **`package.json` metadata refresh**: description and keywords rewritten CLI-first (added `cli`, `command-line`, `agent-tool`, `payment-cli`, `browser-agent`).

### Added
- **Scoped mirror package `@100xpercent/mcp-server-pop-pay`**: new `scoped-mirror/` sub-project, a thin re-export of `pop-pay` at the exact same version, matching Anthropic's MCP `@scope/mcp-server-<name>` naming convention. Tracks the primary package on every release.
- **Dual-publish workflow**: `.github/workflows/publish.yml` now publishes both `pop-pay` and `@100xpercent/mcp-server-pop-pay` via OIDC / Trusted Publisher (`--provenance --access public`), with a `verify` gate that `npm view`s both before the release is considered successful. Any job failure fails the whole release.
- **`.mcp.json`** at repo root for Open Plugins standard compliance (Cursor Directory discovery).
- **`glama.json`** for Glama.ai listing metadata (`maintainers: ["TPEmist"]`).
- **Homebrew tap auto-bump workflow** (`.github/workflows/dispatch-tap-bump.yml`): on release, computes the npm tarball SHA256 and dispatches a formula update to `100xPercent/homebrew-tap`.
- **Runtime demo GIF** in README hero (cross-repo reference to `pop-pay-python/assets/runtime_demo.gif` — not duplicated as a binary here).
- **Cross-link to Python repo** in README (same vault format, safe to switch runtimes).
- **`.claude/settings.json`** with a conservative per-binary allow-list replacing the previous `Bash(*)` wildcard.

### Notes
- No source-code changes. This is a packaging / distribution / documentation release and the first production run of the dual-publish workflow.

## [0.5.4] - 2026-04-10

### Fixed
- **`mcpName` case mismatch with MCP Registry**: registry preserves GitHub org case (`100xPercent`), not lowercase. Updated `mcpName` from `io.github.100xpercent/pop-pay` to `io.github.100xPercent/pop-pay` so the npm-advertised MCP name matches the Official MCP Registry entry.

## [0.5.3] - 2026-04-10

### Changed
- **MCP marketplace listing metadata**: added `mcpName: io.github.100xpercent/pop-pay` to package.json for Official MCP Registry discovery, added `smithery.yaml` config schema for Smithery listing, bundled `assets/logo-400x400.png` for marketplace display.
- **GitHub org migration**: updated repository, homepage, bugs, README badges, SECURITY advisory link, and docs references from `TPEmist/pop-pay` to `100xPercent/pop-pay`.

## [0.5.2] - 2026-04-10

### Fixed
- **`request_purchaser_info` still blocked unapproved vendors after v0.5.0:** v0.5.0 was supposed to turn vendor blocking into pure audit logging, but the handler kept its original `return` guard, so the billing-info auto-fill was still hard-rejected when the vendor was absent from `POP_ALLOWED_CATEGORIES`. Vendor blocking is now explicitly controlled by `POP_PURCHASER_INFO_BLOCKING` (default `true`, zero-trust). **Security scan and domain-mismatch checks are never bypassed by this flag.**
- **Audit log rows did not record outcome/reason:** v0.5.0 wrote a single audit row at the top of the handler saying "this was attempted" without recording what actually happened. Operators had no way to tell a rejection from a success in the dashboard. The handler now emits exactly one audit row per call at the resolved exit point with `outcome` (`approved` / `rejected_vendor` / `rejected_security` / `blocked_bypassed` / `error_injector` / `error_fields`) and `rejection_reason` (human-readable context when relevant).

### Added
- **`POP_PURCHASER_INFO_BLOCKING` env var (default `true`):** explicit toggle for `request_purchaser_info` vendor allowlist enforcement. When set to any other string (e.g. `false`), the vendor check becomes advisory and the bypass is audited as `outcome='blocked_bypassed'`. Documented in `docs/ENV_REFERENCE.md` and `CONTRIBUTING.md` (Open Discussion section inviting community feedback on the default).
- **`audit_log.outcome` + `audit_log.rejection_reason` columns:** new columns on `audit_log`. Migration is idempotent and additive — existing rows written by v0.5.0 / v0.5.1 get `outcome='unknown'` so the dashboard can still surface them without breaking. `PopStateTracker.recordAuditEvent()` signature extended with `outcome` and `rejectionReason` args (backwards-compatible — both default to `null`).
- **Dashboard AUDIT_LOG — OUTCOME + REASON columns:** new columns in the dashboard audit table with color coding (`approved` green, rejected/error red, `blocked_bypassed` orange, `unknown` gray).
- **State-level test coverage** for `audit_log` outcome persistence and the legacy audit_log migration.

### Changed
- **Schema migration:** opening a legacy DB now also runs an additive `ALTER TABLE audit_log ADD COLUMN outcome TEXT` / `ADD COLUMN rejection_reason TEXT` pair (idempotent via `PRAGMA table_info` check). `src/dashboard.ts` does the same defensively so launching the dashboard before the tracker can't break the `/api/audit` SELECT.

## [0.5.1] - 2026-04-10

### Changed
- **Dashboard default port 3210 → 8860.** 8860 is less commonly occupied by other local-dev tooling than 3xxx ports, and ties into the "pay" brand root. Override with `--port` as before. Users running the dashboard with no explicit `--port` will need to update bookmarks to `http://localhost:8860`.

## [0.5.0] - 2026-04-10

### Added
- **`audit_log` table:** informational audit trail for MCP tool invocations. Every `request_purchaser_info` call now logs `event_type`, `vendor`, `reasoning`, and an ISO 8601 UTC timestamp. Non-blocking — failures to log never interrupt the main flow.
- **Dashboard AUDIT_LOG section:** new table rendering `/api/audit` events (id, event_type, vendor, reasoning, timestamp).
- **`PopStateTracker.recordAuditEvent()` / `.getAuditEvents()`:** public API for emitting and reading audit events.

### Fixed
- **Bug 1 — timestamps now ISO 8601 with `Z` suffix:** `issued_seals.timestamp` previously used SQLite `CURRENT_TIMESTAMP` which is ambiguous about timezone. New inserts use `new Date().toISOString()`. Legacy rows are migrated in-place on first open.
- **Bug 2 — `rejection_reason` column now persisted:** dashboard REJECTION_LOG previously showed an empty REASON column. Root cause was two-fold: (a) `issued_seals` had no `rejection_reason` column; (b) `dashboard.js` `renderRejected()` didn't emit a REASON cell even though the HTML header declared one. Both fixed. All three rejection paths in `client.ts` now pass the reason through. Migration adds the column to legacy DBs.
- **Bug 3 — dashboard "today spending" always $0 / utilization 0%:** Root cause (empirically verified, not hypothesized): `PopClient` constructor in `src/client.ts` defaulted `dbPath` to the relative string `"pop_state.db"`, so when the MCP server was launched from one working directory it wrote to `<cwd>/pop_state.db` while the dashboard read from `~/.config/pop-pay/pop_state.db` (the `PopStateTracker` default). `addSpend` was firing correctly — it was just writing to a file the dashboard never opened. Fix: drop the hardcoded default; when no `dbPath` is passed, construct `PopStateTracker` with no arg so both sides converge on `DEFAULT_DB_PATH`. Regression test added.
- **Dashboard XSS hardening:** `dashboard.js` used to inject raw values (seal_id, vendor, rejection_reason, audit reasoning) into `innerHTML`. All user-data cells now pass through `escapeHtml()`.
- **Dashboard/tracker schema drift:** `dashboard.ts` used to run its own inline `CREATE TABLE` which didn't know about new columns. It now delegates schema creation + migration to `PopStateTracker`, so the dashboard and MCP server always agree on schema even if the dashboard is launched first against a legacy DB.

### Changed
- **Schema migration (upgrade-safe):** opening a legacy DB now (1) rebuilds `issued_seals` if it still has `card_number`/`cvv` columns (very-legacy path, preserves masked data); (2) adds `rejection_reason` if missing; (3) rewrites legacy `YYYY-MM-DD HH:MM:SS` timestamps to ISO 8601 Z format; (4) creates `audit_log` table. Migration is idempotent.
- **Dashboard port 3210:** no functional change, but documented: port was chosen arbitrarily during initial dashboard bring-up and is kept for continuity with existing user bookmarks.

## [0.3.3] - 2026-04-09

### Fixed
- Card injection in Stripe multi-iframe layouts (Zoho Checkout). Fields are now filled independently across sibling iframes instead of requiring all fields in a single frame.

### Changed
- Removed `page_snapshot` as standalone MCP tool. Security scan is now automatically embedded in `request_virtual_card` and `request_purchaser_info`.
- MCP server exposes 3 tools (was 4): `request_virtual_card`, `request_purchaser_info`, `request_x402_payment`.

## [0.2.0] - 2026-04-05

### Added
- Major documentation overhaul with professional MCP standards.
- Platform setup guides for Claude Code, Cursor, Windsurf, and VS Code.
- Status badges (npm, License, CI, Node.js) to README.

## [0.1.2] - 2026-04-04

### Changed
- Hardened CI workflows with environment protection and explicit permissions.
- Moved salt injection to environment variables for improved security.

## [0.1.1] - 2026-04-04

### Added
- Automated npm publish workflow using OIDC trusted publishing.
- Repository metadata and `.npmignore` configuration.

## [0.1.0] - 2026-04-03

### Added
- Initial TypeScript + Rust port from the Python repository.
- **MCP Server**: Full Model Context Protocol implementation.
- **CDP Injection Engine**: Advanced DOM traversal supporting iframes and Shadow DOM.
- **CLI Commands**:
  - `pop-launch`: Starts Chrome with CDP and MCP.
  - `pop-init-vault`: Securely initializes the encrypted credential vault.
  - `pop-unlock`: Unlocks the vault using the OS keyring.
- **Security**: AES-256-GCM encryption for credentials and Rust native layer via napi-rs.
- **Testing**: Comprehensive suite with 170+ tests covering SSRF, TOCTOU, and vault interop.
- **Docker**: Containerized setup with headless Chromium.
- **New Tools**: Added `page_snapshot` for security scanning of checkout pages.
