// [DIST-VSIX-DEV-INSTALL] Tests for the local install loop: `make reinstall-vsix`.
//
// This is the one command a developer runs to get their own change into their own
// VS Code, and every requirement of the spec section is an ordering or a flag
// that is invisible until it is wrong. A loop that cleans before it uninstalls
// leaves a stale extension loaded when the build fails; one that packages without
// rebuilding the Rust host or the sidecars installs the previous binaries under a
// new version number; one that installs without `--force` silently no-ops.
//
// These drive the REAL root Makefile with `make -n`, so the assertions are made
// against the recipe that developers actually execute - expanded through every
// recursive sub-make, with no reimplementation of the target here to drift from
// it. `-n` prints without running, so nothing is built, killed or uninstalled.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Expands a target's recipe through every sub-make without executing it. */
const dryRun = (target) => {
  const { status, stdout, stderr } = spawnSync('make', ['-n', target], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(status, 0, `make -n ${target} failed:\n${stderr}`);
  return stdout;
};

/** Byte offset of a step in the expanded recipe, asserting it is present. */
const stepAt = (recipe, needle) => {
  const at = recipe.indexOf(needle);
  assert.notEqual(at, -1, `step missing from recipe: ${needle}`);
  return at;
};

/** The root Makefile, which is the build system itself and not a shim. */
const makefile = () => readFileSync(resolve(ROOT, 'Makefile'), 'utf8');

/** Every target the Makefile declares .PHONY — what a target list shows. */
const phonyTargets = () =>
  [...makefile().matchAll(/^\.PHONY:((?:[^\n\\]*\\\n)*[^\n]*)/gm)]
    .flatMap((match) => match[1].split(/[\s\\]+/))
    .filter(Boolean);

/** The value make resolved for one of its own variables. */
const makeVariable = (name) => {
  const { status, stdout } = spawnSync('make', ['-n', '-p'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(status, 0, `make -p failed`);
  return new RegExp(`^${name} :?= ?(.*)$`, 'm').exec(stdout)?.[1] ?? '';
};

/** The identifier the loop must derive from the extension manifest, not hardcode. */
const manifestExtensionId = () => {
  const manifest = JSON.parse(
    readFileSync(resolve(ROOT, 'src/editors/vscode/package.json'), 'utf8'),
  );
  return `${manifest.publisher}.${manifest.name}`;
};

test('reinstall-vsix uninstalls, then cleans, then rebuilds, then installs', () => {
  const recipe = dryRun('reinstall-vsix');

  const uninstall = stepAt(recipe, '--uninstall-extension');
  const clean = stepAt(recipe, 'cargo clean');
  const buildRust = stepAt(recipe, 'cargo build --release');
  const packaged = stepAt(recipe, 'vsce package');
  const install = stepAt(recipe, '--install-extension');

  // Requirement 6: the extension comes off before anything is torn down, so a
  // build that dies midway cannot leave a stale SharpLsp posing as the change.
  assert.ok(uninstall < clean, 'uninstall must precede the clean');
  assert.ok(clean < buildRust, 'clean must precede the rebuild');
  assert.ok(buildRust < packaged, 'the host binary must be built before packaging');
  assert.ok(packaged < install, 'the VSIX must be packaged before it is installed');
  assert.ok(install > uninstall, 'the install is the last step, not the first');
});

test('reinstall-vsix rebuilds the binaries it packages, and kills what holds them', () => {
  const recipe = dryRun('reinstall-vsix');

  // All three components, per the spec's "full cycle".
  assert.match(recipe, /cargo build --release/, 'Rust host must be rebuilt');
  assert.match(recipe, /dotnet publish .*SharpLsp\.Sidecar\.CSharp\.csproj/, 'C# sidecar must be rebuilt');
  assert.match(recipe, /dotnet publish .*SharpLsp\.Sidecar\.FSharp\.fsproj/, 'F# sidecar must be rebuilt');
  assert.match(recipe, /npm run build --prefix src\/editors\/vscode/, 'extension must be rebuilt');

  // A running server holds its binary open - fatally so on Windows - and the
  // kill must happen before the clean that deletes it.
  const kill = stepAt(recipe, "pkill -9 -f 'sharplsp'");
  assert.ok(kill < stepAt(recipe, 'cargo clean'), 'stale servers must die before the clean');

  // The previous build's stage must not survive into the fresh package.
  assert.match(recipe, /rm -rf src\/editors\/vscode\/bin/, 'the VSIX bin/ stage must be cleared');
});

// [DIST-RUNTIME-ACQUIRE] The sidecar build must run against the SDK global.json
// pins, and `dotnet --list-sdks | grep '^10\.'` was never that check: it passed
// on a machine carrying 10.0.203 against a 10.0.303 pin, so the loop ran a full
// clean and a full Rust rebuild before dying on a bare exit 155.
//
// Testing the dotnet on PATH was not that check either. A satisfying SDK in
// ~/.dotnet beside a stale one in /usr/local/share/dotnet is the ordinary state
// of a macOS dev machine, and the build stopped on it every time to explain
// which root the developer should have exported. Resolving the root IS the fix.
test('the build resolves a dotnet that satisfies global.json, wherever it lives', () => {
  const pin = JSON.parse(readFileSync(resolve(ROOT, 'global.json'), 'utf8')).sdk;
  const root = makeVariable('DOTNET_ROOT');
  assert.ok(root, `make resolved no dotnet root, and global.json pins ${pin.version}`);

  // `dotnet --version` READS global.json, so a zero exit from the resolved root
  // is the pin being satisfied - rollForward and all - evaluated by the host
  // that owns those rules instead of reimplemented here.
  const dotnet = resolve(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const probe = spawnSync(dotnet, ['--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DOTNET_ROOT: root },
  });
  assert.equal(
    probe.status,
    0,
    `${dotnet} does not satisfy the pin:\n${probe.stdout}${probe.stderr}`,
  );
  assert.match(probe.stdout.trim(), /^\d+\.\d+\.\d+/);

  // Exported, not merely used in one recipe: MSBuild, the sidecars and the test
  // hosts must all run against the SDK the build was resolved against.
  assert.equal(makeVariable('SHARPLSP_DOTNET_ROOT'), root);
  assert.ok(makeVariable('PATH').includes(root), 'the resolved root must be on PATH for children');

  // rollForward across feature bands is the case that broke: assert the pin the
  // resolution defends is still the strict kind that makes this test meaningful.
  assert.equal(pin.rollForward, 'latestPatch');
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
});

test('with no satisfying SDK anywhere, the build says to install the pinned one', () => {
  const recipe = dryRun('_build-dotnet');

  assert.match(recipe, /global\.json/, 'the failure must name the file that set the pin');
  assert.match(recipe, /make install-dotnet-10/, 'the install remedy must be offered');
  assert.doesNotMatch(
    recipe,
    /--list-sdks[^|]*\|\s*grep -q/,
    'a --list-sdks grep cannot see a feature-band mismatch',
  );

  // The old failure handed the developer an export line to paste. Nothing is
  // left for them to put on PATH: a root that satisfies the pin is found and
  // used, so reaching this message means there is no such root to find.
  assert.doesNotMatch(recipe, /is not the dotnet on PATH/);
  assert.doesNotMatch(recipe, /export DOTNET_ROOT=/);
});

// [DIST-VSIX-DEV-INSTALL] rule 8.
test('the root Makefile is the build system, and its public surface is a dozen targets', () => {
  const text = makefile();

  // Not a shim around tools/make/*.mk: `make` must find the actions in the file
  // `make` looks for, and a target list must be one file long.
  assert.doesNotMatch(text, /^include /m, 'the root Makefile must not include another make file');

  const PUBLIC = [
    'audit',
    'build',
    'ci',
    'clean',
    'fmt',
    'install-dotnet-10',
    'install-vsix',
    'lint',
    'reinstall-vsix',
    'setup',
    'test',
    'uninstall-vsix',
  ];
  for (const target of PUBLIC) {
    assert.match(text, new RegExp(`^${target}:`, 'm'), `${target} must be defined here`);
  }

  // Every other target carries the `_` prefix, which is the whole convention:
  // a tool listing this file's targets shows the dozen a developer runs.
  const listed = phonyTargets().filter((target) => !target.startsWith('_'));
  assert.deepEqual([...new Set(listed)].sort(), PUBLIC);
});

test('the loop names the extension from the manifest and forces the install', () => {
  const recipe = dryRun('reinstall-vsix');
  const expectedId = manifestExtensionId();

  // Requirement 3: a hardcoded id drifts, and once did - uninstalling nothing.
  assert.match(recipe, new RegExp(`--uninstall-extension "${expectedId}"`));
  assert.notEqual(expectedId, 'sharplsp.sharp-lsp', 'stale id must not have returned');

  // Requirement 5: same-version reinstall must replace, not no-op.
  assert.match(recipe, /--install-extension "[^"]+" --force/);

  // Requirement 2: a Git Bash absolute path is unintelligible to a Windows code.cmd.
  assert.match(recipe, /--install-extension "dist\/sharplsp\.vsix"/);
  assert.doesNotMatch(recipe, /--install-extension "\//, 'VSIX path must stay repo-relative');
});

test('install-vsix and uninstall-vsix stand alone with the documented contracts', () => {
  const installRecipe = dryRun('install-vsix');
  const uninstallRecipe = dryRun('uninstall-vsix');

  // install-vsix installs what is on disk and fails loudly when it is absent.
  assert.match(installRecipe, /test -f dist\/sharplsp\.vsix/);
  assert.match(installRecipe, /ERROR: dist\/sharplsp\.vsix not found/);
  assert.doesNotMatch(installRecipe, /cargo build/, 'install-vsix must not rebuild');

  // Uninstalling nothing is a success: the loop runs on clean machines too.
  assert.match(uninstallRecipe, /--uninstall-extension "[^"]+" \|\| true/);

  // Requirement 1: the CLI is probed, never assumed, and a miss fails loudly.
  for (const recipe of [installRecipe, uninstallRecipe]) {
    assert.match(recipe, /for candidate in code code\.cmd/);
    assert.match(recipe, /ERROR: no VS Code CLI found/);
  }
});
