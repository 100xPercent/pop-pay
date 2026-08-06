// pop-pay native loader — resolves the right pre-built binary for this
// platform at runtime. The published tarball carries one
// pop-pay-native.<triple>.node per supported OS/arch (napi-rs --platform
// convention). This file picks one based on process.platform + process.arch
// and throws MODULE_NOT_FOUND for unsupported hosts so vault.ts's downgrade
// check (F4) surfaces the correct remediation ("Reinstall via npm").
"use strict";

const TRIPLES = {
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "win32-x64": "win32-x64-msvc",
};

const key = `${process.platform}-${process.arch}`;
const triple = TRIPLES[key];

if (!triple) {
  const err = new Error(`pop-pay-native: no prebuilt binary for ${key}`);
  err.code = "MODULE_NOT_FOUND";
  throw err;
}

try {
  module.exports = require(`./pop-pay-native.${triple}.node`);
} catch (e) {
  if (e && e.code === "MODULE_NOT_FOUND") throw e;
  const wrapped = new Error(
    `pop-pay-native: failed to load ${triple}: ${(e && e.message) || e}`
  );
  wrapped.code = "MODULE_NOT_FOUND";
  wrapped.cause = e;
  throw wrapped;
}
