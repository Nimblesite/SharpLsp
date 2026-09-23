import * as assert from 'node:assert/strict';
import {
  type SdkPin,
  parseSdkVersion,
  pinSatisfiedBy,
  runtimeFloorMet,
  sdkSatisfiesPin,
} from '../../global-json.js';

/**
 * Where a prerelease sits, asked of both halves of the SDK question.
 *
 * `parseSdkVersion` deliberately DISCARDS the prerelease suffix, because SDK
 * feature-band arithmetic needs it gone. Everything built on it therefore
 * reads `10.0.0-rc.2` as `10.0.0` and ties them - correct for bands, wrong for
 * ordering. The runtime floor and the pin each got that wrong in turn, and the
 * costs differ: a wrong floor starts no sidecar (exit 150), a wrong pin picks
 * a host every `dotnet` command rejects (exit 155).
 *
 * These are pure predicate tests over real version strings, so they carry no
 * fixture. The LAUNCHES that measured the floor answers quoted below live in
 * `sdk-runtime-floor.test.ts`. Implements [DIST-RUNTIME-ACQUIRE].
 */
suite('prerelease ordering decides both the floor and the pin', () => {
  test('a prerelease runtime sits below its own release, so the floor rejects it', () => {
    // #297. The sidecars are framework-dependent net10.0 apps: they need a
    // RUNTIME at or above 10.0.0, which is a different question from the SDK
    // pin and is answered by a different directory. Every naive floor check
    // gets it wrong the same way, because `parseSdkVersion` strips the
    // prerelease suffix — correct for SDK band arithmetic, and blind here.
    assert.deepEqual(
      parseSdkVersion('10.0.0-rc.2'),
      parseSdkVersion('10.0.0'),
      'parseSdkVersion cannot tell a prerelease from its release, so a floor built on it alone ' +
        'accepts a runtime that cannot start either sidecar',
    );

    // Every case below was measured against the real staged sidecar DLL on a
    // composed root carrying exactly one Microsoft.NETCore.App directory.
    assert.equal(
      runtimeFloorMet(['10.0.0-rc.2'], '10.0.0'),
      false,
      'measured: a 10.0.0-rc.2-only root exits 150 — a prerelease is below its own release',
    );
    assert.equal(
      runtimeFloorMet(['9.0.14'], '10.0.0'),
      false,
      'measured: a 9-only root exits 150, which is issue #297 itself',
    );
    assert.equal(runtimeFloorMet(['10.0.7'], '10.0.0'), true, 'measured: starts both sidecars');
    assert.equal(
      runtimeFloorMet(['10.0.99-rc.1'], '10.0.0'),
      true,
      'measured: a prerelease ABOVE the floor starts them — the rule is ordering, not a "-" test',
    );
    assert.equal(
      runtimeFloorMet(['11.0.0-preview.1'], '10.0.0'),
      true,
      'measured: RollForward=LatestMajor makes the floor upward-open, so 11.x hosts them',
    );

    // Build metadata is NOT a prerelease. Semver gives `+…` no precedence at
    // all, hostfxr's own parser accepts it, and a source-built or locally
    // patched runtime lands in a directory carrying it. Measured on a composed
    // root advertising exactly `10.0.99+x1`: `dotnet --list-runtimes` reports
    // it and the real C# sidecar exits 0. A floor that rejects it discards a
    // host that demonstrably works, which is #297's harm with the sign flipped.
    assert.equal(
      runtimeFloorMet(['10.0.99+x1'], '10.0.0'),
      true,
      'measured: a 10.0.99+x1-only root STARTS the sidecars, so the floor must accept it',
    );
    assert.equal(
      runtimeFloorMet(['10.0.0+x1'], '10.0.0'),
      true,
      'build metadata carries no precedence: 10.0.0+x1 IS the release 10.0.0, not below it',
    );
    assert.equal(
      runtimeFloorMet(['10.0.0+build-5'], '10.0.0'),
      true,
      'build metadata may itself contain "-", so the prerelease test must run after it is cut',
    );
    assert.equal(
      runtimeFloorMet(['10.0.0-rc.1+sha.abc'], '10.0.0'),
      false,
      'a prerelease stays below its release however much build metadata follows it',
    );
    assert.equal(
      runtimeFloorMet(['9.0.14+x1'], '10.0.0'),
      false,
      'stripping build metadata must not promote a 9.x runtime over the floor',
    );
    assert.deepEqual(
      parseSdkVersion('10.0.99+x1'),
      parseSdkVersion('10.0.99'),
      'build metadata must parse away entirely rather than turning the patch into NaN',
    );
    assert.equal(
      parseSdkVersion('10.0.0+x1') === undefined,
      false,
      'a version hostfxr accepts must never be read as malformed',
    );

    // A root is judged on its best runtime, not its first or its worst.
    assert.equal(
      runtimeFloorMet(['9.0.14', '10.0.7'], '10.0.0'),
      true,
      'the two-root macOS machine: 9 and 10 side by side still hosts the sidecars',
    );
    assert.equal(
      runtimeFloorMet(['9.0.14', '10.0.0-rc.2'], '10.0.0'),
      false,
      'neither a 9 nor a below-floor prerelease can host them, so the root cannot',
    );
    assert.equal(runtimeFloorMet([], '10.0.0'), false, 'a root with no runtime hosts nothing');
    assert.equal(
      runtimeFloorMet(['not.a.version'], '10.0.0'),
      false,
      'an unreadable runtime directory is not evidence of capability',
    );
  });

  test('a RELEASE pin is not satisfied by a prerelease of that same version', () => {
    // #297 follow-up. `runtimeFloorMet` learned that a prerelease sorts BELOW
    // its own release; `sdkSatisfiesPin` never did, and it decides which root
    // this PR's selector commits to — `findSidecarSdk`, `validateAcquiredPin`
    // and `tryFindExistingSdk` all gate on it. `compare()` is built from
    // `parseSdkVersion`, which strips the suffix, so `10.0.100-rc.1` ties with
    // `10.0.100` and clears a `>=` test it sits below.
    //
    // The cost is not cosmetic: the SDK resolver disagrees, so every `dotnet`
    // command on the host we chose fails the pin with exit 155.
    const gaPin = (rollForward: SdkPin['rollForward']): SdkPin => ({
      version: '10.0.100',
      rollForward,
      source: '/ws/global.json',
    });

    for (const rollForward of [
      'latestPatch',
      'latestFeature',
      'latestMinor',
      'latestMajor',
    ] as const) {
      assert.equal(
        sdkSatisfiesPin('10.0.100-rc.1', gaPin(rollForward)),
        false,
        `${rollForward}: rc.1 sorts below the 10.0.100 it pins, so it can never satisfy it — ` +
          'selecting that root hands every build exit 155',
      );
    }
    assert.equal(
      sdkSatisfiesPin('10.0.100-rc.1+x1', gaPin('latestPatch')),
      false,
      'build metadata carries no precedence, so it cannot lift a prerelease onto its release',
    );
    assert.equal(
      pinSatisfiedBy(['10.0.100-rc.1'], gaPin('latestPatch')),
      false,
      'and a root carrying only that prerelease does not satisfy the pin either',
    );

    // The rule is ORDERING, not a "-" test: everything genuinely at or above
    // the pin must still pass, or this trades one wrong answer for another.
    assert.equal(sdkSatisfiesPin('10.0.100', gaPin('latestPatch')), true, 'the release itself');
    assert.equal(sdkSatisfiesPin('10.0.107', gaPin('latestPatch')), true, 'a later patch');
    assert.equal(sdkSatisfiesPin('10.0.303', gaPin('latestFeature')), true, 'a later band');
    assert.equal(
      sdkSatisfiesPin('10.0.303-rc.1', gaPin('latestFeature')),
      true,
      'a prerelease of a LATER band is still above the pin — only the tie was ever wrong',
    );
    assert.equal(
      sdkSatisfiesPin('10.0.100', { ...gaPin('latestPatch'), version: '10.0.100-rc.1' }),
      true,
      'and the release satisfies a pin on its own prerelease, which is the same rule inverted',
    );
    assert.equal(
      sdkSatisfiesPin('10.0.100-rc.1', { ...gaPin('disable'), version: '10.0.100-rc.1' }),
      true,
      'rollForward=disable stays an exact string match, prerelease or not',
    );
  });

  test('at equal numbers, prereleases are ordered against each other', () => {
    // Pinning a prerelease is an RC-era reality: `10.0.100-rc.2` with
    // latestPatch means "rc.2 or later". `compare` reads only
    // major/minor/band/patch, so every rc of one version tied and an EARLIER
    // one satisfied a pin on a later one — and the host picked that way fails
    // the pin with 155 on every `dotnet` command.
    const pin = (version: string): SdkPin => ({
      version,
      rollForward: 'latestPatch',
      source: '/ws/global.json',
    });
    // [lower, higher] under semver: numeric identifiers compare numerically,
    // alphanumerics by ASCII, and a shorter identifier list sorts below a
    // longer one whose leading identifiers match.
    const ordered: readonly (readonly [string, string])[] = [
      ['10.0.100-rc.1', '10.0.100-rc.2'],
      ['10.0.100-alpha', '10.0.100-beta'],
      ['10.0.100-rc.2', '10.0.100-rc.10'],
      ['10.0.100-rc', '10.0.100-rc.1'],
    ];
    for (const [lower, higher] of ordered) {
      assert.equal(
        sdkSatisfiesPin(lower, pin(higher)),
        false,
        `${lower} sorts below ${higher}, so it cannot satisfy a pin on it`,
      );
      assert.equal(
        sdkSatisfiesPin(higher, pin(lower)),
        true,
        `and ${higher} is above ${lower}, so it must satisfy a pin on it`,
      );
    }
    assert.equal(
      sdkSatisfiesPin('10.0.100-rc.2', pin('10.0.100-rc.2')),
      true,
      'a prerelease satisfies a pin on itself',
    );
    assert.equal(
      sdkSatisfiesPin('10.0.100-rc.2+x1', pin('10.0.100-rc.2')),
      true,
      'build metadata carries no precedence between prereleases either',
    );
  });
});
