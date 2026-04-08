#!/usr/bin/env node
/**
 * pop-pay MCP Server — stdio transport.
 * Tools: request_virtual_card, request_purchaser_info, request_x402_payment
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import type { GuardrailPolicy, PaymentIntent } from "./core/models.js";
import { PopClient } from "./client.js";
import { MockStripeProvider } from "./providers/stripe-mock.js";
import { LocalVaultProvider } from "./providers/byoc-local.js";
import { GuardrailEngine, matchVendor } from "./engine/guardrails.js";
import { PopBrowserInjector } from "./engine/injector.js";
import type { VirtualCardProvider } from "./providers/base.js";

async function main() {

// Load .env from config dir first, then fallback
const configEnv = join(homedir(), ".config", "pop-pay", ".env");
if (existsSync(configEnv)) {
  config({ path: configEnv });
} else {
  config();
}

// Load vault credentials
let vaultCreds: Record<string, string> = {};
try {
  const { vaultExists, loadVault, loadKeyFromKeyring, OSS_WARNING } = await import("./vault.js");
  if (vaultExists()) {
    const keyringKey = await loadKeyFromKeyring();
    if (!keyringKey) {
      process.stderr.write(OSS_WARNING);
    }
    vaultCreds = await loadVault();
  }
} catch {}

// Set vault creds as env defaults
if (vaultCreds.card_number) process.env.POP_BYOC_NUMBER ??= vaultCreds.card_number;
if (vaultCreds.cvv) process.env.POP_BYOC_CVV ??= vaultCreds.cvv;
if (vaultCreds.exp_month) process.env.POP_BYOC_EXP_MONTH ??= vaultCreds.exp_month;
if (vaultCreds.exp_year) process.env.POP_BYOC_EXP_YEAR ??= vaultCreds.exp_year;

// Configuration
const allowedCategories: string[] = JSON.parse(
  process.env.POP_ALLOWED_CATEGORIES ?? '["aws", "cloudflare"]'
);
const maxPerTx = parseFloat(process.env.POP_MAX_PER_TX ?? "100.0");
const maxDaily = parseFloat(process.env.POP_MAX_DAILY ?? "500.0");
const blockLoops = (process.env.POP_BLOCK_LOOPS ?? "true").toLowerCase() === "true";
const stripeKey = process.env.POP_STRIPE_KEY;
const webhookUrl = process.env.POP_WEBHOOK_URL ?? null;

const policy: GuardrailPolicy = {
  allowedCategories,
  maxAmountPerTx: maxPerTx,
  maxDailyBudget: maxDaily,
  blockHallucinationLoops: blockLoops,
  webhookUrl,
};

// Provider selection
let provider: VirtualCardProvider;
if (stripeKey) {
  const { StripeIssuingProvider } = await import("./providers/stripe-real.js");
  provider = new StripeIssuingProvider(stripeKey);
} else if (process.env.POP_BYOC_NUMBER) {
  provider = new LocalVaultProvider();
} else {
  provider = new MockStripeProvider();
}

// Engine selection
let engine: GuardrailEngine;
const engineType = (process.env.POP_GUARDRAIL_ENGINE ?? "keyword").toLowerCase();
if (engineType === "llm") {
  const { HybridGuardrailEngine, LLMGuardrailEngine } = await import("./engine/llm-guardrails.js");
  engine = new HybridGuardrailEngine(
    new LLMGuardrailEngine({
      apiKey: process.env.POP_LLM_API_KEY ?? "",
      baseUrl: process.env.POP_LLM_BASE_URL ?? undefined,
      model: process.env.POP_LLM_MODEL ?? "gpt-4o-mini",
      useJsonMode: true,
    })
  ) as any;
} else {
  engine = new GuardrailEngine();
}

const client = new PopClient(provider, policy, engine);

// Optional: browser injector (only loaded when POP_AUTO_INJECT=true)
const cdpUrl = process.env.POP_CDP_URL ?? "http://localhost:9222";
const autoInject = (process.env.POP_AUTO_INJECT ?? "false").toLowerCase() === "true";
const injector = autoInject ? new PopBrowserInjector(cdpUrl) : null;

// Snapshot cache for security scans
const snapshotCache = new Map<string, { snapshotId: string; timestamp: Date; flags: string[] }>();
const SNAPSHOT_CACHE_MAX = 200;

// Hidden element detection regex
const HIDDEN_STYLE_RE =
  /(?:style\s*=\s*["'](?:[^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0|height\s*:\s*0|width\s*:\s*0))[^"']*["'])|(?:class\s*=\s*["'](?:[^"']*(?:hidden|visually-hidden|sr-only|d-none))[^"']*["'])/i;
const PRICE_RE = /[\$\u00a3\u20ac\u00a5]\s?\d+(?:\.\d{2})?/g;

async function scanPage(pageUrl: string): Promise<{
  flags: string[];
  snapshotId: string;
  safe: boolean;
  error: string | null;
}> {
  const snapshotId = randomUUID();
  const flags: string[] = [];

  // SSRF guard
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "https:") {
      return { flags: ["invalid_url"], snapshotId, safe: false, error: "pop-pay only accepts https:// URLs." };
    }
  } catch {
    return { flags: ["invalid_url"], snapshotId, safe: false, error: "Invalid URL." };
  }

  // Fetch HTML
  let html = "";
  try {
    const resp = await fetch(pageUrl, { redirect: "follow", signal: AbortSignal.timeout(10000) });
    html = await resp.text();
    const finalUrl = new URL(resp.url);
    const origUrl = new URL(pageUrl);
    if (finalUrl.hostname !== origUrl.hostname) {
      flags.push("unexpected_redirect");
    }
  } catch (e: any) {
    flags.push("ssl_anomaly");
    return { flags, snapshotId, safe: false, error: `Error fetching page: ${e.message}` };
  }

  // Prompt injection scan
  const instructionKeywords = [
    "ignore", "instead", "system", "user", "override", "instruction", "always", "never", "prompt",
  ];
  let hiddenInstructionsDetected = false;
  let match;
  const re = new RegExp(HIDDEN_STYLE_RE.source, "gi");
  while ((match = re.exec(html)) !== null) {
    const context = html.slice(match.index + match[0].length, match.index + match[0].length + 300).toLowerCase();
    if (instructionKeywords.some((kw) => context.includes(kw))) {
      hiddenInstructionsDetected = true;
      break;
    }
  }
  if (hiddenInstructionsDetected) flags.push("hidden_instructions_detected");

  // Price mismatch
  const prices = new Set(html.match(PRICE_RE) ?? []);
  if (prices.size > 2) flags.push("price_mismatch");

  // Cache
  if (snapshotCache.size >= SNAPSHOT_CACHE_MAX) {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of snapshotCache) {
      if (v.timestamp.getTime() < oldestTime) {
        oldest = k;
        oldestTime = v.timestamp.getTime();
      }
    }
    if (oldest) snapshotCache.delete(oldest);
  }
  snapshotCache.set(pageUrl, { snapshotId, timestamp: new Date(), flags });

  const safe = !flags.includes("hidden_instructions_detected");
  return { flags, snapshotId, safe, error: null };
}

function ssrfValidateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "Only http/https URLs are allowed.";
    }
  } catch {
    return "Invalid URL.";
  }
  return null;
}

// MCP Server
const server = new McpServer({ name: "pop-pay", version: "0.1.0" });

server.tool(
  "request_virtual_card",
  "Request a one-time virtual credit card for an automated purchase. ONLY call when card input fields are visible on the checkout page.",
  {
    requested_amount: z.number().positive().describe("Amount to authorize"),
    target_vendor: z.string().describe("Human-readable vendor name (e.g. 'AWS', 'Wikipedia')"),
    reasoning: z.string().describe("Agent reasoning for the payment"),
    page_url: z.string().optional().describe("Current checkout page URL"),
  },
  async ({ requested_amount, target_vendor, reasoning, page_url }) => {
    // Security scan
    let scanNote = "";
    if (page_url) {
      const cached = snapshotCache.get(page_url);
      let scanResult;
      if (cached && Date.now() - cached.timestamp.getTime() < 5 * 60 * 1000) {
        scanResult = {
          flags: cached.flags,
          snapshotId: cached.snapshotId,
          safe: !cached.flags.includes("hidden_instructions_detected"),
          error: null,
        };
      } else {
        scanResult = await scanPage(page_url);
      }
      if (scanResult.error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Payment rejected. Security scan failed: ${scanResult.error} Snapshot ID: ${scanResult.snapshotId}.`,
            },
          ],
        };
      }
      if (!scanResult.safe) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Payment rejected. Security scan detected hidden prompt injection. Snapshot ID: ${scanResult.snapshotId}. Flags: ${scanResult.flags.join(", ")}. Do not retry this payment.`,
            },
          ],
        };
      }
    } else {
      scanNote = " (security scan skipped \u2014 no page_url provided)";
    }

    const intent: PaymentIntent = {
      agentId: "mcp-agent",
      requestedAmount: requested_amount,
      targetVendor: target_vendor,
      reasoning,
      pageUrl: page_url ?? null,
    };
    const seal = await client.processPayment(intent);

    if (seal.status === "Rejected") {
      return {
        content: [
          { type: "text" as const, text: `Payment rejected by guardrails. Reason: ${seal.rejectionReason}` },
        ],
      };
    }

    const last4 = seal.cardNumber?.slice(-4) ?? "????";
    const maskedCard = `****-****-****-${last4}`;

    // Auto-injection path: inject into browser if enabled
    if (injector && seal.cardNumber && seal.cvv && seal.expirationDate) {
      const injectionResult = await injector.injectPaymentInfo({
        sealId: seal.sealId,
        cardNumber: seal.cardNumber,
        cvv: seal.cvv,
        expirationDate: seal.expirationDate,
        pageUrl: page_url,
        approvedVendor: target_vendor,
      });

      if (!injectionResult.cardFilled) {
        client.stateTracker.markUsed(seal.sealId);
        if (injectionResult.blockedReason.startsWith("domain_mismatch:")) {
          const actual = injectionResult.blockedReason.split(":", 2)[1];
          return {
            content: [{
              type: "text" as const,
              text: `Payment blocked. Security: current page domain '${actual}' does not match approved vendor '${target_vendor}'. Do not retry.`,
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: "Payment rejected. Could not find credit card input fields. Ensure page_url points to the checkout page and Playwright MCP shares --cdp-endpoint http://localhost:9222.",
          }],
        };
      }

      let billingNote = "";
      if (injectionResult.billingFilled && injectionResult.billingDetails) {
        const filled = injectionResult.billingDetails.filled;
        const failed = injectionResult.billingDetails.failed;
        billingNote = ` Billing filled: ${JSON.stringify(filled)}.`;
        if (failed.length > 0) billingNote += ` FAILED: ${JSON.stringify(failed)}.`;
      }

      return {
        content: [{
          type: "text" as const,
          text: `Payment approved and securely auto-injected into the browser form.${billingNote}${scanNote} Please proceed to click the submit/pay button. Masked card: ${maskedCard}`,
        }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Payment approved. Card Issued: ${maskedCard}, Expiry: ${seal.expirationDate}, Amount: ${seal.authorizedAmount}${scanNote}`,
        },
      ],
    };
  }
);

server.tool(
  "request_purchaser_info",
  "Auto-fill purchaser/billing info (name, email, phone, address) from the user's pre-configured profile. Call when on a billing/contact info page WITHOUT card fields visible.",
  {
    target_vendor: z.string().describe("Human-readable vendor or event name"),
    page_url: z.string().optional().describe("Current page URL"),
    reasoning: z.string().optional().describe("Why billing info is needed"),
  },
  async ({ target_vendor, page_url, reasoning }) => {
    const pageDomain = page_url
      ? new URL(page_url).hostname.toLowerCase().replace(/^www\./, "")
      : "";
    const vendorAllowed = matchVendor(target_vendor, allowedCategories, pageDomain);
    if (!vendorAllowed) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Vendor '${target_vendor}' is not in your allowed categories. Update POP_ALLOWED_CATEGORIES to add it.`,
          },
        ],
      };
    }

    if (!injector) {
      return {
        content: [{
          type: "text" as const,
          text: "Billing info injection is not available. Ensure POP_AUTO_INJECT=true in ~/.config/pop-pay/.env and restart the MCP server.",
        }],
      };
    }

    const injectionResult = await injector.injectBillingOnly({
      pageUrl: page_url,
      approvedVendor: target_vendor,
    });

    if (injectionResult.blockedReason.startsWith("domain_mismatch:")) {
      const actual = injectionResult.blockedReason.split(":", 2)[1];
      return {
        content: [{
          type: "text" as const,
          text: `Blocked. Current page domain '${actual}' does not match approved vendor '${target_vendor}'. Do not retry.`,
        }],
      };
    }

    if (!injectionResult.billingFilled) {
      return {
        content: [{
          type: "text" as const,
          text: "Could not find billing fields on the current page. Make sure you are on the billing/contact info page before calling this tool.",
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: `Billing info filled successfully for '${target_vendor}'. Name, address, email, and/or phone fields have been auto-populated. Proceed to the payment page and call request_virtual_card when card fields are visible.`,
      }],
    };
  }
);

server.tool(
  "request_x402_payment",
  "Pay for an API call or service using the x402 HTTP payment protocol.",
  {
    amount: z.number().positive().describe("Payment amount"),
    service_url: z.string().describe("Service URL to pay"),
    reasoning: z.string().describe("Reason for the payment"),
  },
  async ({ amount, service_url, reasoning }) => {
    const walletKey = process.env.POP_X402_WALLET_KEY ?? "";
    if (!walletKey) {
      return {
        content: [
          {
            type: "text" as const,
            text: "x402 payment rejected: POP_X402_WALLET_KEY environment variable is not set.",
          },
        ],
      };
    }

    const ssrfError = ssrfValidateUrl(service_url);
    if (ssrfError) {
      return {
        content: [
          { type: "text" as const, text: `x402 payment rejected: SSRF validation failed. ${ssrfError}` },
        ],
      };
    }

    const intent: PaymentIntent = {
      agentId: "mcp-agent-x402",
      requestedAmount: amount,
      targetVendor: service_url,
      reasoning,
      pageUrl: service_url,
    };
    const seal = await client.processPayment(intent);

    if (seal.status === "Rejected") {
      return {
        content: [
          { type: "text" as const, text: `x402 payment rejected by guardrails. Reason: ${seal.rejectionReason}` },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `x402 payment approved (STUBBED). seal_id=${seal.sealId}, amount=$${amount.toFixed(2)}, service_url=${service_url}. Note: actual x402 blockchain payment is not yet implemented.`,
        },
      ],
    };
  }
);

server.tool(
  "page_snapshot",
  "Capture a security snapshot of a checkout page. Scans for hidden prompt injections, price mismatches, and redirect anomalies. Call before request_virtual_card to pre-validate checkout safety.",
  {
    page_url: z.string().describe("The checkout page URL to scan (must be https://)"),
  },
  async ({ page_url }) => {
    const scanResult = await scanPage(page_url);
    if (scanResult.error) {
      return {
        content: [{
          type: "text" as const,
          text: `Snapshot failed: ${scanResult.error} Snapshot ID: ${scanResult.snapshotId}.`,
        }],
      };
    }

    const flagsSummary = scanResult.flags.length > 0
      ? `Flags: ${scanResult.flags.join(", ")}.`
      : "No flags detected.";

    return {
      content: [{
        type: "text" as const,
        text: `Page snapshot complete. Safe: ${scanResult.safe}. ${flagsSummary} Snapshot ID: ${scanResult.snapshotId}.`,
      }],
    };
  }
);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

} // end main

main().catch((err) => {
  process.stderr.write(`pop-pay MCP server fatal error: ${err}\n`);
  process.exit(1);
});
