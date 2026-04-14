// Corpus runner. Executes every payload across 5 runner paths with N=5 repeats (LLM-dependent ones),
// writes tests/redteam/runs/<ts>.jsonl, emits aggregated report to stdout as JSON.
//
// Usage:
//   POP_REDTEAM=1 npx tsx tests/redteam/run-corpus.ts [--filter=B] [--n=5] [--concurrency=20]
//
// Does NOT read ~/.config/pop-pay/.env. Env comes from the harness process's own env only.
// The engine's Layer 2 reads POP_LLM_* on its own.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { loadCorpus } from "./validate-corpus.js";
import { aggregate } from "./aggregator.js";
import { runLayer1 } from "./runners/layer1.js";
import { runLayer2 } from "./runners/layer2.js";
import { runHybrid } from "./runners/hybrid.js";
import { runFullMcp } from "./runners/full-mcp.js";
import { runToctou } from "./runners/toctou.js";
import type { AttackPayload, PayloadRunRow, CorpusHashHeader } from "./types.js";

interface RunOptions {
  filter?: string; // category letter A-K
  n: number;
  concurrency: number;
  corpusPath: string;
  outDir: string;
}

function parseArgs(): RunOptions {
  const opts: RunOptions = {
    n: 5,
    concurrency: Number(process.env.POP_REDTEAM_CONCURRENCY ?? 20),
    corpusPath: "tests/redteam/corpus/attacks.json",
    outDir: "tests/redteam/runs",
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--filter=")) opts.filter = arg.slice(9);
    else if (arg.startsWith("--n=")) opts.n = Number(arg.slice(4));
    else if (arg.startsWith("--concurrency=")) opts.concurrency = Number(arg.slice(14));
    else if (arg.startsWith("--corpus=")) opts.corpusPath = arg.slice(9);
  }
  return opts;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function runPayloadOnce(p: AttackPayload, runIndex: number): Promise<PayloadRunRow> {
  const [l1, l2, hy, fm, tc] = await Promise.all([
    runLayer1(p),
    runLayer2(p),
    runHybrid(p),
    runFullMcp(p),
    runToctou(p),
  ]);
  const attribution: string[] = [];
  if (l1.verdict === "block") attribution.push("layer1");
  if (l2.verdict === "block") attribution.push("layer2");
  if (fm.verdict === "block" && fm.reason.startsWith("scan:")) attribution.push("scan");
  if (tc.verdict === "block") attribution.push("toctou");
  return {
    payload_id: p.id,
    category: p.category,
    expected: p.expected,
    run_index: runIndex,
    layer1: l1,
    layer2: l2,
    hybrid: hy,
    full_mcp: fm,
    toctou: tc,
    attribution,
  };
}

async function pool<T, R>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function next(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

export async function runCorpus(opts: Partial<RunOptions> = {}): Promise<void> {
  const o = { ...parseArgs(), ...opts };
  if (!existsSync(o.corpusPath)) {
    throw new Error(`Corpus not found at ${o.corpusPath}. Generate it first (see tests/redteam/README.md).`);
  }
  const raw = JSON.parse(readFileSync(o.corpusPath, "utf8"));
  const corpus = loadCorpus(o.corpusPath);
  const filtered = o.filter ? corpus.filter((p) => p.category === o.filter) : corpus;

  if (filtered.length === 0) {
    throw new Error(`No payloads after filter=${o.filter}`);
  }

  const idSorted = raw.length ? JSON.stringify(raw.map((p: AttackPayload) => p.id).sort()) : "";
  const header: CorpusHashHeader = {
    corpus_hash: createHash("sha256").update(idSorted).digest("hex"),
    corpus_size: filtered.length,
    generated_at: new Date().toISOString(),
    git_sha: gitSha(),
    model: process.env.POP_LLM_MODEL ?? null,
    n_runs_per_payload: o.n,
  };

  mkdirSync(o.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(o.outDir, `${stamp}${o.filter ? "-" + o.filter : ""}.jsonl`);
  const lines: string[] = [JSON.stringify({ type: "header", ...header })];

  const work: Array<{ payload: AttackPayload; runIdx: number }> = [];
  for (let i = 0; i < o.n; i++) {
    for (const p of filtered) work.push({ payload: p, runIdx: i });
  }

  let done = 0;
  const rows = await pool(work, o.concurrency, async ({ payload, runIdx }) => {
    const row = await runPayloadOnce(payload, runIdx);
    done++;
    if (done % 50 === 0) process.stderr.write(`[redteam] ${done}/${work.length}\n`);
    // Scrub any key-shaped substring from persisted reason/error fields before write.
    for (const runner of ["layer1", "layer2", "hybrid", "full_mcp", "toctou"] as const) {
      const r = (row as any)[runner];
      if (r) {
        if (r.reason) r.reason = scrubKey(r.reason);
        if (r.error) r.error = scrubKey(r.error);
      }
    }
    lines.push(JSON.stringify({ type: "row", ...row }));
    return row;
  });

  const report = aggregate(rows, header.corpus_hash);
  lines.push(JSON.stringify({ type: "report", ...report }));
  writeFileSync(outPath, lines.join("\n") + "\n");

  process.stderr.write(`[redteam] wrote ${outPath}\n`);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

// CLI
const invokedAsScript = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return typeof process.argv[1] === "string" && process.argv[1].endsWith("run-corpus.ts");
  }
})();

if (invokedAsScript) {
  if (process.env.POP_REDTEAM !== "1") {
    console.error("POP_REDTEAM=1 required. Refusing to run.");
    process.exit(2);
  }
  const allowSkip = process.argv.includes("--allow-skip-llm");
  if (!allowSkip && !process.env.POP_LLM_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error(
      "POP_LLM_API_KEY (or OPENAI_API_KEY) not set. Layer 2 / Hybrid / Full MCP would silently skip — " +
        "that produces v0.1 Preliminary numbers only. Pass --allow-skip-llm to force an unkeyed run (checkpoint only).",
    );
    process.exit(3);
  }
  runCorpus().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// Scrub API-key-shaped substrings from any string before persistence.
// Applied to every row's reason/error fields by the aggregator caller path.
export function scrubKey(s: unknown): string {
  if (typeof s !== "string") return String(s ?? "");
  return s
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-REDACTED")
    .replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer REDACTED")
    .replace(/[A-Za-z0-9]{32,}/g, (m) => (/^[0-9]+$/.test(m) ? m : "[REDACTED-LONG-TOKEN]"));
}
