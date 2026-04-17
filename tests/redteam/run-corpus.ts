// Corpus runner. Executes every payload across 5 runner paths with N=5 repeats (LLM-dependent ones),
// writes tests/redteam/runs/<ts>.jsonl, emits aggregated report to stdout as JSON.
//
// Usage:
//   POP_REDTEAM=1 npx tsx tests/redteam/run-corpus.ts [--filter=B] [--n=5] [--concurrency=20]
//
// Loads ~/.config/pop-pay/.env into process.env (same rule as engine) for POP_LLM_* values.
// Key value never logged/printed/persisted — scrubKey() applied to row reason/error before write.

import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

function loadDotenvIfPresent(): void {
  const path = join(homedir(), ".config", "pop-pay", ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

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
  modelSweep: boolean;
  only?: string; // restrict --model-sweep to a single provider name (e.g. ollama)
  batchSize?: number; // if set, split work into batches of this size with health-check gates between
  healthCheckUrl?: string; // HTTP GET URL pinged between batches; non-2xx → graceful exit
  sample?: number; // uniform random subset across categories after --filter; seeded by --seed
  seed?: number; // seed for --sample (default 1 → deterministic)
}

function parseArgs(): RunOptions {
  const opts: RunOptions = {
    n: 5,
    concurrency: Number(process.env.POP_REDTEAM_CONCURRENCY ?? 20),
    corpusPath: "tests/redteam/corpus/attacks.json",
    outDir: "tests/redteam/runs",
    modelSweep: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--filter=")) opts.filter = arg.slice(9);
    else if (arg.startsWith("--n=")) opts.n = Number(arg.slice(4));
    else if (arg.startsWith("--concurrency=")) opts.concurrency = Number(arg.slice(14));
    else if (arg.startsWith("--corpus=")) opts.corpusPath = arg.slice(9);
    else if (arg === "--model-sweep") opts.modelSweep = true;
    else if (arg.startsWith("--only=")) opts.only = arg.slice(7);
    else if (arg.startsWith("--batch-size=")) opts.batchSize = Number(arg.slice(13));
    else if (arg.startsWith("--health-check-url=")) opts.healthCheckUrl = arg.slice(19);
    else if (arg.startsWith("--sample=")) opts.sample = Number(arg.slice(9));
    else if (arg.startsWith("--seed=")) opts.seed = Number(arg.slice(7));
  }
  return opts;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function healthCheck(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (resp.ok) return { ok: true, detail: `HTTP ${resp.status}` };
    return { ok: false, detail: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, detail: `${e?.name ?? "error"}: ${e?.message ?? e}` };
  }
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
  const afterFilter = o.filter ? corpus.filter((p) => p.category === o.filter) : corpus;

  if (afterFilter.length === 0) {
    throw new Error(`No payloads after filter=${o.filter}`);
  }

  const seed = o.seed ?? 1;
  let filtered = afterFilter;
  let sampleMeta: { sample_size: number; sample_seed: number; sample_category_breakdown: Record<string, number> } | null = null;
  if (o.sample && o.sample > 0 && o.sample < afterFilter.length) {
    filtered = seededShuffle(afterFilter, seed).slice(0, o.sample);
    const breakdown: Record<string, number> = {};
    for (const p of filtered) breakdown[p.category] = (breakdown[p.category] ?? 0) + 1;
    sampleMeta = { sample_size: filtered.length, sample_seed: seed, sample_category_breakdown: breakdown };
    process.stderr.write(
      `[redteam] --sample=${o.sample} --seed=${seed} → ${filtered.length} payloads across ${Object.keys(breakdown).length} categories: ${JSON.stringify(breakdown)}\n`,
    );
  }

  const idSorted = raw.length ? JSON.stringify(raw.map((p: AttackPayload) => p.id).sort()) : "";
  const header: CorpusHashHeader = {
    corpus_hash: createHash("sha256").update(idSorted).digest("hex"),
    corpus_size: filtered.length,
    generated_at: new Date().toISOString(),
    git_sha: gitSha(),
    model: process.env.POP_LLM_MODEL ?? null,
    n_runs_per_payload: o.n,
    ...(sampleMeta ?? {}),
  };

  mkdirSync(o.outDir, { recursive: true });

  const work: Array<{ payload: AttackPayload; runIdx: number }> = [];
  for (let i = 0; i < o.n; i++) {
    for (const p of filtered) work.push({ payload: p, runIdx: i });
  }

  async function runOneSlice(labelSuffix: string, modelId: string | null): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = join(
      o.outDir,
      `${stamp}${o.filter ? "-" + o.filter : ""}${labelSuffix}.jsonl`,
    );
    const sliceHeader = { ...header, model: modelId ?? header.model, generated_at: new Date().toISOString() };

    const scrubRow = (row: PayloadRunRow) => {
      for (const runner of ["layer1", "layer2", "hybrid", "full_mcp", "toctou"] as const) {
        const r = (row as any)[runner];
        if (r) {
          if (r.reason) r.reason = scrubKey(r.reason);
          if (r.error) r.error = scrubKey(r.error);
        }
      }
    };

    // Row-level incremental write: every completed row appends to livePath immediately.
    // Mid-sweep kill leaves header + N completed rows on disk, recoverable. Normal exit
    // renames to .done as audit marker. Prevents 0-artifact loss when the final
    // writeFileSync(outPath) never runs due to process death.
    const livePath = outPath.replace(/\.jsonl$/, ".part-live.jsonl");
    writeFileSync(livePath, JSON.stringify({ type: "header", ...sliceHeader, live: true }) + "\n");
    process.stderr.write(`[redteam${labelSuffix}] live-append file: ${livePath}\n`);

    const batchSize = o.batchSize && o.batchSize > 0 ? o.batchSize : work.length;
    const batches: Array<Array<{ payload: AttackPayload; runIdx: number }>> = [];
    for (let i = 0; i < work.length; i += batchSize) batches.push(work.slice(i, i + batchSize));

    const allRows: PayloadRunRow[] = [];
    const partialPaths: string[] = [];
    let gracefulExit = false;
    let healthFailureDetail: string | null = null;

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      let done = 0;
      const batchRows = await pool(batch, o.concurrency, async ({ payload, runIdx }) => {
        const row = await runPayloadOnce(payload, runIdx);
        done++;
        if (done % 50 === 0) {
          process.stderr.write(`[redteam${labelSuffix}] batch ${bi + 1}/${batches.length} ${done}/${batch.length}\n`);
        }
        scrubRow(row);
        appendFileSync(livePath, JSON.stringify({ type: "row", ...row }) + "\n");
        return row;
      });
      allRows.push(...batchRows);

      if (batches.length > 1) {
        const partialPath = outPath.replace(/\.jsonl$/, `.part-${String(bi + 1).padStart(3, "0")}.jsonl`);
        const batchLines = [
          JSON.stringify({ type: "header", ...sliceHeader, batch_index: bi + 1, batch_total: batches.length }),
          ...batchRows.map((r) => JSON.stringify({ type: "row", ...r })),
        ];
        writeFileSync(partialPath, batchLines.join("\n") + "\n");
        partialPaths.push(partialPath);
        process.stderr.write(`[redteam${labelSuffix}] wrote batch ${bi + 1}/${batches.length} → ${partialPath}\n`);
      }

      if (o.healthCheckUrl && bi < batches.length - 1) {
        const hc = await healthCheck(o.healthCheckUrl);
        if (!hc.ok) {
          gracefulExit = true;
          healthFailureDetail = `batch ${bi + 1}/${batches.length}: ${hc.detail}`;
          process.stderr.write(
            `[redteam${labelSuffix}] health-check FAILED (${hc.detail}) — graceful exit after ${bi + 1}/${batches.length} batches\n`,
          );
          break;
        }
        process.stderr.write(`[redteam${labelSuffix}] health-check ok (${hc.detail}) — continuing\n`);
      }
    }

    const report = aggregate(allRows, sliceHeader.corpus_hash);
    const finalHeader: any = { ...sliceHeader };
    if (gracefulExit) {
      finalHeader.partial = true;
      finalHeader.completion_rate = allRows.length / work.length;
      finalHeader.health_failure = healthFailureDetail;
      finalHeader.batches_completed = partialPaths.length;
      finalHeader.batches_total = batches.length;
    }
    const lines: string[] = [
      JSON.stringify({ type: "header", ...finalHeader }),
      ...allRows.map((r) => JSON.stringify({ type: "row", ...r })),
      JSON.stringify({ type: "report", ...report, model: modelId, partial: gracefulExit || undefined }),
    ];
    writeFileSync(outPath, lines.join("\n") + "\n");
    renameSync(livePath, livePath + ".done");
    process.stderr.write(
      `[redteam] wrote ${outPath}${gracefulExit ? ` (PARTIAL ${allRows.length}/${work.length})` : ""}\n`,
    );
    process.stdout.write(
      JSON.stringify({ model: modelId, ...report, partial: gracefulExit || undefined }, null, 2) + "\n",
    );
  }

  if (o.modelSweep) {
    const { resolveBenchAdapters, describeAdapters } = await import("./adapters/index.js");
    const { setBenchAdapter } = await import("./runners/layer2.js");
    let adapters = resolveBenchAdapters();
    if (o.only) {
      const before = adapters.length;
      adapters = adapters.filter((a) => a.name === o.only);
      process.stderr.write(
        `[redteam] --only=${o.only} filtered ${before} → ${adapters.length} adapter(s)\n`,
      );
    }
    process.stderr.write(`[redteam] --model-sweep adapters: ${describeAdapters(adapters)}\n`);
    if (adapters.length === 0) {
      process.stderr.write(
        "[redteam] --model-sweep: no POP_BENCH_* providers configured — falling back to single POP_LLM_* run.\n",
      );
      await runOneSlice("", process.env.POP_LLM_MODEL ?? null);
      return;
    }
    for (const a of adapters) {
      const label = `-${a.name}-${a.modelId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
      setBenchAdapter(a, `${a.name}:${a.modelId}`);
      process.stderr.write(`[redteam] sweep slice: ${a.name}:${a.modelId}\n`);
      try {
        await runOneSlice(label, `${a.name}:${a.modelId}`);
      } catch (e) {
        process.stderr.write(`[redteam] sweep slice ${a.name} failed: ${e}\n`);
      }
    }
    setBenchAdapter(null, null);
    return;
  }

  await runOneSlice("", process.env.POP_LLM_MODEL ?? null);
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
  loadDotenvIfPresent();
  const allowSkip = process.argv.includes("--allow-skip-llm");
  const sweepMode = process.argv.includes("--model-sweep");
  if (!allowSkip && !sweepMode && !process.env.POP_LLM_API_KEY && !process.env.OPENAI_API_KEY) {
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
