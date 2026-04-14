#!/usr/bin/env node
/**
 * pop-init-vault: Interactive setup to encrypt card credentials.
 * pop-unlock: Unlock vault for passphrase mode sessions.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  saveVault,
  vaultExists,
  secureWipeEnv,
  deriveKeyFromPassphrase,
  storeKeyInKeyring,
  clearKeyring,
  loadKeyFromKeyring,
  decryptCredentials,
  OSS_WARNING,
} from "./vault.js";

const VAULT_DIR = join(homedir(), ".config", "pop-pay");
const VAULT_PATH = join(VAULT_DIR, "vault.enc");

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let input = "";
    const onData = (char: Buffer) => {
      const c = char.toString("utf8");
      if (c === "\n" || c === "\r" || c === "\u0004") {
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input.trim());
      } else if (c === "\u0003") {
        process.exit(1);
      } else if (c === "\u007f" || c === "\b") {
        input = input.slice(0, -1);
      } else {
        input += c;
      }
    };
    stdin.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// pop-init-vault
// ---------------------------------------------------------------------------
async function cmdInitVault(): Promise<void> {
  const usePassphrase = process.argv.includes("--passphrase");

  console.log("pop-pay vault setup");
  console.log("=".repeat(40));
  console.log("Your card credentials will be encrypted and stored at:");
  console.log(`  ${VAULT_PATH}`);
  console.log();
  console.log(OSS_WARNING);

  if (vaultExists()) {
    const overwrite = await prompt("A vault already exists. Overwrite? [y/N]: ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  // F3: OSS salt consent gate at init time. If not using passphrase AND the
  // native extension isn't hardened, require explicit consent — either
  // POP_ACCEPT_OSS_SALT=1 or interactive y/N when stdin is a TTY.
  if (!usePassphrase) {
    let hardened = false;
    try {
      const native = require("../native/pop-pay-native.node");
      hardened = native.isHardened?.() ?? false;
    } catch {}
    if (!hardened) {
      if (process.env.POP_ACCEPT_OSS_SALT === "1") {
        // pre-acknowledged — proceed
      } else if (process.stdin.isTTY) {
        const ack = await prompt(
          "Proceed with OSS public salt? This offers weaker protection than --passphrase. [y/N]: ",
        );
        if (ack.toLowerCase() !== "y") {
          console.log("Aborted. Re-run with --passphrase, or set POP_ACCEPT_OSS_SALT=1.");
          process.exit(1);
        }
      } else {
        console.error(
          "pop-init-vault: OSS public salt requires consent. " +
          "Set POP_ACCEPT_OSS_SALT=1 or pass --passphrase.",
        );
        process.exit(1);
      }
    }
  }

  let keyOverride: Buffer | undefined;
  if (usePassphrase) {
    console.log("\nPassphrase mode: your vault will be encrypted with a passphrase.");
    console.log("You must run `pop-unlock` before each MCP server session.\n");
    while (true) {
      const p1 = await promptHidden("  Choose passphrase: ");
      const p2 = await promptHidden("  Confirm passphrase: ");
      if (p1 !== p2) {
        console.log("  Passphrases do not match. Try again.");
        continue;
      }
      if (p1.length < 8) {
        console.log("  Passphrase must be at least 8 characters.");
        continue;
      }
      keyOverride = deriveKeyFromPassphrase(p1);
      storeKeyInKeyring(keyOverride);
      console.log("  Passphrase set. Vault unlocked for this session.");
      break;
    }
  }

  console.log("Enter your card credentials (input is hidden):");
  const cardNumber = (await promptHidden("  Card number: "))
    .replace(/\s/g, "")
    .replace(/-/g, "");
  const expMonth = await promptHidden("  Expiry month (MM): ");
  const expYear = await promptHidden("  Expiry year (YY): ");
  const cvv = await promptHidden("  CVV: ");

  const creds: Record<string, string> = {
    card_number: cardNumber,
    cvv,
    exp_month: expMonth,
    exp_year: expYear,
    expiration_date: `${expMonth}/${expYear}`,
  };

  console.log("\nEncrypting and writing vault...");
  try {
    saveVault(creds, keyOverride);
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
  console.log(`Vault written to ${VAULT_PATH}`);

  // Handle policy .env
  const policyEnvPath = join(VAULT_DIR, ".env");
  const envCandidates = [policyEnvPath, join(process.cwd(), ".env")];

  let wipedPolicyEnv = false;
  for (const envPath of envCandidates) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf8");
      if (content.includes("POP_BYOC_NUMBER") || content.includes("POP_BYOC_CVV")) {
        const wipe = await prompt(
          `\n\x1b[1;31m${envPath} contains card credentials. Securely wipe it?\x1b[0m [y/N]: `
        );
        if (wipe.toLowerCase() === "y") {
          secureWipeEnv(envPath);
          console.log(`${envPath} wiped.`);
          if (envPath === policyEnvPath) wipedPolicyEnv = true;
        }
      }
    }
  }

  // Offer to create policy template
  if (!existsSync(policyEnvPath) || wipedPolicyEnv) {
    console.log(`\nNo policy config found at ${policyEnvPath}.`);
    const create = await prompt("Create a policy template .env? [y/N]: ");
    if (create.toLowerCase() === "y") {
      mkdirSync(VAULT_DIR, { recursive: true });
      writeFileSync(
        policyEnvPath,
        `# pop-pay policy configuration
# Card credentials are stored in vault.enc — do not add them here.

# Vendors the agent is allowed to pay (JSON array)
POP_ALLOWED_CATEGORIES=["aws", "cloudflare", "openai", "github", "Wikipedia", "donation", "Wikimedia"]

# Spending limits
POP_MAX_PER_TX=100.0
POP_MAX_DAILY=500.0
POP_BLOCK_LOOPS=true

# CDP injection (required for BYOC card filling)
POP_AUTO_INJECT=true
POP_CDP_URL=http://localhost:9222

# Guardrail engine: keyword (default, zero-cost) or llm
# POP_GUARDRAIL_ENGINE=keyword

# Billing info for auto-filling name/address fields on checkout pages
# POP_BILLING_FIRST_NAME=Bob
# POP_BILLING_LAST_NAME=Smith
# POP_BILLING_EMAIL=bob@example.com
# POP_BILLING_PHONE_COUNTRY_CODE=+1
# POP_BILLING_PHONE=+14155551234
# POP_BILLING_STREET=123 Main St
# POP_BILLING_CITY=Redwood City
# POP_BILLING_ZIP=94043
# POP_BILLING_STATE=CA
# POP_BILLING_COUNTRY=US
`,
        { mode: 0o600 }
      );
      console.log(`Template created at ${policyEnvPath} — edit to set your policy.`);
    }
  }

  if (usePassphrase) {
    console.log("\nSetup complete. This session is already unlocked.");
    console.log("Run `pop-unlock` before each new MCP server session.");
  } else {
    console.log("\nSetup complete. The MCP server will auto-decrypt the vault at startup.");
  }
}

// ---------------------------------------------------------------------------
// pop-unlock
// ---------------------------------------------------------------------------
async function cmdUnlock(): Promise<void> {
  const doLock = process.argv.includes("--lock");

  if (doLock) {
    await clearKeyring();
    console.log("Vault locked — key removed from keyring.");
    console.log("Restart the MCP server to apply.");
    return;
  }

  if (!vaultExists()) {
    console.log("No vault found. Run `pop-init-vault` first.");
    process.exit(1);
  }

  const passphrase = await promptHidden("Vault passphrase: ");
  if (!passphrase) {
    console.log("Passphrase cannot be empty.");
    process.exit(1);
  }

  const key = deriveKeyFromPassphrase(passphrase);
  try {
    const blob = readFileSync(VAULT_PATH);
    decryptCredentials(blob, undefined, key);
  } catch {
    console.log("Wrong passphrase — vault not unlocked.");
    process.exit(1);
  }

  storeKeyInKeyring(key);
  console.log("Vault unlocked for this session.");
  console.log("Start (or restart) the MCP server — it will auto-decrypt using the stored key.");
  console.log("Run `pop-unlock --lock` to re-lock when done.");
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------
const command = process.argv[1] ?? "";
if (command.includes("pop-unlock") || process.argv.includes("unlock")) {
  cmdUnlock().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  cmdInitVault().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
