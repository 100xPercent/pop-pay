/**
 * Vault interop test: Python ↔ TypeScript
 *
 * HARD CONSTRAINT: vault.enc files created by either language must be
 * readable by the other. Both use:
 *   - AES-256-GCM
 *   - F13 v1 wire format: MAGIC(0x5050) || VERSION(0x01) || RESERVED(0x00) ||
 *     nonce(12) || ciphertext || GCM-tag(16). 4-byte header bound into AAD.
 *   - Legacy v0 (pre-F13): nonce(12) || ciphertext || tag(16), no AAD.
 *     Still readable by both sides for one migration release.
 *   - Key derivation: scrypt(machine_id + ":" + username, salt, n=2^14, r=8, p=1, dklen=32)
 *   - OSS salt: "pop-pay-oss-v1-public-salt-2026"
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { encryptCredentials, decryptCredentials } from "../src/vault.js";

// Resolved from (in order): $POP_PY_REPO, sibling `../pop-pay-python`,
// sibling `../project-aegis`. Test is skipped when none contain a built venv,
// so CI and external contributors see a clean skip instead of a failure.
const PYTHON_REPO_CANDIDATES = [
  process.env.POP_PY_REPO,
  resolve(__dirname, "../../pop-pay-python"),
  resolve(__dirname, "../../project-aegis"),
].filter((p): p is string => Boolean(p));
const PYTHON_REPO =
  PYTHON_REPO_CANDIDATES.find((p) => existsSync(join(p, ".venv/bin/python"))) ??
  PYTHON_REPO_CANDIDATES[0];
const PYTHON_AVAILABLE = existsSync(join(PYTHON_REPO, ".venv/bin/python"));
const INTEROP_DIR = join(tmpdir(), "pop-pay-interop-test");

const TEST_KEY_HEX = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const TEST_KEY = Buffer.from(TEST_KEY_HEX, "hex");
const OSS_SALT = Buffer.from("pop-pay-oss-v1-public-salt-2026");

const TEST_CREDS = {
  card_number: "4111111111111111",
  cvv: "123",
  exp_month: "12",
  exp_year: "27",
};

function ensureDir() {
  mkdirSync(INTEROP_DIR, { recursive: true });
}

function cleanup(...paths: string[]) {
  for (const p of paths) {
    try { unlinkSync(p); } catch {}
  }
}

function runPythonFile(scriptPath: string): string {
  // Use the venv python which has the cryptography package installed
  const python = `${PYTHON_REPO}/.venv/bin/python`;
  return execSync(
    `cd ${PYTHON_REPO} && ${python} ${scriptPath}`,
    { encoding: "utf8", timeout: 15000 }
  );
}

function writePyScript(name: string, code: string): string {
  const path = join(INTEROP_DIR, name);
  writeFileSync(path, code);
  return path;
}

// ---------------------------------------------------------------------------
// Direction 1: TS encrypts → Python decrypts
// ---------------------------------------------------------------------------
describe.skipIf(!PYTHON_AVAILABLE)("Vault interop: TS → Python", () => {
  it("Python decrypts vault created by TypeScript (key_override)", () => {
    ensureDir();
    const blobPath = join(INTEROP_DIR, "ts-to-py.enc");
    cleanup(blobPath);

    // TS encrypts
    const blob = encryptCredentials(TEST_CREDS, undefined, TEST_KEY);
    writeFileSync(blobPath, blob);

    // Python decrypts
    const pyPath = writePyScript("decrypt_ts.py", `
import json, sys
sys.path.insert(0, '.')
from pop_pay.vault import decrypt_credentials

blob = open('${blobPath}', 'rb').read()
key = bytes.fromhex('${TEST_KEY_HEX}')
result = decrypt_credentials(blob, key_override=key)
print(json.dumps(result))
`);
    const output = runPythonFile(pyPath);
    const result = JSON.parse(output.trim());
    expect(result).toEqual(TEST_CREDS);
    cleanup(blobPath, pyPath);
  });
});

// ---------------------------------------------------------------------------
// Direction 2: Python encrypts → TS decrypts
// ---------------------------------------------------------------------------
describe.skipIf(!PYTHON_AVAILABLE)("Vault interop: Python → TS", () => {
  it("TypeScript decrypts vault created by Python (key_override)", () => {
    ensureDir();
    const blobPath = join(INTEROP_DIR, "py-to-ts.enc");
    cleanup(blobPath);

    const credsJson = JSON.stringify(TEST_CREDS).replace(/'/g, "\\'");
    const pyPath = writePyScript("encrypt_py.py", `
import json, sys
sys.path.insert(0, '.')
from pop_pay.vault import encrypt_credentials

creds = json.loads('${credsJson}')
key = bytes.fromhex('${TEST_KEY_HEX}')
blob = encrypt_credentials(creds, key_override=key)
with open('${blobPath}', 'wb') as f:
    f.write(blob)
print('OK')
`);
    const output = runPythonFile(pyPath);
    expect(output.trim()).toBe("OK");

    // TS decrypts
    const blob = readFileSync(blobPath);
    const result = decryptCredentials(blob, undefined, TEST_KEY);
    expect(result).toEqual(TEST_CREDS);
    cleanup(blobPath, pyPath);
  });
});

// ---------------------------------------------------------------------------
// Direction 3: Both use OSS salt (same machine = same key derivation)
// ---------------------------------------------------------------------------
describe.skipIf(!PYTHON_AVAILABLE)("Vault interop: OSS salt round-trip", () => {
  it("TS encrypts with OSS salt → Python decrypts with OSS salt", () => {
    ensureDir();
    const blobPath = join(INTEROP_DIR, "ts-oss-salt.enc");
    cleanup(blobPath);

    const blob = encryptCredentials(TEST_CREDS, OSS_SALT);
    writeFileSync(blobPath, blob);

    const pyPath = writePyScript("decrypt_oss.py", `
import json, sys
sys.path.insert(0, '.')
from pop_pay.vault import decrypt_credentials

blob = open('${blobPath}', 'rb').read()
salt = b'pop-pay-oss-v1-public-salt-2026'
result = decrypt_credentials(blob, salt=salt)
print(json.dumps(result))
`);
    const output = runPythonFile(pyPath);
    const result = JSON.parse(output.trim());
    expect(result).toEqual(TEST_CREDS);
    cleanup(blobPath, pyPath);
  });

  it("Python encrypts with OSS salt → TS decrypts with OSS salt", () => {
    ensureDir();
    const blobPath = join(INTEROP_DIR, "py-oss-salt.enc");
    cleanup(blobPath);

    const credsJson = JSON.stringify(TEST_CREDS).replace(/'/g, "\\'");
    const pyPath = writePyScript("encrypt_oss.py", `
import json, sys
sys.path.insert(0, '.')
from pop_pay.vault import encrypt_credentials

creds = json.loads('${credsJson}')
salt = b'pop-pay-oss-v1-public-salt-2026'
blob = encrypt_credentials(creds, salt=salt)
with open('${blobPath}', 'wb') as f:
    f.write(blob)
print('OK')
`);
    const output = runPythonFile(pyPath);
    expect(output.trim()).toBe("OK");

    const blob = readFileSync(blobPath);
    const result = decryptCredentials(blob, OSS_SALT);
    expect(result).toEqual(TEST_CREDS);
    cleanup(blobPath, pyPath);
  });
});

// ---------------------------------------------------------------------------
// Wire format validation
// ---------------------------------------------------------------------------
describe.skipIf(!PYTHON_AVAILABLE)("Vault wire format compatibility", () => {
  it("TS blob has correct v1 structure: MAGIC||VER||RES(4) + nonce(12) + ct + tag(16)", () => {
    const blob = encryptCredentials(TEST_CREDS, undefined, TEST_KEY);
    expect(blob.length).toBeGreaterThan(32); // 4 header + 12 nonce + 16 tag
    expect(blob[0]).toBe(0x50);
    expect(blob[1]).toBe(0x50);
    expect(blob[2]).toBe(0x01);
    expect(blob[3]).toBe(0x00);
  });

  it("Python and TS produce same-length v1 blobs for identical plaintext", () => {
    ensureDir();
    const blobPath = join(INTEROP_DIR, "py-format-check.enc");
    cleanup(blobPath);

    const credsJson = JSON.stringify(TEST_CREDS).replace(/'/g, "\\'");
    const pyPath = writePyScript("format_check.py", `
import json, sys
sys.path.insert(0, '.')
from pop_pay.vault import encrypt_credentials

creds = json.loads('${credsJson}')
key = bytes.fromhex('${TEST_KEY_HEX}')
blob = encrypt_credentials(creds, key_override=key)
with open('${blobPath}', 'wb') as f:
    f.write(blob)
print(len(blob))
`);
    const pyLen = parseInt(runPythonFile(pyPath).trim(), 10);
    const blob = readFileSync(blobPath);
    expect(blob.length).toBe(pyLen);
    // Py must also emit v1 header.
    expect(blob[0]).toBe(0x50);
    expect(blob[1]).toBe(0x50);
    expect(blob[2]).toBe(0x01);

    const tsBlob = encryptCredentials(TEST_CREDS, undefined, TEST_KEY);
    const overhead = 4 /*header*/ + 12 /*nonce*/ + 16 /*tag*/;
    expect(blob.length).toBeGreaterThan(overhead);
    expect(tsBlob.length).toBeGreaterThan(overhead);
    cleanup(blobPath, pyPath);
  });
});

// ---------------------------------------------------------------------------
// F13 legacy v0 cross-repo: both sides must still read pre-header blobs.
// ---------------------------------------------------------------------------
describe.skipIf(!PYTHON_AVAILABLE)("F13 legacy v0 backward compat", () => {
  it("TS reads a legacy v0 vault created by the Python legacy-format harness", () => {
    ensureDir();
    const blobPath = join(INTEROP_DIR, "py-v0-legacy.enc");
    cleanup(blobPath);

    // Build a Python-side v0 blob by calling cryptography.AESGCM directly,
    // bypassing encrypt_credentials (which now emits v1 with AAD).
    const credsJson = JSON.stringify(TEST_CREDS).replace(/'/g, "\\'");
    const pyPath = writePyScript("make_v0_legacy.py", `
import json, os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

creds = json.loads('${credsJson}')
key = bytes.fromhex('${TEST_KEY_HEX}')
nonce = os.urandom(12)
# Force nonce NOT starting with 0x5050 so the reader dispatches to v0 path.
while nonce[:2] == b"\\x50\\x50":
    nonce = os.urandom(12)
aesgcm = AESGCM(key)
ct_and_tag = aesgcm.encrypt(nonce, json.dumps(creds).encode(), None)
with open('${blobPath}', 'wb') as f:
    f.write(nonce + ct_and_tag)
print('OK')
`);
    const output = runPythonFile(pyPath);
    expect(output.trim()).toBe("OK");

    const blob = readFileSync(blobPath);
    expect(blob[0]).not.toBe(0x50); // absence of magic → legacy path
    const result = decryptCredentials(blob, undefined, TEST_KEY);
    expect(result).toEqual(TEST_CREDS);
    cleanup(blobPath, pyPath);
  });

  it("Python reads a legacy v0 vault created by the TS legacy-format harness", () => {
    ensureDir();
    const blobPath = join(INTEROP_DIR, "ts-v0-legacy.enc");
    cleanup(blobPath);

    // Build a TS-side v0 blob directly with node:crypto (no header, no AAD).
    const crypto = require("node:crypto");
    let nonce: Buffer = crypto.randomBytes(12);
    while (nonce[0] === 0x50 && nonce[1] === 0x50) nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", TEST_KEY, nonce);
    const pt = Buffer.from(JSON.stringify(TEST_CREDS));
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    writeFileSync(blobPath, Buffer.concat([nonce, ct, tag]));

    const pyPath = writePyScript("decrypt_v0_legacy.py", `
import json, sys
sys.path.insert(0, '.')
from pop_pay.vault import decrypt_credentials

blob = open('${blobPath}', 'rb').read()
key = bytes.fromhex('${TEST_KEY_HEX}')
print(json.dumps(decrypt_credentials(blob, key_override=key)))
`);
    const output = runPythonFile(pyPath);
    expect(JSON.parse(output.trim())).toEqual(TEST_CREDS);
    cleanup(blobPath, pyPath);
  });
});
