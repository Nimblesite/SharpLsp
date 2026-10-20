// [DIST-VSIX-DEV-INSTALL] The install loop reaches every VS Code profile that runs SharpLsp.
//
// The CLI installs into the default profile unless told `--profile`, and a window
// whose workspace is associated with another profile keeps loading that profile's
// copy: the developer reloads and still runs the old build. These tests run the
// real profile lister against a fixture user data directory, and the real install
// and uninstall recipes against a fake VS Code CLI that records every call.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dryRun, stepAt } from "./make-test-kit.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LISTER = join(ROOT, "tools/vsix/vscode-profiles.mjs");
const ID = "nimblesite.sharplsp";
const PROFILES = ".NET|Rust, Python, .NET";

/** A VS Code user data directory holding `profiles`, each `[name, extensionIds | null, shared]`. */
function userDataDir(profiles) {
  const root = mkdtempSync(join(tmpdir(), "slsp-profiles-"));
  const user = join(root, "User");
  mkdirSync(join(user, "globalStorage"), { recursive: true });
  const entries = profiles.map(([name, ids, shared], index) => {
    const location = `p${index}`;
    mkdirSync(join(user, "profiles", location), { recursive: true });
    if (ids !== null) {
      const extensions = ids.map((id) => ({ identifier: { id }, version: "0.1.0" }));
      writeFileSync(join(user, "profiles", location, "extensions.json"), JSON.stringify(extensions));
    }
    return { location, name, ...(shared ? { useDefaultFlags: { extensions: true } } : {}) };
  });
  writeFileSync(join(user, "globalStorage", "storage.json"), JSON.stringify({ userDataProfiles: entries }));
  return root;
}

function list(dataDir, args = [ID]) {
  return spawnSync("node", [LISTER, ...args], {
    encoding: "utf8",
    env: { ...process.env, VSCODE_USER_DATA_DIR: dataDir },
  });
}

test("the lister names exactly the profiles holding their own copy of the extension", () => {
  const dataDir = userDataDir([
    [".NET", ["Nimblesite.SharpLsp", "ms-dotnettools.csharp"], false],
    ["Dart", ["dart-code.dart-code"], false],
    ["Rust, Python, .NET", [ID], false],
    ["Shared", [ID], true],
    ["Fresh", null, false],
  ]);
  const { status, stdout } = list(dataDir);
  assert.equal(status, 0);
  assert.equal(stdout, PROFILES, "case-insensitive id; shared and extension-less profiles left out");
  assert.equal(list(dataDir, ["someone.else"]).stdout, "", "a profile without it is never named");
});

test("the lister answers nothing, not an error, without VS Code data, and needs an id", () => {
  const empty = mkdtempSync(join(tmpdir(), "slsp-profiles-none-"));
  const none = list(empty);
  assert.equal(none.status, 0);
  assert.equal(none.stdout, "", "no storage.json means the default profile only");
  const missing = list(empty, []);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: node tools\/vsix\/vscode-profiles\.mjs <extension id>/);
});

/** Run `target` for real with a fake VS Code CLI; the CLI's calls, one per line. */
function runWithFakeCli(target) {
  const dir = mkdtempSync(join(tmpdir(), "slsp-fake-code-"));
  const calls = join(dir, "calls.log");
  const code = join(dir, "code");
  writeFileSync(code, `#!/bin/sh\nprintf '%s;' "$@" >> '${calls}'\necho >> '${calls}'\n`);
  chmodSync(code, 0o755);
  const vsix = join(dir, "sharplsp.vsix");
  writeFileSync(vsix, "");
  const args = [target, `CODE=${code}`, `DEV_VSIX=${vsix}`, `VSCODE_PROFILES=${PROFILES}`];
  const { status, stderr } = spawnSync("make", args, { cwd: ROOT, encoding: "utf8" });
  assert.equal(status, 0, `make ${target} failed:\n${stderr}`);
  return { vsix, calls: readFileSync(calls, "utf8").trim().split("\n") };
}

test("install-vsix installs into the default profile, then each profile on the list", { skip: process.platform === "win32" }, () => {
  const { vsix, calls } = runWithFakeCli("install-vsix");
  assert.deepEqual(calls, [
    `--install-extension;${vsix};--force;`,
    `--install-extension;${vsix};--force;--profile;.NET;`,
    `--install-extension;${vsix};--force;--profile;Rust, Python, .NET;`,
  ]);
});

test("uninstall-vsix removes it from the default profile and each profile on the list", { skip: process.platform === "win32" }, () => {
  const { calls } = runWithFakeCli("uninstall-vsix");
  assert.equal(calls.length, 3, "one uninstall per profile, the default first");
  assert.equal(calls[0], `--uninstall-extension;${ID};`);
  assert.equal(calls[2], `--uninstall-extension;${ID};--profile;Rust, Python, .NET;`);
});

test("reinstall-vsix reads the profiles before it uninstalls, and installs into the same ones", () => {
  const recipe = dryRun("reinstall-vsix", [`VSCODE_PROFILES=${PROFILES}`]);
  const captured = stepAt(recipe, `profiles='${PROFILES}'`);
  assert.ok(captured < stepAt(recipe, "--uninstall-extension"), "captured before the uninstall");
  assert.match(recipe, /make\S* uninstall-vsix VSCODE_PROFILES="\$profiles"/);
  assert.match(recipe, /make\S* install-vsix VSCODE_PROFILES="\$profiles"/);
});
