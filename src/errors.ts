/**
 * pop-pay error classes — minimal subset.
 *
 * This file ships only the vault-scoped classes (VaultNotFound,
 * VaultDecryptFailed, VaultLocked) used by src/vault.ts. The full
 * PopPayError hierarchy (config, guardrail, injector, llm + handleCliError)
 * lives on `feat/error-refactor` (commit 3427373) and will land separately.
 *
 * Class signatures here are byte-compatible with the version on that branch,
 * so when error-refactor merges to main this file becomes a strict subset
 * and merges cleanly.
 */

export type PopPayErrorOptions = {
  remediation?: string;
  cause?: unknown;
};

export class PopPayError extends Error {
  readonly code: string;
  readonly remediation?: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, opts: PopPayErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.remediation = opts.remediation;
    this.cause = opts.cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
    };
  }
}

export class PopPayVaultError extends PopPayError {}

export class VaultNotFound extends PopPayVaultError {
  constructor(opts: PopPayErrorOptions = {}) {
    super("VAULT_NOT_FOUND", "No vault found.", {
      remediation: "Run: pop-pay init-vault",
      ...opts,
    });
  }
}

export class VaultDecryptFailed extends PopPayVaultError {
  constructor(
    message = "Failed to decrypt vault \u2014 wrong key or corrupted vault.",
    opts: PopPayErrorOptions = {},
  ) {
    super("VAULT_DECRYPT_FAILED", message, {
      remediation: "Re-run: pop-pay init-vault",
      ...opts,
    });
  }
}

export class VaultLocked extends PopPayVaultError {
  constructor(opts: PopPayErrorOptions = {}) {
    super("VAULT_LOCKED", "Vault is locked (passphrase mode, no key in keyring).", {
      remediation: "Run: pop-unlock",
      ...opts,
    });
  }
}
