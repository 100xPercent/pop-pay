import { describe, it, expect } from "vitest";
import { encryptCredentials, decryptCredentials } from "../src/vault.js";

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
