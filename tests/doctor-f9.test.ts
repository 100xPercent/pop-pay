import { describe, it, expect } from "vitest";
import {
  parseMacOSCodesign,
  layer1Codesign,
  layer2ShaPin,
  layer3ForkWhitelist,
  layer4Runtime,
  loadKnownGood,
  runF9Checks,
  type F9Options,
} from "../src/doctor-f9.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// --- Layer 1 parse ---------------------------------------------------------

describe("F9 Layer 1 — parse macOS codesign output", () => {
  it("extracts vendor + team id from canonical Authority line", () => {
    const out = `
Executable=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
Identifier=com.google.Chrome
Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)
Authority=Developer ID Certification Authority
`;
    const parsed = parseMacOSCodesign(out);
    expect(parsed.valid).toBe(true);
    expect(parsed.vendor).toBe("Google LLC");
    expect(parsed.teamId).toBe("EQHXZ8M8AV");
  });

  it("rejects output with no Developer ID Authority line", () => {
    const parsed = parseMacOSCodesign("some unrelated output\n");
    expect(parsed.valid).toBe(false);
  });

  it("handles Brave + Microsoft + Mozilla team ids", () => {
    const cases = [
      { line: "Authority=Developer ID Application: Brave Software Inc. (KL8N8XSYF4)", vendor: "Brave Software Inc.", tid: "KL8N8XSYF4" },
      { line: "Authority=Developer ID Application: Microsoft Corporation (UBF8T346G9)", vendor: "Microsoft Corporation", tid: "UBF8T346G9" },
      { line: "Authority=Developer ID Application: Mozilla Foundation (43AQ936H96)", vendor: "Mozilla Foundation", tid: "43AQ936H96" },
    ];
    for (const c of cases) {
      const parsed = parseMacOSCodesign(c.line + "\n");
      expect(parsed.vendor).toBe(c.vendor);
      expect(parsed.teamId).toBe(c.tid);
    }
  });
});

// --- Layer 1 dispatch (mocked exec) ----------------------------------------

describe("F9 Layer 1 — codesign dispatch", () => {
  const mockExec = (responses: Record<string, { status: number; stdout: string; stderr: string }>) =>
    (cmd: string, args: string[]) => {
      const key = [cmd, ...args].join(" ");
      for (const k of Object.keys(responses)) {
        if (key.includes(k)) return { ...responses[k], status: responses[k].status as number | null };
      }
      return { status: 1, stdout: "", stderr: "no mock match" };
    };

  it("macOS path: passes when codesign verify+info both succeed", () => {
    if (process.platform !== "darwin") return; // dispatch is platform-bound
    const opts: F9Options = {
      _exec: mockExec({
        "codesign --verify": { status: 0, stdout: "", stderr: "" },
        "codesign -dv --verbose=4": {
          status: 0,
          stdout: "",
          stderr: "Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)\n",
        },
      }),
    };
    const r = layer1Codesign("/Applications/Google Chrome.app", opts);
    expect(r.status).toBe("pass");
    expect(r.vendor).toBe("Google LLC");
    expect(r.teamId).toBe("EQHXZ8M8AV");
  });

  it("macOS path: fails when codesign verify exits non-zero", () => {
    if (process.platform !== "darwin") return;
    const opts: F9Options = {
      _exec: mockExec({
        "codesign --verify": { status: 1, stdout: "", stderr: "invalid signature" },
      }),
    };
    const r = layer1Codesign("/Applications/Google Chrome.app", opts);
    expect(r.status).toBe("fail");
  });

  it("Linux path: passes when dpkg integrity clean", () => {
    if (process.platform !== "linux") return;
    const opts: F9Options = {
      _exec: mockExec({
        "dpkg -S": { status: 0, stdout: "google-chrome-stable: /usr/bin/google-chrome\n", stderr: "" },
        "dpkg -V": { status: 0, stdout: "", stderr: "" },
      }),
    };
    const r = layer1Codesign("/usr/bin/google-chrome", opts);
    expect(r.status).toBe("pass");
    expect(r.vendor).toBe("Google LLC");
  });

  it("Linux path: fails when dpkg -V reports changed checksums", () => {
    if (process.platform !== "linux") return;
    const opts: F9Options = {
      _exec: mockExec({
        "dpkg -S": { status: 0, stdout: "google-chrome-stable: /usr/bin/google-chrome\n", stderr: "" },
        "dpkg -V": { status: 1, stdout: "..5......  /usr/bin/google-chrome\n", stderr: "" },
      }),
    };
    const r = layer1Codesign("/usr/bin/google-chrome", opts);
    expect(r.status).toBe("fail");
  });

  it("Windows path: passes when Authenticode Valid", () => {
    if (process.platform !== "win32") return;
    const opts: F9Options = {
      _exec: mockExec({
        "Get-AuthenticodeSignature": {
          status: 0,
          stdout: 'Valid|CN="Google LLC", O=Google LLC, L=Mountain View, S=California, C=US\n',
          stderr: "",
        },
      }),
    };
    const r = layer1Codesign("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", opts);
    expect(r.status).toBe("pass");
    expect(r.vendor).toBe("Google LLC");
  });

  it("Windows path: fails when status not Valid", () => {
    if (process.platform !== "win32") return;
    const opts: F9Options = {
      _exec: mockExec({
        "Get-AuthenticodeSignature": {
          status: 0,
          stdout: "NotSigned|\n",
          stderr: "",
        },
      }),
    };
    const r = layer1Codesign("C:\\x\\chrome.exe", opts);
    expect(r.status).toBe("fail");
  });
});

// --- Layer 2 SHA pin -------------------------------------------------------

describe("F9 Layer 2 — SHA-256 pin", () => {
  function mockKnownGoodFile(sha: string): string {
    const dir = mkdtempSync(join(tmpdir(), "f9-kg-"));
    const body = {
      entries: [
        {
          vendor: "Google LLC",
          channel: "stable",
          version: "147.0.0",
          platform: process.platform,
          arch: "universal",
          sha256: sha,
        },
      ],
      vendors_accepted_default: ["Google LLC", "Brave Software Inc.", "Microsoft Corporation", "Mozilla Foundation"],
      vendor_id_macos_known: { "Google LLC": "EQHXZ8M8AV" },
    };
    const p = join(dir, "kg.json");
    writeFileSync(p, JSON.stringify(body));
    return p;
  }

  it("matches known-good entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "f9-bin-"));
    const binPath = join(dir, "chrome-bin");
    const payload = Buffer.from("fake-chrome-binary");
    writeFileSync(binPath, payload);
    const sha = createHash("sha256").update(payload).digest("hex");
    const kgPath = mockKnownGoodFile(sha);
    const r = layer2ShaPin(binPath, { _knownGoodPath: kgPath }, "Google LLC");
    expect(r.status).toBe("pass");
    expect(r.sha256).toBe(sha);
  });

  it("warns (not fails) when SHA not in list under default mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "f9-bin-"));
    const binPath = join(dir, "chrome-bin");
    writeFileSync(binPath, Buffer.from("some-other-bytes"));
    const kgPath = mockKnownGoodFile("0000000000000000000000000000000000000000000000000000000000000000");
    const r = layer2ShaPin(binPath, { _knownGoodPath: kgPath }, "Google LLC");
    expect(r.status).toBe("warn");
  });

  it("returns fail when binary is unreadable", () => {
    const r = layer2ShaPin("/nonexistent/path/chrome", {});
    expect(r.status).toBe("fail");
  });
});

// --- Layer 3 fork whitelist ------------------------------------------------

describe("F9 Layer 3 — fork whitelist", () => {
  const kgOpts: F9Options = {
    // Inline fake known-good through _knownGoodPath is awkward; instead just
    // drive via fork mode + vendor since default whitelist is read from the
    // packaged data file at runtime.
  };

  it("default mode passes Google", () => {
    const r = layer3ForkWhitelist("Google LLC", { forkMode: "default", ...kgOpts });
    expect(r.status).toBe("pass");
  });

  it("default mode passes Brave", () => {
    const r = layer3ForkWhitelist("Brave Software Inc.", { forkMode: "default", ...kgOpts });
    expect(r.status).toBe("pass");
  });

  it("default mode fails an off-list vendor", () => {
    const r = layer3ForkWhitelist("Sketchy Forks Ltd.", { forkMode: "default", ...kgOpts });
    expect(r.status).toBe("fail");
  });

  it("strict mode passes only Google", () => {
    expect(layer3ForkWhitelist("Google LLC", { forkMode: "strict" }).status).toBe("pass");
    expect(layer3ForkWhitelist("Brave Software Inc.", { forkMode: "strict" }).status).toBe("fail");
  });

  it("permissive mode passes any vendor even if off-list", () => {
    const r = layer3ForkWhitelist("Anyone", { forkMode: "permissive" });
    expect(r.status).toBe("pass");
  });

  it("fails when vendor is undefined under default/strict", () => {
    expect(layer3ForkWhitelist(undefined, { forkMode: "default" }).status).toBe("fail");
    expect(layer3ForkWhitelist(undefined, { forkMode: "strict" }).status).toBe("fail");
  });
});

// --- Layer 4 runtime -------------------------------------------------------

describe("F9 Layer 4 — runtime checks", () => {
  it("extensions: uses injected enumerator", async () => {
    const exts = [{ id: "a".repeat(32), path: "/mock/a" }];
    const r = await layer4Runtime({ _listExtensions: () => exts, _net: async () => "closed" });
    expect(r.extCheck.status).toBe("pass");
    expect(r.extCheck.extensions).toEqual(exts);
  });

  it("CDP port: warns when already listening", async () => {
    const r = await layer4Runtime({ _listExtensions: () => [], _net: async () => "listening" });
    expect(r.portCheck.status).toBe("warn");
  });

  it("CDP port: passes when unclaimed", async () => {
    const r = await layer4Runtime({ _listExtensions: () => [], _net: async () => "closed" });
    expect(r.portCheck.status).toBe("pass");
  });
});

// --- Orchestrator ---------------------------------------------------------

describe("F9 orchestrator", () => {
  it("escalates L2 warn to fail under --strict", async () => {
    // Drive with a deliberately wrong chromePath so L1 fails AND with a fake
    // known-good file so L2 warn path can be exercised in isolation. We cover
    // --strict escalation by directly invoking runF9Checks() and looking for
    // the escalation on L2.
    const dir = mkdtempSync(join(tmpdir(), "f9-orch-"));
    const binPath = join(dir, "bin");
    writeFileSync(binPath, Buffer.from("mismatch"));
    const kgDir = mkdtempSync(join(tmpdir(), "f9-orch-kg-"));
    const kgPath = join(kgDir, "kg.json");
    writeFileSync(
      kgPath,
      JSON.stringify({
        entries: [],
        vendors_accepted_default: ["Google LLC"],
        vendor_id_macos_known: {},
      }),
    );
    const r = await runF9Checks({
      chromePath: binPath,
      forkMode: "strict",
      _knownGoodPath: kgPath,
      _exec: () => ({ status: 0, stdout: "", stderr: "Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)\n" }),
      _net: async () => "closed",
      _listExtensions: () => [],
    });
    const l2 = r.checks.find((c) => c.id === "f9_l2_sha_pin");
    expect(l2?.status).toBe("fail");
  });
});

// --- Data file integrity ---------------------------------------------------

describe("F9 data/chrome-known-good-sha256.json", () => {
  it("loads and has at least one entry for operator OS/arch", () => {
    const kg = loadKnownGood({});
    expect(kg.entries.length).toBeGreaterThan(0);
    expect(kg.vendors_accepted_default).toContain("Google LLC");
  });

  it("all SHA values are lowercase 64-hex", () => {
    const kg = loadKnownGood({});
    for (const e of kg.entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
