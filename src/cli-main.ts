#!/usr/bin/env node

/**
 * pop-pay CLI dispatcher.
 * Routes subcommands to the appropriate module.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

function showHelp() {
  console.log(`pop-pay v${getVersion()} — Semantic Payment Guardrail for AI Agents

Usage: pop-pay <command> [options]

Commands:
  launch-mcp      Start the MCP server (stdio transport)
  launch          Launch Chrome with CDP remote debugging
  init-vault      Initialize the encrypted credential vault
  unlock          Unlock the vault for the current session
  dashboard       Start the monitoring dashboard

Options:
  -v, --version   Show version
  -h, --help      Show this help message`);
}

async function main() {
  const subcommand = process.argv[2];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    showHelp();
    return;
  }

  if (subcommand === "--version" || subcommand === "-v") {
    console.log(getVersion());
    return;
  }

  switch (subcommand) {
    case "launch-mcp":
      process.argv.splice(2, 1);
      await import("./mcp-server.js");
      break;

    case "launch":
      process.argv.splice(2, 1);
      await import("./cli.js");
      break;

    case "init-vault":
      process.argv.splice(2, 1);
      await import("./cli-vault.js");
      break;

    case "unlock":
      // Keep "unlock" in argv — cli-vault.ts detects it via process.argv.includes("unlock")
      await import("./cli-vault.js");
      break;

    case "dashboard":
      process.argv.splice(2, 1);
      await import("./cli-dashboard.js");
      break;

    default:
      console.error(`Unknown command: ${subcommand}\n`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("pop-pay:", err.message ?? err);
  process.exit(1);
});
