import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type SdkPin, pinSatisfiedBy, runtimeFloorMet } from '../../global-json.js';
import { findSidecarSdk, supportsSidecars } from '../../dotnet-host.js';
import {
  FRAMEWORK_MISSING_EXIT,
  FRAMEWORK_MISSING_MESSAGE,
  type Language,
  composeRoot,
  describeRun,
  installMuxer,
  launchSidecar,
  replaceMuxer,
  realSdks,
  realRuntimes,
  realSource,
  runHost,
} from './sdk-host-kit.js';
import { removeDirRecursive, assertContainsAll } from './test-helpers.js';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts.js';

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
 * Composing a root links a real SDK and copies a real runtime, which costs
 * seconds on an agent without reflinks, so every root is composed ONCE in
 * `suiteSetup` and the test bodies only launch processes against them
 * ([DIST-CI-VSIX-SHARDS-TIMEOUTS]: a suite pays one initialization).
 *
 * Implements [DIST-RUNTIME-ACQUIRE].
 */

/** The floor the sidecars' `runtimeconfig.json` asks hostfxr for. */
const SIDECAR_FRAMEWORK = '10.0.0';

/** [name, SDK major on the root, runtime version it advertises]. */
const CASES: readonly (readonly [string, number, string])[] = [
  ['nine-only', 9, '9.0.14'],
  ['ten', 10, '10.0.7'],
  ['prerelease-below-the-floor', 10, '10.0.0-rc.2'],
  ['prerelease-above-the-floor', 10, '10.0.99-rc.1'],
  ['next-major-preview', 10, '11.0.0-preview.1'],
  ['old-sdk-current-runtime', 9, '10.0.7'],
  ['build-metadata', 10, '10.0.99+x1'],
];

/** Launch one real staged sidecar, failing with everything the host said. */
function launchStatus(cwd: string, host: string, language: Language): number | null {
  const run = launchSidecar(host, cwd, language);
  assert.equal(
    run.signal,
    null,
    describeRun(`${language} timed out rather than deciding on ${host}`, run),
  );
  return run.status;
}

/**
 * A root that cannot host must say so as hostfxr's own framework-missing
 * failure, and print the message the extension reads — never a silent
 * non-zero the caller cannot tell from a crash.
 */
function assertFrameworkMissing(cwd: string, host: string, language: Language): void {
  const run = launchSidecar(host, cwd, language);
  assert.equal(
    run.status,
    FRAMEWORK_MISSING_EXIT,
    describeRun(`${language} must refuse ${host} as a missing framework`, run),
  );
  assert.ok(
    run.stderr.includes(FRAMEWORK_MISSING_MESSAGE),
    describeRun(`${language} must name the missing runtime on stderr`, run),
  );
}

/** Whether the root carries an SDK at or above the sidecars' framework. */
function hasSidecarSdk(host: string): boolean {
  return runtimeFloorMet(realSdks(path.dirname(host)), SIDECAR_FRAMEWORK);
}

suite('a root is judged by whether the sidecars actually start on it', () => {
  let scratch: string;
  const hosts = new Map<string, string>();

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const source = realSource();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-runtime-floor-'));
    const composed = CASES.map(async ([name, sdkMajor, runtime]) => {
      hosts.set(name, await composeRoot(scratch, source, name, sdkMajor, runtime));
    });
    await Promise.all(composed);
  });

  suiteTeardown(() => {
    removeDirRecursive(scratch);
  });

  for (const [name, , runtime] of CASES) {
    test(`${name}: the host predicate matches what the sidecars actually do`, async function () {
      this.timeout(DOTNET_CLI_MS);
      const host = hosts.get(name);
      assert.ok(host, `${name} must have been composed in suiteSetup`);

      // The fixture is only evidence if the root really advertises what was
      // asked for. A composed root that quietly resolved to the machine's own
      // installation would make every assertion below meaningless.
      const listed = runHost(host, scratch, ['--list-runtimes']);
      const advertised = listed.stdout;
      assertContainsAll(
        advertised,
        [`Microsoft.NETCore.App ${runtime}`, path.join(scratch, name)],
        'advertised',
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
      if (!starts) assertFrameworkMissing(scratch, host, 'CSharp');
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

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const source = realSource();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-both-questions-'));
    [nineOnly, ten] = await Promise.all([
      composeRoot(scratch, source, 'nine-only', 9, '9.0.14'),
      composeRoot(scratch, source, 'ten', 10, '10.0.7'),
    ]);
    ninePin = pinFor(nineOnly);
    tenPin = pinFor(ten);
  });

  suiteTeardown(() => {
    removeDirRecursive(scratch);
  });

  test('a pin satisfied only by a 9-only root selects NOTHING, never that root', async function () {
    this.timeout(DOTNET_CLI_MS);
    // The fixture must really be the #297 shape, or this proves nothing: the
    // 9-only root satisfies the pin exactly, and cannot start the sidecars.
    assert.ok(
      pinSatisfiedBy(realSdks(path.dirname(nineOnly)), ninePin),
      'the 9-only root must satisfy its own pin, or this is not the #297 scenario',
    );
    assertFrameworkMissing(scratch, nineOnly, 'CSharp');
    // And the F# sidecar too — both are net10.0, so both must be lost together.
    assertFrameworkMissing(scratch, nineOnly, 'FSharp');

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
    this.timeout(DOTNET_CLI_MS);
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
    this.timeout(DOTNET_CLI_MS);
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

/**
 * What a probe that cannot answer costs, measured rather than assumed.
 *
 * `supportsSidecars` decides by SPAWNING `dotnet --list-runtimes`, so it has a
 * failure mode the predicate alone does not: the root is fine and the question
 * goes unanswered — a corrupt or half-written install, a locked-down or
 * virus-scanned muxer, a stalled network share. It then returns false and the
 * root is discarded, which on the last candidate turns into an SDK download
 * the machine did not need.
 *
 * That is deliberately fail-closed: an unanswered question is not a yes, and
 * shipping a host that cannot start the sidecars is the #297 regression itself.
 * These tests hold that contract to its two real costs — a healthy root thrown
 * away, and the wall-clock a hung probe adds to `activate()` — so neither can
 * change without a test saying so. Implements [DIST-RUNTIME-ACQUIRE] rule 6,
 * "a successful, bounded `dotnet --list-runtimes` probe".
 *
 * Each test BREAKS the muxer, so `setup` restores it from the source install.
 * That is one small file; the root itself is composed once, like every other.
 */
suite('[DIST-RUNTIME-ACQUIRE] a probe that cannot answer discards the root', () => {
  /** The bound `supportsSidecars` puts on one probe. */
  const PROBE_TIMEOUT_MS = 10_000;
  let scratch: string;
  let source: string;
  let ten: string;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    source = realSource();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-probe-fails-'));
    ten = await composeRoot(scratch, source, 'ten', 10, '10.0.7');
  });

  setup(() => {
    installMuxer(source, path.dirname(ten));
  });

  suiteTeardown(() => {
    removeDirRecursive(scratch);
  });

  /** Prove the root is genuinely good, so a later rejection is about the probe alone. */
  function assertHealthy(): void {
    assert.equal(launchStatus(scratch, ten, 'CSharp'), 0, 'the fixture root must really host C#');
    assert.equal(launchStatus(scratch, ten, 'FSharp'), 0, 'the fixture root must really host F#');
  }

  test('a root that really hosts both sidecars is discarded when its probe errors', async function () {
    this.timeout(DOTNET_CLI_MS);
    assertHealthy();
    assert.equal(await supportsSidecars(ten), true, 'the intact root must be accepted');

    // A real executable that is not the muxer: it exits non-zero on
    // `--list-runtimes` exactly as a broken install does, with no stub
    // anywhere near the code under test.
    replaceMuxer(ten, process.execPath);
    const broken = runHost(ten, scratch, ['--list-runtimes']);
    assert.notEqual(
      broken.status,
      0,
      describeRun(
        'the fixture must really fail the probe, or the rejection below is empty',
        broken,
      ),
    );
    assert.equal(
      await supportsSidecars(ten),
      false,
      'an unanswered question is not a yes: fail closed rather than ship a host that may not start',
    );
    assert.ok(
      realRuntimes(path.dirname(ten)).includes('10.0.7'),
      'and the root still carries the runtime it was rejected over — the loss is real',
    );
  });

  test('a probe that never answers cannot stall activation past its own bound', async function () {
    this.timeout(DOTNET_CLI_MS);
    if (process.platform === 'win32') {
      // The fixture is a muxer that hangs; on Windows that must be a real
      // `dotnet.exe`, which cannot be written from here. The bound itself is
      // `execFile`'s, not ours, and is exercised on every other platform.
      this.skip();
    }
    assertHealthy();
    fs.rmSync(ten, { force: true });
    fs.writeFileSync(ten, '#!/bin/sh\nsleep 600\n', { mode: 0o755 });

    const started = Date.now();
    const answer = await supportsSidecars(ten);
    const elapsed = Date.now() - started;

    assert.equal(answer, false, 'a probe that never answers cannot be read as a yes');
    assert.ok(
      elapsed >= PROBE_TIMEOUT_MS / 2,
      `the probe must really have hung and been killed, not failed early (${String(elapsed)}ms)`,
    );
    assert.ok(
      elapsed < PROBE_TIMEOUT_MS * 2,
      `one hung root costs ~${String(PROBE_TIMEOUT_MS)}ms of activate(), not forever ` +
        `(${String(elapsed)}ms). Every candidate root pays this in the worst case.`,
    );
  });
});
