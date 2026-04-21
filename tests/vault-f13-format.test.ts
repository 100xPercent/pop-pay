/**
 * F13 — vault blob format version byte.
 *
 * Covers:
 *  - v1 blob layout: MAGIC(0x5050) || VERSION(0x01) || RESERVED(0x00) || body
 *  - AEAD AAD binding: tampered header fails with VaultDecryptFailed
 *  - Unknown VERSION byte raises "format vN not supported"
 *  - Legacy v0 (no-header) blob round-trips via fallback path
 *  - One-time legacy migration notice
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  encryptCredentials,
  decryptCredentials,
  _resetLegacyMigrationNotified,
} from "../src/vault.js";
import { VaultDecryptFailed } from "../src/errors.js";
import * as crypto from "node:crypto";

const TEST_SALT = Buffer.from("test-salt-for-unit-tests-pop-pay");
const TEST_KEY = Buffer.from(
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  "hex",
);
const CREDS = { card_number: "4111111111111111", cvv: "123" };

/** Build a legacy v0 (pre-F13) blob: nonce(12) || ct || tag(16), no AAD. */
function buildLegacyV0Blob(key: Buffer, creds: Record<string, string>): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const pt = Buffer.from(JSON.stringify(creds));
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

describe("F13 — v1 blob layout", () => {
  it("emits header MAGIC || VERSION || RESERVED at offset 0", () => {
    const blob = encryptCredentials(CREDS, undefined, TEST_KEY);
    expect(blob[0]).toBe(0x50);
    expect(blob[1]).toBe(0x50);
    expect(blob[2]).toBe(0x01);
    expect(blob[3]).toBe(0x00);
  });

  it("v1 blob is exactly 4 bytes longer than an equivalent v0 blob", () => {
    const v1 = encryptCredentials(CREDS, undefined, TEST_KEY);
    const v0 = buildLegacyV0Blob(TEST_KEY, CREDS);
    // Same plaintext + same tag/nonce sizes; only the 4-byte header differs.
    expect(v1.length).toBe(v0.length + 4);
  });

  it("v1 round-trips (encrypt → decrypt)", () => {
    const blob = encryptCredentials(CREDS, TEST_SALT);
    expect(decryptCredentials(blob, TEST_SALT)).toEqual(CREDS);
  });
});

describe("F13 — AEAD AAD binding", () => {
  it("tampered RESERVED byte fails AEAD tag verification", () => {
    const blob = encryptCredentials(CREDS, undefined, TEST_KEY);
    const tampered = Buffer.from(blob);
    tampered[3] = 0xff; // flip RESERVED — still has magic + version 0x01
    expect(() => decryptCredentials(tampered, undefined, TEST_KEY)).toThrow(
      VaultDecryptFailed,
    );
  });

  it("tampered VERSION byte is rejected before AEAD", () => {
    const blob = encryptCredentials(CREDS, undefined, TEST_KEY);
    const tampered = Buffer.from(blob);
    tampered[2] = 0x02; // claim version 2 — not supported
    expect(() => decryptCredentials(tampered, undefined, TEST_KEY)).toThrow(
      /format v2 not supported/,
    );
  });
});

describe("F13 — legacy v0 backward compat", () => {
  beforeEach(() => {
    _resetLegacyMigrationNotified();
  });

  it("decrypts a pre-F13 blob (no header, no AAD)", () => {
    const v0 = buildLegacyV0Blob(TEST_KEY, CREDS);
    expect(v0[0]).not.toBe(0x50); // sanity — magic almost never by accident
    // Build a fresh v0 with a nonce that doesn't accidentally start with 0x5050.
    // Probability is 1/65536; retry if we hit it.
    let blob = v0;
    while (blob[0] === 0x50 && blob[1] === 0x50) {
      blob = buildLegacyV0Blob(TEST_KEY, CREDS);
    }
    expect(decryptCredentials(blob, undefined, TEST_KEY)).toEqual(CREDS);
  });

  it("emits one-time migration notice to stderr on first legacy read", () => {
    let written = "";
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test-only stderr monkey-patch
    process.stderr.write = (chunk: any) => {
      written += String(chunk);
      return true;
    };
    try {
      let blob = buildLegacyV0Blob(TEST_KEY, CREDS);
      while (blob[0] === 0x50 && blob[1] === 0x50) {
        blob = buildLegacyV0Blob(TEST_KEY, CREDS);
      }
      decryptCredentials(blob, undefined, TEST_KEY);
      decryptCredentials(blob, undefined, TEST_KEY); // second read — no new message
    } finally {
      process.stderr.write = orig;
    }
    const matches = written.match(/migrating vault to format v1/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("F13 — v1→v0 fallback (magic-byte collision)", () => {
  /** Build a legacy v0 blob with an explicitly chosen nonce (first 4 bytes
   * fixed to 0x5050 0x01 0x00 so the reader's v1 path sees matching magic
   * + VERSION and attempts AAD decrypt before falling back to v0). */
  function buildCollidedV0(): Buffer {
    const nonce = Buffer.concat([
      Buffer.from([0x50, 0x50, 0x01, 0x00]),
      crypto.randomBytes(8),
    ]);
    const cipher = crypto.createCipheriv("aes-256-gcm", TEST_KEY, nonce);
    const pt = Buffer.from(JSON.stringify(CREDS));
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, ct, tag]);
  }

  it("decrypts a v0 blob whose nonce bytes collide with v1 magic+version", () => {
    const blob = buildCollidedV0();
    expect(blob[0]).toBe(0x50);
    expect(blob[1]).toBe(0x50);
    expect(blob[2]).toBe(0x01);
    expect(decryptCredentials(blob, undefined, TEST_KEY)).toEqual(CREDS);
  });
});

describe("F13 — migration rewrite-on-save", () => {
  it("after reading a legacy v0 blob, encryptCredentials yields a v1 blob", () => {
    _resetLegacyMigrationNotified();
    let v0 = buildLegacyV0Blob(TEST_KEY, CREDS);
    while (v0[0] === 0x50 && v0[1] === 0x50) {
      v0 = buildLegacyV0Blob(TEST_KEY, CREDS);
    }
    const decoded = decryptCredentials(v0, undefined, TEST_KEY);
    expect(decoded).toEqual(CREDS);
    // Simulate "next save" — encryptCredentials always produces v1.
    const rewritten = encryptCredentials(decoded, undefined, TEST_KEY);
    expect(rewritten[0]).toBe(0x50);
    expect(rewritten[1]).toBe(0x50);
    expect(rewritten[2]).toBe(0x01);
  });
});
