import { describe, it, expect } from "vitest";
import { encryptCredentials, decryptCredentials, parseVaultMode } from "../src/vault.js";

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
