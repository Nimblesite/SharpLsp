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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Expands a target's recipe through every sub-make without executing it. */
const dryRun = (target, args = []) => {
  const { status, stdout, stderr } = spawnSync('make', ['-n', target, ...args], {
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


/**
 * The PATH a recipe's CHILD process inherits, with `env` poisoning make's own.
 *
 * Driven through `MAKEFILES`, which make reads BEFORE the root Makefile, so the
 * probe target sees exactly the environment every real recipe exports. Nothing
 * here asserts on a variable make prints — a child's lookup is the thing that
 * was wrong, so a child is what gets asked.
 */
const childPath = (env) => {
  const probe = join(mkdtempSync(join(tmpdir(), 'sharplsp-make-')), 'probe.mk');
  writeFileSync(probe, '_probe_path:\n\t@echo "$$PATH"\n');
  const { status, stdout, stderr } = spawnSync('make', ['_probe_path'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env, MAKEFILES: probe },
  });
  assert.equal(status, 0, `make _probe_path failed:\n${stderr}`);
  return stdout.trim().split(delimiter);
};

/**
 * A dotnet root whose path contains a SPACE, holding an executable that
 * announces itself.
 *
 * `C:\\Program Files\\dotnet` is where the Windows installer puts the SDK, and
 * Git Bash hands it to make as `/c/Program Files/dotnet`. Nothing about that is
 * exotic - it is the platform DEFAULT - and a space in a path is the single
 * most predictable difference between Windows and every other platform. Nothing
 * in this suite asserted on one before, which is why an unquoted `$(DOTNET)`
 * reached main and took the Windows build down at exit 127.
 *
 * `SHARPLSP_DOTNET_ROOT` is an ordinary variable, so a Linux runner can pose
 * the question perfectly well. This needs no Windows runner.
 */
const rootWithSpace = () => {
  const root = join(mkdtempSync(join(tmpdir(), 'sharplsp-sdk-')), 'Program Files', 'dotnet');
  mkdirSync(root, { recursive: true });
  for (const name of ['dotnet', 'dotnet.exe']) {
    const exe = join(root, name);
    writeFileSync(exe, '#!/bin/sh\necho 10.0.303\n');
    chmodSync(exe, 0o755);
  }
  return root;
};

/** Run a probe recipe through the REAL Makefile, returning the raw result. */
const probeRecipe = (body, env) => {
  const probe = join(mkdtempSync(join(tmpdir(), 'sharplsp-make-')), 'probe.mk');
  writeFileSync(probe, `_probe:\n\t@${body}\n`);
  return spawnSync('make', ['_probe'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env, MAKEFILES: probe },
  });
};

// [DIST-RUNTIME-ACQUIRE] The resolved root is interpolated into every recipe
// that spawns the SDK. Unquoted, a root with a space splits and the shell runs
// `/c/Program`: exit 127, and `_build-dotnet` dies before it compiles anything.
test('a dotnet root containing a space is executed, not split into words', () => {
  const root = rootWithSpace();
  const { status, stdout, stderr } = probeRecipe('$(DOTNET) --version', {
    SHARPLSP_DOTNET_ROOT: root,
  });
  assert.equal(status, 0, `make could not run the dotnet it resolved at ${root}:\n${stderr}`);
  assert.match(
    stdout,
    /10\.0\.303/,
    `the recipe ran something other than the resolved dotnet:\n${stdout}${stderr}`,
  );
});

// The SDK banner reports the version through a command substitution, and a
// substitution that fails still lets `echo` exit 0. Unquoted, it printed
// "==> SDK:  from /c/Program Files/dotnet" - a blank version, no error, and the
// build carried on. Agents.md: no silent failures.
test('the SDK banner names a version instead of reporting an empty one', () => {
  const root = rootWithSpace();
  const { status, stdout, stderr } = probeRecipe('$(CHECK_DOTNET_PIN)', {
    SHARPLSP_DOTNET_ROOT: root,
  });
  assert.equal(status, 0, `the pin check failed against ${root}:\n${stderr}`);
  assert.match(
    stdout,
    new RegExp(`==> SDK: 10\\.0\\.303 from ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    `the banner reported no version, and said so without failing:\n${stdout}`,
  );
});

// The same space defeats a precedence test built on `firstword`, which splits on
// whitespace: the head of `/c/Program Files/dotnet:/usr/bin` reads as
// `/c/Program`, never equals the root, and every nested sub-make prepends again.
test('a root containing a space leads the PATH exactly once', () => {
  const root = rootWithSpace();
  const probe = join(mkdtempSync(join(tmpdir(), 'sharplsp-make-')), 'probe.mk');
  writeFileSync(probe, '_probe_path:\n\t@echo "$$PATH"\n');
  const { status, stdout, stderr } = spawnSync('make', ['_probe_path'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SHARPLSP_DOTNET_ROOT: root,
      PATH: [root, '/usr/bin', '/bin'].join(delimiter),
      MAKEFILES: probe,
    },
  });
  assert.equal(status, 0, `make _probe_path failed:\n${stderr}`);
  const entries = stdout.trim().split(delimiter);
  assert.equal(entries[0], root, `a spaced root lost the lookup to ${entries[0]}`);
  assert.equal(
    entries.filter((entry) => entry === root).length,
    1,
    `the spaced root was stacked more than once: ${entries.join(delimiter)}`,
  );
});

// [DIST-RELEASE] The packaging targets derive the platform from their own name,
// and `release.yml:148` is the ONLY caller in the repo - no PR pipeline runs
// them, so a break here surfaces first on a tag. It already had: the targets
// were renamed `package-vsix-*` -> `_package-vsix-*` when tools/make/main.mk was
// consolidated, and `$(subst package-vsix-,,$@)` matches from index 1, leaving
// the underscore behind. Every platform packaged as `_win32-x64`: an unknown
// --target for vsce, a misnamed .vsix, a bin/ staging dir nothing reads.
for (const platform of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']) {
  test(`_package-vsix-${platform} packages that platform, underscore-free`, () => {
    const recipe = dryRun(`_package-vsix-${platform}`, ['VSIX_PREBUILT=1']);
    assert.ok(
      recipe.includes(`--target ${platform}`),
      `vsce must be handed ${platform}; it rejects anything else`,
    );
    assert.ok(
      recipe.includes(`sharplsp-${platform}.vsix`),
      `the artifact must be named for ${platform}, or the release uploads a file nobody looks for`,
    );
    assert.ok(
      !recipe.includes(`_${platform}`),
      `the target's leading underscore leaked into the platform name: ${
        recipe.split('\n').find((line) => line.includes(`_${platform}`)) ?? ''
      }`,
    );
  });
}

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
  assert.match(recipe, /dotnet(\.exe)?" publish .*SharpLsp\.Sidecar\.CSharp\.csproj/, 'C# sidecar must be rebuilt');
  assert.match(recipe, /dotnet(\.exe)?" publish .*SharpLsp\.Sidecar\.FSharp\.fsproj/, 'F# sidecar must be rebuilt');
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

// [DIST-VSIX-CONTENTS] The loop must not install a VSIX it never checked.
//
// Every copy and rename in `_stage-vsix-binary-only` ends in
// `2>/dev/null || true`, so a stage that half-ran is indistinguishable from one
// that worked: packaging proceeds, `--install-extension` succeeds, and the
// developer learns the host or a sidecar is missing as activation failures.
// `_test-vsix` has gated on `_verify-vsix-payload` all along. The one command a
// developer actually runs to install their own build did not.
test('reinstall-vsix verifies the payload before it installs anything', () => {
  const recipe = dryRun('reinstall-vsix');

  const verify = stepAt(recipe, 'verify-vsix-payload.mjs');
  const packaged = stepAt(recipe, 'vsce package');
  const install = stepAt(recipe, '--install-extension');

  // The gate runs, and it runs while there is still something to gate on.
  assert.ok(verify < install, 'the payload must be verified before the install');
  assert.ok(
    verify < packaged || verify < install,
    'verification must bracket the package step, not trail the install',
  );

  // The verifier reads the staged tree, so the stage must still be on disk when
  // it runs - `_build-vsix` ends with `rm -rf bin`, which is what makes a plain
  // prerequisite useless here.
  assert.match(recipe, /_stage-vsix-binary-only|cp target\/release\/sharplsp/, 'stage must precede verification');

  // The production bundle is what ships, so it is what gets judged.
  assert.match(recipe, /npm run build:production/, 'the verifier must judge the production bundle');
});

// [DIST-VSIX-DEV-INSTALL] Requirement 7: the dev VSIX carries THIS platform's
// host binary and THIS platform's debug adapter. A package built without
// `--target` has no TargetPlatform in its manifest, so VS Code treats it as
// universal and will install it anywhere - onto machines whose host binary and
// netcoredbg are simply not in it. Every released VSIX is built with --target;
// the dev loop must produce the same shape or it is not exercising what ships.
test('the dev VSIX is packaged for the host platform, like every released VSIX', () => {
  // `make -n` prints a recipe line's backslash continuations as separate lines,
  // so flatten them before matching: the assertion is about the command, not
  // about where someone chose to wrap it.
  const recipe = dryRun('reinstall-vsix').replace(/\\\n\s*/g, ' ');

  // HOST_PLATFORM is `process.platform + '-' + process.arch` evaluated by node
  // (Makefile), which is vsce's own target vocabulary - darwin-arm64,
  // linux-x64, win32-x64. `make -p` would hand back the unexpanded $(shell ...)
  // definition, so compute the expected value the same way the Makefile does.
  const hostPlatform = `${process.platform}-${process.arch}`;
  assert.match(
    makefile(),
    /^HOST_PLATFORM = \$\(shell node -e "process\.stdout\.write\(process\.platform \+ '-' \+ process\.arch\)"\)$/m,
    'HOST_PLATFORM must stay node-derived, so it keeps matching vsce target ids',
  );

  assert.match(
    recipe,
    /vsce package[^\n]*--target /,
    'the dev package must declare a target platform',
  );
  assert.match(
    recipe,
    new RegExp(`vsce package[^\\n]*--target ${hostPlatform}\\b`),
    `the dev package must target the host platform (${hostPlatform})`,
  );

  // The staged host binary and the declared target must be the same platform,
  // or the VSIX advertises one platform and carries another.
  assert.match(
    recipe,
    new RegExp(`src/editors/vscode/bin/${hostPlatform}/sharplsp`),
    'the staged host binary must sit under the same platform the package targets',
  );
});

// [DIST-RUNTIME-ACQUIRE] Resolving the root is only half the fix. `$(DOTNET)` is
// absolute, so every RECIPE is immune — but the tools those recipes spawn are
// not: build-test-fixtures.mjs, dotnet-vulnerable.mjs and the packaging scripts
// all run a bare `dotnet`, and a bare `dotnet` is whatever PATH says first.
//
// The guard that skipped the prepend tested whether the resolved root was
// PRESENT on PATH. The requirement is that it be FIRST. A machine carrying a
// stale root ahead of a good one — `export PATH="$DOTNET_ROOT:$PATH"` in a
// shell profile, pointing at /usr/local/share/dotnet — satisfies "present" and
// loses the lookup, so the prepend was skipped in exactly the configuration it
// exists to fix, and the audit leg and the fixture build ran on the wrong SDK.
//
// Both cases below must resolve to the pinned root. Only the FIRST of them
// discriminates: with the root absent from PATH the old guard prepends and
// passes, which is why "absent" alone would have proved nothing.
test('the resolved SDK wins the PATH, not merely appears on it', () => {
  const root = makeVariable('DOTNET_ROOT');
  assert.ok(root, 'make resolved no dotnet root to put on PATH');
  const stale = resolve('/nonexistent-stale-dotnet-root');
  assert.notEqual(stale, root, 'the stale root must not be the resolved one');

  const outranked = childPath({
    PATH: [stale, root, '/usr/bin', '/bin'].join(delimiter),
    DOTNET_ROOT: stale,
  });
  assert.equal(
    outranked[0],
    root,
    `a stale root outranked the pinned one: a child would run ${outranked[0]}/dotnet`,
  );

  const absent = childPath({
    PATH: [stale, '/usr/bin', '/bin'].join(delimiter),
    DOTNET_ROOT: stale,
  });
  assert.equal(absent[0], root, 'and the root is still prepended when it is absent entirely');

  // Idempotent: once the root is first, a nested sub-make must not stack it
  // again. Duplicate-free is what the original guard was reaching for, and
  // testing precedence gets it for free.
  const already = childPath({ PATH: [root, '/usr/bin', '/bin'].join(delimiter) });
  assert.equal(already[0], root, 'a PATH already led by the root keeps it');
  assert.equal(
    already.filter((entry) => entry === root).length,
    1,
    `the root was stacked more than once: ${already.join(delimiter)}`,
  );
});
