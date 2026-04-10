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
import { isIP } from "node:net";
import { execSync } from "node:child_process";

import type { GuardrailPolicy, PaymentIntent } from "./core/models.js";
import { PopClient } from "./client.js";
import { MockStripeProvider } from "./providers/stripe-mock.js";
import { LocalVaultProvider } from "./providers/byoc-local.js";
import { GuardrailEngine, matchVendor } from "./engine/guardrails.js";
import { PopBrowserInjector } from "./engine/injector.js";
import type { VirtualCardProvider } from "./providers/base.js";

/**
 * Validates if a hostname is a private, loopback, link-local, or reserved IP address.
 */
function isPrivateIP(hostname: string): boolean {
  const ipType = isIP(hostname);
  if (ipType === 0) return false;

  if (ipType === 4) {
    const parts = hostname.split(".").map(Number);
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true;
    // 10.0.0.0/8 (Private)
    if (parts[0] === 10) return true;
    // 172.16.0.0/12 (Private)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (Link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 224.0.0.0/4 (Multicast)
    if (parts[0] >= 224 && parts[0] <= 239) return true;
    // 240.0.0.0/4 (Reserved)
    if (parts[0] >= 240) return true;
  } else if (ipType === 6) {
    const h = hostname.toLowerCase();
    // ::1/128 (Loopback)
    if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
    // fc00::/7 (Unique local)
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
    // fe80::/10 (Link-local)
    if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
  }
  return false;
}

/**
 * Validates a URL against SSRF (Private IPs and non-http/https schemes).
 */
function ssrfValidateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "Only http/https URLs are allowed.";
    }
    if (isPrivateIP(parsed.hostname)) {
      return "Requests to private/internal addresses are not allowed.";
    }
  } catch {
    return "Invalid URL.";
  }
  return null;
}

async function main() {

// Core dump protection: prevent credentials from appearing in core dumps
try {
  // @ts-ignore - setrlimit might not be in the Node.js types for some versions
  if (typeof process.setrlimit === 'function') {
    // @ts-ignore
    process.setrlimit('core', { soft: 0, hard: 0 });
    process.stderr.write("Core dumps disabled via process.setrlimit.\n");
  } else {
    try {
      execSync('ulimit -c 0', { stdio: 'ignore' });
      process.stderr.write("Core dumps disabled via ulimit command.\n");
    } catch {
      process.stderr.write("Failed to disable core dumps via ulimit.\n");
    }
  }
} catch (e: any) {
  process.stderr.write(`Warning: best-effort core dump protection failed: ${e.message}\n`);
}

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
const approvalWebhookUrl = process.env.POP_APPROVAL_WEBHOOK_URL ?? process.env.POP_APPROVAL_WEBHOOK ?? null;
const requireHumanApproval = (process.env.POP_REQUIRE_HUMAN_APPROVAL ?? "false").toLowerCase() === "true";

const policy: GuardrailPolicy = {
  allowedCategories,
  maxAmountPerTx: maxPerTx,
  maxDailyBudget: maxDaily,
  blockHallucinationLoops: blockLoops,
  webhookUrl,
};

/**
 * Fires a webhook notification for payment outcomes.
 */
function sendWebhookNotification(payload: any) {
  if (!webhookUrl) return;

  const ssrfError = ssrfValidateUrl(webhookUrl);
  if (ssrfError) {
    process.stderr.write(`Notification webhook URL blocked: ${ssrfError}\n`);
    return;
  }

  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((e) => {
    process.stderr.write(`Webhook notification failed: ${e.message}\n`);
  });
}

/**
 * Requests human approval via a POST webhook.
 */
async function requestHumanApproval(
  merchant: string,
  amount: number,
  reasoning: string,
  sealId: string
): Promise<{ approved: boolean; reason: string }> {
  if (!requireHumanApproval || !approvalWebhookUrl) {
    return { approved: true, reason: "auto-approved (no approval webhook configured)" };
  }

  const ssrfError = ssrfValidateUrl(approvalWebhookUrl);
  if (ssrfError) {
    process.stderr.write(`Approval webhook URL blocked: ${ssrfError}\n`);
    return { approved: false, reason: `Approval webhook SSRF blocked: ${ssrfError}` };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const resp = await fetch(approvalWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchant, amount, reasoning, seal_id: sealId }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json() as { approved?: boolean; reason?: string };
    return {
      approved: !!data.approved,
      reason: data.reason || "",
    };
  } catch (e: any) {
    process.stderr.write(`Approval webhook failed: ${e.message}\n`);
    return { approved: false, reason: `Approval webhook error: ${e.message}` };
  }
}

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
    if (isPrivateIP(parsed.hostname)) {
      return { flags: ["ssrf_blocked"], snapshotId, safe: false, error: "pop-pay does not allow requests to private/internal addresses." };
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

// MCP Server
const server = new McpServer({ name: "pop-pay", version: "0.4.1" });

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

    // Human Approval Gate (between processPayment and auto-injection)
    if (seal.status.toLowerCase() !== "rejected" && requireHumanApproval) {
      const approval = await requestHumanApproval(target_vendor, requested_amount, reasoning, seal.sealId);
      if (!approval.approved) {
        client.stateTracker.markUsed(seal.sealId);
        
        // Notify outcome (Rejected by Human)
        sendWebhookNotification({
          type: "virtual_card",
          seal_id: seal.sealId,
          status: "Rejected",
          amount: requested_amount,
          vendor: target_vendor,
          timestamp: new Date().toISOString(),
          reasoning: reasoning,
          rejection_reason: `Human approval rejected: ${approval.reason}`
        });

        return {
          content: [
            { type: "text" as const, text: `Payment rejected by human approval. Reason: ${approval.reason}` },
          ],
        };
      }
    }

    // Webhook Notification (Outcome)
    sendWebhookNotification({
      type: "virtual_card",
      seal_id: seal.sealId,
      status: seal.status,
      amount: requested_amount,
      vendor: target_vendor,
      timestamp: new Date().toISOString(),
      reasoning: reasoning,
      rejection_reason: seal.status.toLowerCase() === "rejected" ? seal.rejectionReason : null,
    });

    if (seal.status.toLowerCase() === "rejected") {
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

      // Injection succeeded — promote Pending → Issued
      client.stateTracker.updateSealStatus(seal.sealId, "Issued");

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

    // No auto-inject — promote Pending → Issued immediately (card returned to agent)
    client.stateTracker.updateSealStatus(seal.sealId, "Issued");

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
    // POP_PURCHASER_INFO_BLOCKING (default "true") — when explicitly set to a
    // non-"true" string, the vendor allowlist check becomes non-blocking: the
    // request continues to the injector but is recorded in audit_log with
    // outcome='blocked_bypassed' so operators still see it. Other security
    // gates (scan, domain TOCTOU) are NEVER bypassed by this flag.
    const purchaserInfoBlocking =
      (process.env.POP_PURCHASER_INFO_BLOCKING ?? "true").toLowerCase() === "true";

    // Helper: record this request in audit_log with the resolved outcome.
    // Non-blocking on failure.
    const audit = (outcome: string, rejectionReasonText: string | null = null): void => {
      try {
        client.stateTracker.recordAuditEvent(
          "purchaser_info_requested",
          target_vendor,
          reasoning ?? null,
          outcome,
          rejectionReasonText,
        );
      } catch {
        // Audit failure must never block the main flow.
      }
    };

    // Security scan (same pattern as request_virtual_card)
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
        audit("rejected_security", `scan error: ${scanResult.error}`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Billing rejected. Security scan failed: ${scanResult.error} Snapshot ID: ${scanResult.snapshotId}.`,
            },
          ],
        };
      }
      if (!scanResult.safe) {
        audit(
          "rejected_security",
          `hidden_instructions_detected: ${scanResult.flags.join(", ")}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Billing rejected. Security scan detected hidden prompt injection. Snapshot ID: ${scanResult.snapshotId}. Flags: ${scanResult.flags.join(", ")}. Do not retry.`,
            },
          ],
        };
      }
    } else {
      scanNote = " (security scan skipped — no page_url provided)";
    }

    const pageDomain = page_url
      ? new URL(page_url).hostname.toLowerCase().replace(/^www\./, "")
      : "";
    const vendorAllowed = matchVendor(target_vendor, allowedCategories, pageDomain);
    if (!vendorAllowed) {
      if (purchaserInfoBlocking) {
        audit(
          "rejected_vendor",
          `vendor '${target_vendor}' not in POP_ALLOWED_CATEGORIES`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Vendor '${target_vendor}' is not in your allowed categories. Update POP_ALLOWED_CATEGORIES to add it.`,
            },
          ],
        };
      }
      // Bypass path: record the bypass but continue to the injector.
      audit(
        "blocked_bypassed",
        `vendor '${target_vendor}' not in allowlist (bypassed by POP_PURCHASER_INFO_BLOCKING=false)`,
      );
    }

    if (!injector) {
      audit(
        "error_injector",
        "injector unavailable (POP_AUTO_INJECT disabled or CDP not reachable)",
      );
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
      audit(
        "rejected_security",
        `domain_mismatch: page='${actual}' vs vendor='${target_vendor}'`,
      );
      return {
        content: [{
          type: "text" as const,
          text: `Blocked. Current page domain '${actual}' does not match approved vendor '${target_vendor}'. Do not retry.`,
        }],
      };
    }

    if (!injectionResult.billingFilled) {
      audit("error_fields", "billing fields not found on page");
      return {
        content: [{
          type: "text" as const,
          text: "Could not find billing fields on the current page. Make sure you are on the billing/contact info page before calling this tool.",
        }],
      };
    }

    audit("approved");
    return {
      content: [{
        type: "text" as const,
        text: `Billing info filled successfully for '${target_vendor}'. Name, address, email, and/or phone fields have been auto-populated. Proceed to the payment page and call request_virtual_card when card fields are visible.${scanNote}`,
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

    // Webhook Notification (Outcome)
    sendWebhookNotification({
      type: "x402_payment",
      seal_id: seal.sealId,
      status: seal.status,
      amount: amount,
      vendor: service_url,
      timestamp: new Date().toISOString(),
      reasoning: reasoning,
      rejection_reason: seal.status.toLowerCase() === "rejected" ? seal.rejectionReason : null,
    });

    if (seal.status.toLowerCase() === "rejected") {
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

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

} // end main

main().catch((err) => {
  process.stderr.write(`pop-pay MCP server fatal error: ${err}\n`);
  process.exit(1);
});
