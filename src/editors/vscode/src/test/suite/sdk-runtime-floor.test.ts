import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { candidateDotnetRoots, dotnetExecutable } from '../../dotnet-roots.js';
import { type SdkPin, pinSatisfiedBy, runtimeFloorMet } from '../../global-json.js';
import { findSidecarSdk, supportsSidecars } from '../../dotnet-host.js';
import { removeDirRecursive } from './test-helpers.js';
import { FIXTURE_BUILD_MS, SETTLE_MS } from './test-timeouts.js';

/**
 * Whether a .NET root can host the sidecars is decided by ONE authority: the
 * sidecars. Issue #297.
 *
 * Every other suite asserts a predicate against a version table someone typed
 * out, which can only re-state the belief that produced the predicate. This one
 * derives its expectation by LAUNCHING the real staged C# and F# sidecars on
 * each root and reading the exit code, so a predicate that disagrees with the
 * process it is predicting fails here — whichever of the two is wrong, and
 * without anyone having to know the right answer in advance.
 *
 * The roots below are the ones a same-major fixture generator cannot build: a
 * prerelease runtime below its own release, a prerelease above it, a major
 * ahead of the sidecars', and an SDK major differing from the runtime's. Those
 * four are exactly where a "does this look like 10?" check goes wrong.
 *
 * Implements [DIST-RUNTIME-ACQUIRE].
 */

/** The floor the sidecars' `runtimeconfig.json` asks hostfxr for. */
const SIDECAR_FRAMEWORK = '10.0.0';
const FRAMEWORK = path.join('shared', 'Microsoft.NETCore.App');

/** Directory names under one component of a root, or nothing when unreadable. */
function namesUnder(root: string, component: string): string[] {
  try {
    return fs.readdirSync(path.join(root, component));
  } catch {
    return [];
  }
}

const realSdks = (root: string): string[] => namesUnder(root, 'sdk');
const realRuntimes = (root: string): string[] => namesUnder(root, FRAMEWORK);

/**
 * A real installed root carrying a real >= 10 runtime: the source of the muxer,
 * hostfxr and the runtime bits every fixture needs to genuinely launch.
 */
function realSource(): string {
  const found = candidateDotnetRoots().find((root) =>
    realRuntimes(root).some((version) => version.startsWith('10.')),
  );
  assert.ok(found, 'a real .NET 10 runtime is required to compose hosts that really start');
  return found;
}

/**
 * The first root carrying an SDK of this major, wherever it lives.
 *
 * SDKs and runtimes are installed independently and land in different roots on
 * an ordinary machine: here `~/.dotnet` carries 10.0.100 and 10.0.303 with no
 * 9.x at all, while `/usr/local/share/dotnet` carries 9.0.312. Requiring ONE
 * root to supply every major a fixture needs makes the suite depend on which
 * root happens to be probed first, which is a property of the machine and not
 * of the code under test.
 */
function sdkSource(prefix: string): string | undefined {
  return candidateDotnetRoots().find((root) => newest(realSdks(root), prefix) !== undefined);
}

/** The newest real directory whose name starts with `prefix`. */
function newest(names: readonly string[], prefix: string): string | undefined {
  return [...names]
    .filter((name) => name.startsWith(prefix))
    .sort()
    .pop();
}

function cloneInto(source: string, relative: string, target: string): void {
  fs.cpSync(path.join(source, relative), target, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
}

/** Every hostfxr the source ships: the muxer picks the newest it can find. */
function copyFxr(source: string, root: string): void {
  for (const version of namesUnder(source, path.join('host', 'fxr'))) {
    cloneInto(source, path.join('host', 'fxr', version), path.join(root, 'host', 'fxr', version));
  }
}

/** Real runtime bits, advertised under the version name being tested. */
function copyRuntime(source: string, root: string, advertised: string): void {
  const real = newest(realRuntimes(source), '10.') ?? realRuntimes(source)[0];
  assert.ok(real, 'the source install must carry a real runtime to compose from');
  cloneInto(source, path.join(FRAMEWORK, real), path.join(root, FRAMEWORK, advertised));
}

/**
 * A real, launchable root advertising exactly one SDK and one runtime.
 *
 * The muxer is COPIED, never symlinked: it resolves its root from its own real
 * path, so a symlinked one reports the SOURCE root's runtimes and every
 * assertion here would silently be about the wrong machine.
 *
 * `runtimeAs` renames real runtime bits to the version under test. hostfxr
 * selects frameworks by directory NAME, which is the mechanism being tested;
 * the binaries inside stay real, so the process genuinely starts whenever the
 * name says it may.
 */
function composeRoot(
  scratch: string,
  source: string,
  name: string,
  sdkPrefix: string,
  runtimeAs: string,
): string {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(dotnetExecutable(source), dotnetExecutable(root));
  fs.chmodSync(dotnetExecutable(root), 0o755);
  stageSdk(root, sdkPrefix);
  copyFxr(source, root);
  copyRuntime(source, root, runtimeAs);
  return dotnetExecutable(root);
}

/**
 * Give the root an SDK of `prefix`, copied from wherever one really is.
 *
 * When the machine has no SDK of that major anywhere, the directory is created
 * by name instead. That is enough and it is not a shortcut: the only consumer
 * of `sdk/` in this whole path is `installedSdkVersions`, which reads directory
 * NAMES — nothing here executes an SDK, and the sidecars are
 * framework-dependent, so what decides whether they start is the runtime, which
 * is always real. Falling back keeps the suite meaningful on a machine that
 * happens to carry only one SDK major, instead of failing as a fixture error
 * and telling nobody anything about the code.
 */
function stageSdk(root: string, prefix: string): void {
  const source = sdkSource(prefix);
  const real = source === undefined ? undefined : newest(realSdks(source), prefix);
  if (source !== undefined && real !== undefined) {
    cloneInto(source, path.join('sdk', real), path.join(root, 'sdk', real));
    return;
  }
  fs.mkdirSync(path.join(root, 'sdk', `${prefix}0.100`), { recursive: true });
}

/** Launch one real staged sidecar on `host`. Returns its exit status. */
function launchStatus(cwd: string, host: string, language: 'CSharp' | 'FSharp'): number | null {
  const dll = path.resolve(__dirname, '../../../bin/all', `SharpLsp.Sidecar.${language}.dll`);
  assert.ok(fs.existsSync(dll), `the staged ${language} sidecar must exist: ${dll}`);
  const run = spawnSync(host, [dll, '--version'], {
    cwd,
    encoding: 'utf8',
    timeout: SETTLE_MS,
    env: { ...process.env, DOTNET_ROOT: path.dirname(host) },
  });
  assert.equal(run.signal, null, `${language} timed out rather than deciding on ${host}`);
  return run.status;
}

/** Whether the root carries an SDK at or above the sidecars' framework. */
function hasSidecarSdk(host: string): boolean {
  return runtimeFloorMet(realSdks(path.dirname(host)), SIDECAR_FRAMEWORK);
}

suite('a root is judged by whether the sidecars actually start on it', () => {
  let scratch: string;
  let source: string;

  setup(function () {
    this.timeout(FIXTURE_BUILD_MS);
    source = realSource();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-runtime-floor-'));
  });

  teardown(() => {
    removeDirRecursive(scratch);
  });

  // [name, SDK prefix on the root, runtime version it advertises].
  const cases: readonly (readonly [string, string, string])[] = [
    ['nine-only', '9.', '9.0.14'],
    ['ten', '10.', '10.0.7'],
    ['prerelease-below-the-floor', '10.', '10.0.0-rc.2'],
    ['prerelease-above-the-floor', '10.', '10.0.99-rc.1'],
    ['next-major-preview', '10.', '11.0.0-preview.1'],
    ['old-sdk-current-runtime', '9.', '10.0.7'],
  ];

  for (const [name, sdkPrefix, runtime] of cases) {
    test(`${name}: the host predicate matches what the sidecars actually do`, async function () {
      this.timeout(FIXTURE_BUILD_MS);
      const host = composeRoot(scratch, source, name, sdkPrefix, runtime);

      // The fixture is only evidence if the root really advertises what was
      // asked for. A composed root that quietly resolved to the machine's own
      // installation would make every assertion below meaningless.
      const advertised = spawnSync(host, ['--list-runtimes'], { encoding: 'utf8' }).stdout;
      assert.ok(
        advertised.includes(`Microsoft.NETCore.App ${runtime}`),
        `the composed root must advertise ${runtime}, got: ${advertised}`,
      );
      assert.ok(
        advertised.includes(path.join(scratch, name)),
        `the composed root must resolve to ITSELF, not the source install: ${advertised}`,
      );

      // THE ORACLE. Not a table — the processes whose startup is being predicted.
      const csharp = launchStatus(scratch, host, 'CSharp');
      const fsharp = launchStatus(scratch, host, 'FSharp');
      assert.equal(
        csharp === 0,
        fsharp === 0,
        `C# and F# target the same framework, so they must agree on ${runtime} ` +
          `(C#=${String(csharp)}, F#=${String(fsharp)})`,
      );
      const starts = csharp === 0;

      // The floor is a claim about STARTING, so it is held to the launch exactly.
      assert.equal(
        runtimeFloorMet([runtime], SIDECAR_FRAMEWORK),
        starts,
        `runtimeFloorMet disagrees with reality on ${runtime}: a floor that does not predict ` +
          'the launch is not a floor',
      );

      // `supportsSidecars` answers a deliberately BROADER question — can this
      // root build as well as run — because the C# sidecar locates MSBuild by
      // enumerating installed SDKs ([DIST-RUNTIME-ACQUIRE] rule 6: the host
      // "MUST carry an SDK >= 10"). So a root that STARTS them on a 9 SDK is
      // still declined, and that is correct. Deriving the expectation from the
      // launch AND the SDK rule keeps both halves honest: neither can be
      // widened without this failing.
      const accepted = await supportsSidecars(host);
      assert.equal(
        accepted,
        starts && hasSidecarSdk(host),
        `supportsSidecars must accept exactly the roots that start the sidecars AND carry a ` +
          `>= ${SIDECAR_FRAMEWORK} SDK — ${runtime} started=${String(starts)}, ` +
          `sdks=${realSdks(path.dirname(host)).join()}, accepted=${String(accepted)}`,
      );

      // The direction that must NEVER regress: accepting a root the sidecars
      // cannot run hands the user a dead language service and no error.
      if (accepted) {
        assert.ok(
          starts,
          `supportsSidecars accepted a root the sidecars exited ${String(csharp)} on — a false ` +
            'positive here is the #297 failure, reintroduced',
        );
      }

      // And the failure mode is the documented one, never a silent non-zero.
      if (!starts) {
        assert.equal(csharp, 150, 'a host that cannot start the sidecars must fail as exit 150');
      }
    });
  }
});

/**
 * [DIST-RUNTIME-ACQUIRE] rule 6, asserted against real roots:
 *
 *   "every selected host, including alternate roots and acquisition results,
 *    MUST carry an SDK >= 10 and report a ... runtime >= 10"
 *   "never success with a .NET 9-only host"
 *
 * and rule 7, "Zero incompatible-SDK fallbacks": when no root answers both
 * questions the selector returns NOTHING, rather than the closest near-miss.
 *
 * Rule 5 — judging the pin against `global.json` — is covered by
 * `sdk-pin.test.ts`. What cannot be covered there is the INTERACTION: a root
 * that satisfies the pin perfectly and still cannot host, which is #297 itself.
 */
suite('[DIST-RUNTIME-ACQUIRE] a selected host answers both questions', () => {
  let scratch: string;
  let nineOnly: string;
  let ten: string;
  let ninePin: SdkPin;
  let tenPin: SdkPin;

  /** An exact, unambiguous pin on whatever SDK that root actually carries. */
  function pinFor(host: string): SdkPin {
    const sdk = realSdks(path.dirname(host))[0];
    assert.ok(sdk, `composed root ${host} must advertise an SDK to pin`);
    return { version: sdk, rollForward: 'disable', source: path.join(scratch, 'global.json') };
  }

  setup(function () {
    this.timeout(FIXTURE_BUILD_MS);
    const source = realSource();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-both-questions-'));
    nineOnly = composeRoot(scratch, source, 'nine-only', '9.', '9.0.14');
    ten = composeRoot(scratch, source, 'ten', '10.', '10.0.7');
    ninePin = pinFor(nineOnly);
    tenPin = pinFor(ten);
  });

  teardown(() => {
    removeDirRecursive(scratch);
  });

  test('a pin satisfied only by a 9-only root selects NOTHING, never that root', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    // The fixture must really be the #297 shape, or this proves nothing: the
    // 9-only root satisfies the pin exactly, and cannot start the sidecars.
    assert.ok(
      pinSatisfiedBy(realSdks(path.dirname(nineOnly)), ninePin),
      'the 9-only root must satisfy its own pin, or this is not the #297 scenario',
    );
    assert.equal(
      launchStatus(scratch, nineOnly, 'CSharp'),
      150,
      'the 9-only root must really refuse the C# sidecar, or there is nothing here to avoid',
    );
    assert.equal(
      launchStatus(scratch, nineOnly, 'FSharp'),
      150,
      'and the F# sidecar too — both are net10.0, so both must be lost together',
    );

    // Rule 6 / rule 7: no root answers both, so the answer is nothing.
    const chosen = await findSidecarSdk(ninePin, [path.dirname(ten), path.dirname(nineOnly)]);
    assert.notEqual(
      chosen,
      nineOnly,
      '#297: a root that satisfies the pin and cannot start either sidecar was selected — ' +
        'this is the regression itself, and it leaves the user with no language services',
    );
    assert.equal(
      chosen,
      undefined,
      'rule 7 forbids an incompatible fallback: with no root answering both questions the ' +
        'selector must return nothing, so acquisition proceeds',
    );
  });

  test('a pin the hosting root satisfies selects it, whatever the probe order', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const roots = [path.dirname(nineOnly), path.dirname(ten)];
    assert.equal(
      await findSidecarSdk(tenPin, roots),
      ten,
      'the root satisfying the pin AND hosting the sidecars must be chosen over one that cannot',
    );
    assert.equal(
      await findSidecarSdk(tenPin, [...roots].reverse()),
      ten,
      'the choice is a property of the roots, not of the order they were probed in',
    );

    // Every selected host must pass BOTH gates — asserted on the result, not
    // assumed because a result came back at all.
    const chosen = await findSidecarSdk(tenPin, roots);
    assert.ok(chosen, 'a satisfying, hosting root exists, so one must be returned');
    assert.ok(
      pinSatisfiedBy(realSdks(path.dirname(chosen)), tenPin),
      'rule 6: the selected host must carry an SDK satisfying the workspace pin',
    );
    assert.ok(
      await supportsSidecars(chosen),
      'rule 6: the selected host must also be able to start the sidecars',
    );
    assert.equal(launchStatus(scratch, chosen, 'CSharp'), 0, 'and the C# sidecar must really run');
    assert.equal(launchStatus(scratch, chosen, 'FSharp'), 0, 'and the F# sidecar must really run');
  });

  test('a pin no installed root satisfies selects nothing, so acquisition proceeds', async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const absent: SdkPin = {
      version: '10.0.999',
      rollForward: 'disable',
      source: path.join(scratch, 'global.json'),
    };
    assert.equal(
      await findSidecarSdk(absent, [path.dirname(ten), path.dirname(nineOnly)]),
      undefined,
      'rule 5: an unsatisfiable pin is "not found", never the nearest installed SDK',
    );
    // Rule 6 from the other side: being able to host is not a licence to ignore
    // the pin. The 10 root starts both sidecars and still must not win here.
    assert.equal(
      await supportsSidecars(ten),
      true,
      'the 10 root really can host — so its rejection above is about the pin, nothing else',
    );
  });
});
