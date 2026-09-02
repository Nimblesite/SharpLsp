#!/usr/bin/env node
// End-to-end check of the Homebrew/Scoop renderer. [DIST-PATH-INSTALL]
//
// Runs tools/packaging/render-package-manifests.mjs against a fixture set of archives
// and asserts what a package manager actually depends on: every published
// platform is covered, every sha256 is the hash of the bytes that shipped, and
// each manifest lays the payload out where the host looks for its sidecars.
//
// These are the failures this catches, none of which surface until a user
// installs: a formula pointing at an asset the release does not publish, a
// checksum carried over from the previous version, and an install block that
// puts `sharplsp` on PATH without its sidecars.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER = fileURLToPath(new URL("./render-package-manifests.mjs", import.meta.url));
const VERSION = "1.2.3";
const REPO = "Nimblesite/SharpLsp";
const BASE = `https://github.com/${REPO}/releases/download/v${VERSION}`;

const UNIX = ["darwin-arm64", "linux-x64", "linux-arm64"];
const WINDOWS = ["win32-x64", "win32-arm64"];

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const work = mkdtempSync(join(tmpdir(), "sharplsp-pkg-"));
try {
  // Fixture archives. Contents are arbitrary; only their hashes matter, and
  // they are nested one directory deep the way download-artifact delivers them.
  const archives = join(work, "artifacts");
  const expected = {};
  for (const platform of [...UNIX, ...WINDOWS]) {
    const name = `sharplsp-${platform}.${platform.startsWith("win32") ? "zip" : "tar.gz"}`;
    const dir = join(archives, `server-${platform}`);
    mkdirSync(dir, { recursive: true });
    const body = Buffer.from(`fixture payload for ${platform}`);
    writeFileSync(join(dir, name), body);
    expected[name] = createHash("sha256").update(body).digest("hex");
  }

  const out = join(work, "out");
  execFileSync(
    process.execPath,
    [RENDERER, "--version", VERSION, "--repo", REPO, "--archives", archives, "--out", out],
    { stdio: "pipe" },
  );

  const formula = readFileSync(join(out, "sharplsp.rb"), "utf8");
  const manifest = JSON.parse(readFileSync(join(out, "sharplsp.json"), "utf8"));

  // ── Homebrew ────────────────────────────────────────────────────────────
  for (const platform of UNIX) {
    const name = `sharplsp-${platform}.tar.gz`;
    check(formula.includes(`url "${BASE}/${name}"`), `formula is missing the ${platform} url`);
    check(
      formula.includes(`sha256 "${expected[name]}"`),
      `formula has the wrong sha256 for ${platform}`,
    );
  }
  // Comments in the formula mention both of these deliberately, so the checks
  // look at code lines only.
  const formulaCode = formula
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  check(
    !formulaCode.includes("sharplsp-darwin-x64"),
    "formula references a darwin-x64 archive, which the release does not publish",
  );
  check(
    formula.includes("depends_on arch: :arm64"),
    "formula must refuse Intel macOS explicitly rather than 404 mid-download",
  );
  check(formula.includes('version "1.2.3"'), "formula version is not the released version");
  check(formula.includes('bin.install "sharplsp"'), "formula does not install the host");
  check(
    formula.includes('(lib/"sharplsp").install "sidecar-csharp", "sidecar-fsharp"'),
    "formula must install both sidecars into lib/sharplsp — the layout the host resolves",
  );
  check(
    !/depends_on "dotnet"/.test(formulaCode),
    "formula must not depend on the Homebrew dotnet formula; it is not net10.0",
  );
  check(
    /def caveats/.test(formulaCode) && formula.includes(".NET 10 SDK"),
    "formula must tell the user the .NET 10 SDK is required",
  );

  // ── Scoop ───────────────────────────────────────────────────────────────
  check(manifest.version === VERSION, "manifest version is not the released version");
  check(
    JSON.stringify(manifest.bin) === JSON.stringify(["sharplsp.exe"]),
    "manifest must shim only sharplsp.exe; the sidecars are spawned by it",
  );
  for (const [platform, arch] of [
    ["win32-x64", "64bit"],
    ["win32-arm64", "arm64"],
  ]) {
    const name = `sharplsp-${platform}.zip`;
    const entry = manifest.architecture?.[arch];
    check(Boolean(entry), `manifest is missing the ${arch} architecture`);
    check(entry?.url === `${BASE}/${name}`, `manifest has the wrong ${arch} url`);
    check(entry?.hash === expected[name], `manifest has the wrong ${arch} hash`);
    check(
      entry?.extract_dir === `sharplsp-${platform}`,
      `manifest ${arch} extract_dir must strip the archive root so the sidecars land beside the exe`,
    );
    check(
      manifest.autoupdate?.architecture?.[arch]?.url.includes("$version"),
      `manifest autoupdate for ${arch} must template the version`,
    );
  }

  // ── The renderer must fail loudly on a short release ─────────────────────
  rmSync(join(archives, "server-linux-arm64"), { recursive: true, force: true });
  let rejected = false;
  try {
    execFileSync(
      process.execPath,
      [RENDERER, "--version", VERSION, "--repo", REPO, "--archives", archives, "--out", out],
      { stdio: "pipe" },
    );
  } catch {
    rejected = true;
  }
  check(rejected, "renderer accepted a release with a missing archive");
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.exit(1);
}
process.stdout.write("==> Homebrew formula and Scoop manifest verified.\n");
