/**
 * pop-pay credential vault — AES-256-GCM encrypted credential storage.
 *
 * Security model:
 * - Credentials are encrypted at rest using AES-256-GCM with a machine-derived key.
 * - The key is derived from a stable machine identifier using scrypt.
 * - Plaintext credentials never touch disk after init-vault completes.
 * - OSS version uses a public salt (documented limitation).
 * - Option B passphrase mode: key derived from user passphrase via PBKDF2-HMAC-SHA256
 *   (600k iterations); stored in OS keyring for the session.
 */

import { createHash, scryptSync, randomBytes, pbkdf2Sync } from "node:crypto";
import * as crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { VaultDecryptFailed, VaultNotFound, VaultLocked } from "./errors.js";

const VAULT_DIR = join(homedir(), ".config", "pop-pay");
const VAULT_PATH = join(VAULT_DIR, "vault.enc");

const KEYRING_SERVICE = "pop-pay-vault";
const KEYRING_USERNAME = "derived-key-hex";

// OSS public salt — intentionally documented as a security limitation.
const OSS_SALT = Buffer.from("pop-pay-oss-v1-public-salt-2026");

export const OSS_WARNING =
  "\n\u26a0\ufe0f  pop-pay SECURITY NOTICE: Running from source build (OSS mode).\n" +
  "   Vault encryption uses a public salt. An agent with shell execution\n" +
  "   tools could derive the vault key from public information.\n" +
  "   For stronger security: install via npm (`npm install pop-pay`)\n" +
  "   or use `pop-pay init-vault --passphrase` (coming soon).\n";

function getMachineId(): Buffer {
  // Linux: /etc/machine-id
  try {
    const mid = readFileSync("/etc/machine-id", "utf8").trim();
    if (mid) return Buffer.from(mid);
  } catch {}

  // macOS: IOPlatformUUID
  if (platform() === "darwin") {
    try {
      const result = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
        timeout: 5000,
        encoding: "utf8",
      });
      for (const line of result.split("\n")) {
        if (line.includes("IOPlatformUUID")) {
          const parts = line.split('"');
          return Buffer.from(parts[parts.length - 2]);
        }
      }
    } catch {}
  }

  // Windows: MachineGuid from registry
  if (platform() === "win32") {
    try {
      const result = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { timeout: 5000, encoding: "utf8" }
      );
      const match = result.match(/MachineGuid\s+REG_SZ\s+(.+)/);
      if (match) return Buffer.from(match[1].trim());
    } catch {}
  }

  // Fallback: generate and store random ID
  const fallbackPath = join(VAULT_DIR, ".machine_id");
  if (existsSync(fallbackPath)) {
    return readFileSync(fallbackPath);
  }
  const fallbackId = randomBytes(32);
  mkdirSync(VAULT_DIR, { recursive: true });
  writeFileSync(fallbackPath, fallbackId, { mode: 0o600 });
  return fallbackId;
}

function getUsername(): Buffer {
  try {
    return Buffer.from(userInfo().username);
  } catch {}
  return Buffer.from(process.env.USER ?? process.env.USERNAME ?? "unknown");
}

function deriveKey(salt?: Buffer, keyOverride?: Buffer): Buffer {
  if (keyOverride) return keyOverride;

  const machineId = getMachineId();
  const username = getUsername();

  // Try Rust napi-rs hardened path first
  if (!salt) {
    try {
      const native = require("../native/pop-pay-native.node");
      const key = native.deriveKey(machineId, username);
      if (key) return Buffer.from(key);
    } catch {}
    salt = OSS_SALT;
  }

  const password = Buffer.concat([machineId, Buffer.from(":"), username]);
  // scrypt: n=2^14, r=8, p=1, dklen=32 (matches Python)
  return scryptSync(password, salt, 32, { N: 2 ** 14, r: 8, p: 1 });
}

export function deriveKeyFromPassphrase(passphrase: string): Buffer {
  const machineId = getMachineId();
  return pbkdf2Sync(passphrase, machineId, 600_000, 32, "sha256");
}

// Keyring helpers (optional keytar dependency)
export function storeKeyInKeyring(key: Buffer): void {
  try {
    const keytar = require("keytar");
    keytar.setPassword(KEYRING_SERVICE, KEYRING_USERNAME, key.toString("hex"));
  } catch (e) {
    throw new VaultLocked({
      cause: e,
      remediation: "Install keytar: npm install keytar",
    });
  }
}

export async function loadKeyFromKeyring(): Promise<Buffer | null> {
  try {
    const keytar = require("keytar");
    const hexKey = await keytar.getPassword(KEYRING_SERVICE, KEYRING_USERNAME);
    if (hexKey) return Buffer.from(hexKey, "hex");
  } catch {}
  return null;
}

export async function clearKeyring(): Promise<void> {
  try {
    const keytar = require("keytar");
    await keytar.deletePassword(KEYRING_SERVICE, KEYRING_USERNAME);
  } catch {}
}

export function encryptCredentials(
  creds: Record<string, string>,
  salt?: Buffer,
  keyOverride?: Buffer
): Buffer {
  const key = deriveKey(salt, keyOverride);
  const nonce = randomBytes(12); // 96-bit random nonce
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(creds));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  // Format: nonce (12) + ciphertext + tag (16) — matches Python cryptography lib output
  return Buffer.concat([nonce, encrypted, tag]);
}

export function decryptCredentials(
  blob: Buffer,
  salt?: Buffer,
  keyOverride?: Buffer
): Record<string, string> {
  if (blob.length < 28) {
    // 12 nonce + at least 16 GCM tag
    throw new VaultDecryptFailed("vault.enc is corrupted or too small");
  }
  const key = deriveKey(salt, keyOverride);
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch (e) {
    throw new VaultDecryptFailed(
      "Failed to decrypt vault \u2014 wrong key (machine changed?) or corrupted vault.",
      { cause: e },
    );
  }
}

export function vaultExists(): boolean {
  return existsSync(VAULT_PATH);
}

function writeVaultMode(): void {
  let mode = "oss";
  try {
    const native = require("../native/pop-pay-native.node");
    mode = native.isHardened() ? "hardened" : "oss";
  } catch {}
  const markerPath = join(VAULT_DIR, ".vault_mode");
  writeFileSync(markerPath, mode, { mode: 0o600 });
}

function readVaultMode(): string {
  const markerPath = join(VAULT_DIR, ".vault_mode");
  try {
    return readFileSync(markerPath, "utf8").trim();
  } catch {
    return "unknown";
  }
}

export async function loadVault(): Promise<Record<string, string>> {
  // Downgrade check
  const vaultMode = readVaultMode();
  if (vaultMode === "hardened") {
    try {
      const native = require("../native/pop-pay-native.node");
      if (!native.isHardened()) {
        throw new VaultDecryptFailed(
          "Vault was created with a hardened build, but the native extension is missing or not hardened.",
          { remediation: "Reinstall via npm: npm install pop-pay" },
        );
      }
    } catch (e: any) {
      if (e instanceof VaultDecryptFailed) throw e;
      if (e?.code === "MODULE_NOT_FOUND") {
        throw new VaultDecryptFailed(
          "Vault requires hardened build but native module not found.",
          { cause: e, remediation: "Reinstall via npm: npm install pop-pay" },
        );
      }
      throw new VaultDecryptFailed(
        e?.message ?? "Vault hardened-build check failed",
        { cause: e },
      );
    }
  }

  if (!existsSync(VAULT_PATH)) {
    throw new VaultNotFound();
  }
  const blob = readFileSync(VAULT_PATH);

  // Try passphrase-derived key from keyring first
  const passphraseKey = await loadKeyFromKeyring();
  if (passphraseKey) {
    try {
      return decryptCredentials(blob, undefined, passphraseKey);
    } catch (e) {
      if (!(e instanceof VaultDecryptFailed)) throw e;
      // Wrong passphrase key — fall through to machine-derived key (expected path)
    }
  }
  return decryptCredentials(blob);
}

export function saveVault(creds: Record<string, string>, keyOverride?: Buffer): void {
  mkdirSync(VAULT_DIR, { recursive: true });
  const blob = encryptCredentials(creds, undefined, keyOverride);
  // Atomic write: tmp → rename
  const tmpPath = VAULT_PATH + ".tmp";
  writeFileSync(tmpPath, blob, { mode: 0o600 });
  
  const fs = require("node:fs");
  const fd = fs.openSync(tmpPath, "r+");
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  fs.renameSync(tmpPath, VAULT_PATH);
  fs.chmodSync(VAULT_PATH, 0o600);
  fs.chmodSync(VAULT_DIR, 0o700);
  // Verify the vault is readable
  const verifyBlob = readFileSync(VAULT_PATH);
  decryptCredentials(verifyBlob, undefined, keyOverride);
  // Write mode marker
  writeVaultMode();
}

export function secureWipeEnv(envPath: string): void {
  if (!existsSync(envPath)) return;
  const size = statSync(envPath).size;
  writeFileSync(envPath, Buffer.alloc(size, 0));
  unlinkSync(envPath);
}

// Names of env vars that carry plaintext PAN/CVV/expiry. Redacted from child
// process environments so spawned tools (browsers, doctor, scripts) cannot
// observe card data via their own env read. Vault plaintext never enters
// process.env in the first place (see S0.7 F1); this is defense in depth.
export const SENSITIVE_ENV_KEYS = Object.freeze([
  "POP_BYOC_NUMBER",
  "POP_BYOC_CVV",
  "POP_BYOC_EXP_MONTH",
  "POP_BYOC_EXP_YEAR",
]);

export function filteredEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (SENSITIVE_ENV_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}
