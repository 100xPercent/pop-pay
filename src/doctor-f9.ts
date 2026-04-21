/**
 * F9 — Chrome binary integrity (pop-pay doctor)
 *
 * Four-layer defense-in-depth for the "is the Chrome you're attaching CDP to
 * a tampered binary?" gap. Closes the CDP injection trust boundary documented
 * in docs/VAULT_THREAT_MODEL.md §2.8.
 *
 * Layers:
 *   L1 — OS codesign verify + vendor identity (load-bearing)
 *   L2 — Static SHA-256 pin against in-repo known-good list
 *   L3 — Fork whitelist (Google / Brave / MS / Mozilla) with --strict/--permissive modes
 *   L4 — Runtime defense-in-depth (extension enumeration + CDP port hijack sniff)
 *
 * NEVER live-fetches dl.google.com or any remote feed — by design, see
 * docs/VAULT_THREAT_MODEL.md §2.8 "Rationale — why not live-fetch".
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type ForkMode = "strict" | "default" | "permissive";

export interface F9Options {
  chromePath?: string;
  forkMode?: ForkMode;
  cdpPort?: number;
  // Dependency-injection hooks for unit tests; production leaves these undefined.
  _exec?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  _readFile?: (p: string) => string;
  _knownGoodPath?: string;
  _net?: (host: string, port: number, timeoutMs: number) => Promise<"listening" | "closed" | "error">;
  _listExtensions?: () => Array<{ id: string; path: string }>;
}

export interface F9CheckResult {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  vendor?: string;
  teamId?: string;
  sha256?: string;
  version?: string;
  forkMode?: ForkMode;
  extensions?: Array<{ id: string; path: string }>;
}

interface KnownGoodEntry {
  vendor: string;
  channel: string;
  version: string;
  platform: string;
  arch: string;
  sha256: string;
  note?: string;
}

interface KnownGoodFile {
  entries: KnownGoodEntry[];
  vendors_accepted_default: string[];
  vendor_id_macos_known: Record<string, string>;
}

// --- Chrome path resolution ------------------------------------------------

export function resolveChromePath(override?: string): string | null {
  if (override && existsSync(override)) return override;
  if (process.env.POP_CHROME_PATH && existsSync(process.env.POP_CHROME_PATH)) {
    return process.env.POP_CHROME_PATH;
  }
  const candidates =
    platform() === "darwin"
      ? [
          "/Applications/Google Chrome.app",
          "/Applications/Chromium.app",
          "/Applications/Google Chrome Canary.app",
          "/Applications/Brave Browser.app",
          "/Applications/Microsoft Edge.app",
          "/Applications/Firefox.app",
        ]
      : platform() === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/brave-browser",
            "/usr/bin/microsoft-edge",
          ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// On macOS the Chrome executable lives inside the .app bundle.
function executablePathFor(chromePath: string): string {
  if (platform() === "darwin" && chromePath.endsWith(".app")) {
    // Map Foo.app → Foo.app/Contents/MacOS/Foo (Chrome uses "Google Chrome" etc.)
    const candidates = readdirSafely(join(chromePath, "Contents", "MacOS"));
    if (candidates.length > 0) {
      return join(chromePath, "Contents", "MacOS", candidates[0]);
    }
  }
  return chromePath;
}

function readdirSafely(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// --- Layer 1 — OS codesign verify + vendor identity ------------------------

interface ParsedSignature {
  valid: boolean;
  vendor?: string;
  teamId?: string;
  detail: string;
}

function runExec(
  opts: F9Options,
  cmd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  if (opts._exec) return opts._exec(cmd, args);
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function parseMacOSCodesign(stderr: string): ParsedSignature {
  // `codesign -dv --verbose=4` prints to stderr. We want the Authority line:
  //   Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)
  const authMatch = stderr.match(/Authority=Developer ID Application:\s*([^\n(]+?)\s*\(([A-Z0-9]{10})\)/);
  if (!authMatch) {
    return { valid: false, detail: "No Developer ID Authority line found" };
  }
  const vendor = authMatch[1].trim();
  const teamId = authMatch[2].trim();
  return { valid: true, vendor, teamId, detail: `Signed by ${vendor} (Team ID ${teamId})` };
}

function layer1MacOS(chromePath: string, opts: F9Options): F9CheckResult {
  // `codesign --verify` (NOT --strict; Chrome's .app bundle contains resource-fork
  // metadata which --strict rejects with "resource fork / Finder information"
  // even though the signature itself is cryptographically valid. Documented
  // deviation from original spec; see VAULT_THREAT_MODEL.md §2.8.)
  const verify = runExec(opts, "codesign", ["--verify", chromePath]);
  if (verify.status !== 0) {
    return {
      id: "f9_l1_codesign",
      name: "F9 Layer 1 — OS codesign",
      status: "fail",
      detail: `codesign --verify exit ${verify.status}: ${verify.stderr.trim() || "invalid signature"}`,
    };
  }
  const info = runExec(opts, "codesign", ["-dv", "--verbose=4", chromePath]);
  const parsed = parseMacOSCodesign(info.stderr);
  if (!parsed.valid) {
    return {
      id: "f9_l1_codesign",
      name: "F9 Layer 1 — OS codesign",
      status: "fail",
      detail: parsed.detail,
    };
  }
  return {
    id: "f9_l1_codesign",
    name: "F9 Layer 1 — OS codesign",
    status: "pass",
    detail: parsed.detail,
    vendor: parsed.vendor,
    teamId: parsed.teamId,
  };
}

function layer1Linux(chromePath: string, opts: F9Options): F9CheckResult {
  // Try Debian/Ubuntu path first: dpkg owns the binary → package is signed by the
  // distro's GPG chain. Fall through to RPM family, then to a bare "we cannot
  // verify" warn (rather than fail — Linux packaging is heterogeneous).
  const dpkg = runExec(opts, "dpkg", ["-S", chromePath]);
  if (dpkg.status === 0 && dpkg.stdout.trim()) {
    const pkgName = dpkg.stdout.split(":")[0].trim();
    // Verify that dpkg's recorded checksums still match (catches tamper).
    const verify = runExec(opts, "dpkg", ["-V", pkgName]);
    if (verify.status === 0 && verify.stdout.trim() === "") {
      return {
        id: "f9_l1_codesign",
        name: "F9 Layer 1 — OS codesign",
        status: "pass",
        detail: `dpkg integrity OK for ${pkgName}`,
        vendor: packageVendor(pkgName),
      };
    }
    return {
      id: "f9_l1_codesign",
      name: "F9 Layer 1 — OS codesign",
      status: "fail",
      detail: `dpkg -V ${pkgName} reported changes: ${verify.stdout.trim()}`,
      vendor: packageVendor(pkgName),
    };
  }
  const rpm = runExec(opts, "rpm", ["-qf", chromePath]);
  if (rpm.status === 0 && rpm.stdout.trim()) {
    const pkgName = rpm.stdout.trim();
    const verify = runExec(opts, "rpm", ["-V", pkgName]);
    if (verify.status === 0) {
      return {
        id: "f9_l1_codesign",
        name: "F9 Layer 1 — OS codesign",
        status: "pass",
        detail: `rpm integrity OK for ${pkgName}`,
        vendor: packageVendor(pkgName),
      };
    }
    return {
      id: "f9_l1_codesign",
      name: "F9 Layer 1 — OS codesign",
      status: "fail",
      detail: `rpm -V ${pkgName} reported changes: ${verify.stdout.trim()}`,
      vendor: packageVendor(pkgName),
    };
  }
  return {
    id: "f9_l1_codesign",
    name: "F9 Layer 1 — OS codesign",
    status: "warn",
    detail: "No dpkg/rpm record for this Chrome path — cannot verify distro signature",
  };
}

function packageVendor(pkgName: string): string | undefined {
  if (/google-chrome/i.test(pkgName)) return "Google LLC";
  if (/chromium/i.test(pkgName)) return "Chromium";
  if (/brave/i.test(pkgName)) return "Brave Software Inc.";
  if (/microsoft-edge|msedge/i.test(pkgName)) return "Microsoft Corporation";
  if (/firefox/i.test(pkgName)) return "Mozilla Foundation";
  return undefined;
}

function layer1Windows(chromePath: string, opts: F9Options): F9CheckResult {
  // Get-AuthenticodeSignature returns JSON via Format-List; parse SignerCertificate.Subject
  // for CN="Google LLC" style publisher identity. Signature status must be Valid.
  const ps = runExec(opts, "powershell.exe", [
    "-NoProfile",
    "-Command",
    `$s = Get-AuthenticodeSignature -FilePath '${chromePath.replace(/'/g, "''")}'; Write-Output ($s.Status.ToString() + '|' + $s.SignerCertificate.Subject)`,
  ]);
  if (ps.status !== 0 || !ps.stdout.trim()) {
    return {
      id: "f9_l1_codesign",
      name: "F9 Layer 1 — OS codesign",
      status: "fail",
      detail: `Get-AuthenticodeSignature failed: ${ps.stderr.trim() || "no output"}`,
    };
  }
  const [status, subject] = ps.stdout.trim().split("|");
  if (status !== "Valid") {
    return {
      id: "f9_l1_codesign",
      name: "F9 Layer 1 — OS codesign",
      status: "fail",
      detail: `Authenticode status=${status} subject=${subject}`,
    };
  }
  const cnMatch = subject?.match(/CN="?([^,"]+)"?/);
  const vendor = cnMatch ? cnMatch[1].trim() : undefined;
  return {
    id: "f9_l1_codesign",
    name: "F9 Layer 1 — OS codesign",
    status: "pass",
    detail: `Authenticode Valid, ${subject}`,
    vendor,
  };
}

export function layer1Codesign(chromePath: string, opts: F9Options): F9CheckResult {
  const plat = platform();
  if (plat === "darwin") return layer1MacOS(chromePath, opts);
  if (plat === "win32") return layer1Windows(chromePath, opts);
  return layer1Linux(chromePath, opts);
}

// --- Layer 2 — Static SHA-256 pin ------------------------------------------

export function hashFile(p: string): string {
  const buf = readFileSync(p);
  return createHash("sha256").update(buf).digest("hex");
}

export function loadKnownGood(opts: F9Options): KnownGoodFile {
  const candidates = [
    opts._knownGoodPath,
    join(__dirname, "..", "data", "chrome-known-good-sha256.json"),
    join(__dirname, "..", "..", "data", "chrome-known-good-sha256.json"),
  ].filter((p): p is string => typeof p === "string");
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const raw = opts._readFile ? opts._readFile(p) : readFileSync(p, "utf8");
      return JSON.parse(raw) as KnownGoodFile;
    } catch {
      // fall through
    }
  }
  return { entries: [], vendors_accepted_default: [], vendor_id_macos_known: {} };
}

export function layer2ShaPin(execPath: string, opts: F9Options, vendor?: string, version?: string): F9CheckResult {
  let sha: string;
  try {
    sha = hashFile(execPath);
  } catch (e) {
    return {
      id: "f9_l2_sha_pin",
      name: "F9 Layer 2 — SHA-256 pin",
      status: "fail",
      detail: `Failed to hash ${execPath}: ${(e as Error).message}`,
    };
  }
  const kg = loadKnownGood(opts);
  const match = kg.entries.find((e) => e.sha256 === sha);
  if (match) {
    return {
      id: "f9_l2_sha_pin",
      name: "F9 Layer 2 — SHA-256 pin",
      status: "pass",
      detail: `SHA matches known-good ${match.vendor} ${match.channel} ${match.version} (${match.platform}/${match.arch})`,
      sha256: sha,
      version: match.version,
    };
  }
  // SHA not in list. This is NOT a hard fail — Chrome auto-updates ~weekly and
  // we are deliberately not live-fetching. Treat as "warn unless --strict".
  return {
    id: "f9_l2_sha_pin",
    name: "F9 Layer 2 — SHA-256 pin",
    status: "warn",
    detail: `SHA ${sha.slice(0, 16)}… not in known-good list (vendor=${vendor ?? "?"}, version=${version ?? "?"}). Expected for Chrome updates between list bumps; escalate to fail only under --strict.`,
    sha256: sha,
    version,
  };
}

// --- Layer 3 — Fork whitelist ----------------------------------------------

export function layer3ForkWhitelist(vendor: string | undefined, opts: F9Options): F9CheckResult {
  const mode: ForkMode = opts.forkMode ?? "default";
  if (mode === "permissive") {
    return {
      id: "f9_l3_fork",
      name: "F9 Layer 3 — Fork whitelist",
      status: "pass",
      detail: `--permissive: any valid codesign accepted (detected vendor=${vendor ?? "unknown"})`,
      vendor,
      forkMode: mode,
    };
  }
  if (!vendor) {
    return {
      id: "f9_l3_fork",
      name: "F9 Layer 3 — Fork whitelist",
      status: "fail",
      detail: "No vendor identity resolved from Layer 1 — cannot match whitelist",
      forkMode: mode,
    };
  }
  if (mode === "strict") {
    if (vendor === "Google LLC") {
      return {
        id: "f9_l3_fork",
        name: "F9 Layer 3 — Fork whitelist",
        status: "pass",
        detail: "--strict: Google LLC only",
        vendor,
        forkMode: mode,
      };
    }
    return {
      id: "f9_l3_fork",
      name: "F9 Layer 3 — Fork whitelist",
      status: "fail",
      detail: `--strict rejects vendor ${vendor}; only Google LLC accepted`,
      vendor,
      forkMode: mode,
    };
  }
  // default mode — accept any vendor in the known list
  const kg = loadKnownGood(opts);
  const accepted = kg.vendors_accepted_default;
  const matched = accepted.some((v) => v === vendor || vendor.includes(v));
  if (matched) {
    return {
      id: "f9_l3_fork",
      name: "F9 Layer 3 — Fork whitelist",
      status: "pass",
      detail: `Vendor ${vendor} on default whitelist`,
      vendor,
      forkMode: mode,
    };
  }
  return {
    id: "f9_l3_fork",
    name: "F9 Layer 3 — Fork whitelist",
    status: "fail",
    detail: `Vendor ${vendor} not on default whitelist (${accepted.join(", ")}). Use --permissive to accept any valid codesign.`,
    vendor,
    forkMode: mode,
  };
}

// --- Layer 4 — Runtime defense-in-depth ------------------------------------

function extensionDirs(): string[] {
  const home = homedir();
  if (platform() === "darwin") {
    return [
      join(home, "Library", "Application Support", "Google", "Chrome", "Default", "Extensions"),
      join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser", "Default", "Extensions"),
      join(home, "Library", "Application Support", "Microsoft Edge", "Default", "Extensions"),
    ];
  }
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return [
      join(local, "Google", "Chrome", "User Data", "Default", "Extensions"),
      join(local, "Microsoft", "Edge", "User Data", "Default", "Extensions"),
    ];
  }
  return [
    join(home, ".config", "google-chrome", "Default", "Extensions"),
    join(home, ".config", "chromium", "Default", "Extensions"),
    join(home, ".config", "BraveSoftware", "Brave-Browser", "Default", "Extensions"),
  ];
}

export function enumerateExtensions(opts: F9Options): Array<{ id: string; path: string }> {
  if (opts._listExtensions) return opts._listExtensions();
  const out: Array<{ id: string; path: string }> = [];
  for (const dir of extensionDirs()) {
    if (!existsSync(dir)) continue;
    for (const id of readdirSafely(dir)) {
      // Extension IDs are exactly 32 lowercase letters (a-p).
      if (!/^[a-p]{32}$/.test(id)) continue;
      out.push({ id, path: join(dir, id) });
    }
  }
  return out;
}

async function probePort(host: string, port: number, timeoutMs: number): Promise<"listening" | "closed" | "error"> {
  return new Promise((resolve) => {
    const s = createConnection({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (r: "listening" | "closed" | "error") => {
      if (done) return;
      done = true;
      try {
        s.destroy();
      } catch {
        /* noop */
      }
      resolve(r);
    };
    s.once("connect", () => finish("listening"));
    s.once("timeout", () => finish("closed"));
    s.once("error", () => finish("closed"));
  });
}

export async function layer4Runtime(opts: F9Options): Promise<{
  extCheck: F9CheckResult;
  portCheck: F9CheckResult;
}> {
  const exts = enumerateExtensions(opts);
  const extCheck: F9CheckResult = {
    id: "f9_l4_extensions",
    name: "F9 Layer 4a — Extension enumeration",
    status: "pass",
    detail: exts.length === 0 ? "No Chrome extensions found" : `${exts.length} extension(s) across known browsers`,
    extensions: exts,
  };
  const port = opts.cdpPort ?? 9222;
  const probe = opts._net ? await opts._net("127.0.0.1", port, 500) : await probePort("127.0.0.1", port, 500);
  const portCheck: F9CheckResult =
    probe === "listening"
      ? {
          id: "f9_l4_cdp_port",
          name: "F9 Layer 4b — CDP port hijack sniff",
          status: "warn",
          detail: `Port ${port} already listening — pre-existing process could be impersonating Chrome DevTools. Stop it before launching pop-pay, or set POP_CDP_URL to a different port.`,
        }
      : {
          id: "f9_l4_cdp_port",
          name: "F9 Layer 4b — CDP port hijack sniff",
          status: "pass",
          detail: `Port ${port} unclaimed — safe to bind`,
        };
  return { extCheck, portCheck };
}

// --- Orchestrator ----------------------------------------------------------

export interface F9RunResult {
  checks: F9CheckResult[];
  chromePath: string | null;
  executablePath: string | null;
  vendor?: string;
  teamId?: string;
  sha256?: string;
  forkMode: ForkMode;
}

export async function runF9Checks(opts: F9Options = {}): Promise<F9RunResult> {
  const forkMode = opts.forkMode ?? "default";
  const chromePath = resolveChromePath(opts.chromePath);
  if (!chromePath) {
    const miss: F9CheckResult = {
      id: "f9_l1_codesign",
      name: "F9 Layer 1 — OS codesign",
      status: "fail",
      detail: "No Chrome/Chromium binary found — cannot run F9 checks",
    };
    return { checks: [miss], chromePath: null, executablePath: null, forkMode };
  }
  const execPath = executablePathFor(chromePath);
  const l1 = layer1Codesign(chromePath, opts);
  const l2 = layer2ShaPin(execPath, opts, l1.vendor, l1.version);
  const l3 = layer3ForkWhitelist(l1.vendor, opts);
  const { extCheck, portCheck } = await layer4Runtime(opts);
  // Under --strict, L2 warn escalates to fail.
  if (forkMode === "strict" && l2.status === "warn") {
    l2.status = "fail";
    l2.detail = `--strict: ${l2.detail}`;
  }
  return {
    checks: [l1, l2, l3, extCheck, portCheck],
    chromePath,
    executablePath: execPath,
    vendor: l1.vendor,
    teamId: l1.teamId,
    sha256: l2.sha256,
    forkMode,
  };
}
