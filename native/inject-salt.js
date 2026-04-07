#!/usr/bin/env node
/**
 * Injects XOR-split salt into native/src/lib.rs before Rust compilation.
 *
 * Usage: POP_VAULT_COMPILED_SALT=mysecret node native/inject-salt.js
 *
 * If POP_VAULT_COMPILED_SALT is not set, lib.rs remains unchanged
 * (A1 and B2 stay None → OSS mode).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const salt = process.env.POP_VAULT_COMPILED_SALT;
if (!salt) {
  console.log("POP_VAULT_COMPILED_SALT not set — skipping salt injection (OSS mode).");
  process.exit(0);
}

const saltBytes = Buffer.from(salt, "utf-8");
const mask = crypto.randomBytes(saltBytes.length);
const xorData = Buffer.alloc(saltBytes.length);
for (let i = 0; i < saltBytes.length; i++) {
  xorData[i] = saltBytes[i] ^ mask[i];
}

// Format as Rust byte array literals
const a1Rust = `Some(&[${Array.from(xorData).join(", ")}])`;
const b2Rust = `Some(&[${Array.from(mask).join(", ")}])`;

const libPath = path.join(__dirname, "src", "lib.rs");
let source = fs.readFileSync(libPath, "utf-8");
const original = source;

source = source.replace(
  "static A1: Option<&[u8]> = None;",
  `static A1: Option<&[u8]> = ${a1Rust};`
);
source = source.replace(
  "static B2: Option<&[u8]> = None;",
  `static B2: Option<&[u8]> = ${b2Rust};`
);

fs.writeFileSync(libPath, source);
console.log(`Salt injected (${saltBytes.length} bytes, XOR-split into A1/B2).`);

// Register cleanup to restore original on exit
process.on("exit", () => {
  fs.writeFileSync(libPath, original);
  console.log("lib.rs restored to original (salt removed).");
});
