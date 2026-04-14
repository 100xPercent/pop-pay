import { describe, it, expect } from "vitest";
import { encryptCredentials, decryptCredentials, parseVaultMode, enforceOssSaltConsent } from "../src/vault.js";
import { VaultDecryptFailed } from "../src/errors.js";

describe("Vault encrypt/decrypt", () => {
  const testSalt = Buffer.from("test-salt-for-unit-tests-pop-pay");

  it("round-trips credentials", () => {
    const creds = { card_number: "4111111111111111", cvv: "123", exp_month: "12", exp_year: "27" };
    const blob = encryptCredentials(creds, testSalt);
    const decrypted = decryptCredentials(blob, testSalt);
    expect(decrypted).toEqual(creds);
  });

  it("fails with wrong salt", () => {
    const creds = { card_number: "4111111111111111", cvv: "123" };
    const blob = encryptCredentials(creds, testSalt);
    const wrongSalt = Buffer.from("wrong-salt-for-testing-pop-pay!!");
    expect(() => decryptCredentials(blob, wrongSalt)).toThrow();
  });

  it("fails with corrupted data", () => {
    expect(() => decryptCredentials(Buffer.from("short"), testSalt)).toThrow("corrupted");
  });

  it("encrypts with key override", () => {
    const creds = { test: "value" };
    const key = Buffer.alloc(32, 0xab);
    const blob = encryptCredentials(creds, undefined, key);
    const decrypted = decryptCredentials(blob, undefined, key);
    expect(decrypted).toEqual(creds);
  });
});

// F4/F7: vault marker schema + legacy migration (S0.7).
describe("parseVaultMode (F4/F7)", () => {
  it("returns 'unknown' for null/undefined/empty", () => {
    expect(parseVaultMode(null)).toBe("unknown");
    expect(parseVaultMode(undefined)).toBe("unknown");
    expect(parseVaultMode("")).toBe("unknown");
  });

  it("migrates legacy 'hardened' to 'machine-hardened'", () => {
    expect(parseVaultMode("hardened")).toBe("machine-hardened");
    expect(parseVaultMode("hardened\n")).toBe("machine-hardened");
  });

  it("migrates legacy 'oss' to 'machine-oss'", () => {
    expect(parseVaultMode("oss")).toBe("machine-oss");
  });

  it("passes through new-schema values", () => {
    expect(parseVaultMode("passphrase")).toBe("passphrase");
    expect(parseVaultMode("machine-hardened")).toBe("machine-hardened");
    expect(parseVaultMode("machine-oss")).toBe("machine-oss");
  });

  it("returns 'unknown' for unrecognized values", () => {
    expect(parseVaultMode("garbage")).toBe("unknown");
    expect(parseVaultMode("HARDENED")).toBe("unknown"); // case-sensitive
  });
});

// F3: OSS salt consent gate (S0.7).
describe("enforceOssSaltConsent (F3)", () => {
  function withEnv(val: string | undefined, fn: () => void) {
    const prev = process.env.POP_ACCEPT_OSS_SALT;
    if (val === undefined) delete process.env.POP_ACCEPT_OSS_SALT;
    else process.env.POP_ACCEPT_OSS_SALT = val;
    try { fn(); }
    finally {
      if (prev === undefined) delete process.env.POP_ACCEPT_OSS_SALT;
      else process.env.POP_ACCEPT_OSS_SALT = prev;
    }
  }

  it("refuses machine-oss without POP_ACCEPT_OSS_SALT=1", () => {
    withEnv(undefined, () => {
      expect(() => enforceOssSaltConsent("machine-oss")).toThrow(VaultDecryptFailed);
      expect(() => enforceOssSaltConsent("machine-oss")).toThrow(/POP_ACCEPT_OSS_SALT/);
    });
  });

  it("allows machine-oss when POP_ACCEPT_OSS_SALT=1", () => {
    withEnv("1", () => {
      expect(() => enforceOssSaltConsent("machine-oss")).not.toThrow();
    });
  });

  it("rejects non-'1' values (0, true, yes)", () => {
    for (const v of ["0", "true", "yes", ""]) {
      withEnv(v, () => {
        expect(() => enforceOssSaltConsent("machine-oss")).toThrow(/POP_ACCEPT_OSS_SALT/);
      });
    }
  });

  it("passphrase / machine-hardened / unknown bypass the gate", () => {
    withEnv(undefined, () => {
      expect(() => enforceOssSaltConsent("passphrase")).not.toThrow();
      expect(() => enforceOssSaltConsent("machine-hardened")).not.toThrow();
      expect(() => enforceOssSaltConsent("unknown")).not.toThrow();
    });
  });
});
