/**
 * Assertion and fixture helpers for the SDK-pin suites: the pinned-workspace
 * fixture every `global.json` test composes, plus one-assertion wrappers that
 * keep the predicate tables in `sdk-pin*.test.ts` readable.
 *
 * Implements [DIST-RUNTIME-ACQUIRE] / [DIST-SDK-DISCOVERY].
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type SdkPin,
  pinSatisfiedBy,
  runtimeFloorMet,
  sdkSatisfiesPin,
} from '../../global-json.js';
import { findDotnetSatisfying } from '../../dotnet-roots.js';

/** The `global.json` contents pinning `version` under `rollForward`. */
export function pinJson(version: string, rollForward: string): string {
  return JSON.stringify({ sdk: { version, rollForward } });
}

/** Create `root/name/global.json` pinning `version` under `rollForward`; return the directory. */
export function pinnedWorkspace(
  root: string,
  name: string,
  version: string,
  rollForward: string,
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'global.json'), pinJson(version, rollForward));
  return dir;
}

/** Assert a runtime set meets `floor` (`runtimeFloorMet`), with `why` on failure. */
export function assertFloorMet(
  runtimes: readonly string[],
  floor: string,
  expected: boolean,
  why: string,
): void {
  assert.equal(runtimeFloorMet(runtimes, floor), expected, why);
}

/** Assert `sdk` satisfies `pin` (`sdkSatisfiesPin`), with `why` on failure. */
export function assertSdkSatisfies(sdk: string, pin: SdkPin, expected: boolean, why: string): void {
  assert.equal(sdkSatisfiesPin(sdk, pin), expected, why);
}

/** Assert the installed `sdks` satisfy `pin` (`pinSatisfiedBy`), with `why` on failure. */
export function assertPinSatisfiedBy(
  sdks: readonly string[],
  pin: SdkPin,
  expected: boolean,
  why: string,
): void {
  assert.equal(pinSatisfiedBy(sdks, pin), expected, why);
}

/** Assert `findDotnetSatisfying` over `roots` resolves to `expected`, with `why` on failure. */
export function assertDotnetRootFor(
  target: SdkPin,
  roots: readonly string[],
  expected: string | undefined,
  why: string,
): void {
  assert.equal(findDotnetSatisfying(target, roots), expected, why);
}
