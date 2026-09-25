// The suite lifecycle of the Test Explorer run-profile suites, in one place.
//
// Each builds ONE fixture solution for the whole suite and pays restore, build
// and adapter JIT once, so every run it then presses measures a WARM
// `dotnet test` rather than a cold restore. Teardown order is the contract:
// never touch the fixture while a `dotnet` invocation is still in flight, and
// drain reactive discovery before the solution is deleted
// ([TEST-REACTIVITY], [DIST-CI-VSIX-SHARDS-TIMEOUTS]).
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import type { SharpLspExtensionApi } from '../../extension.js';
import { createSolution, warmDiscovery } from './dotnet-project-kit';
import { COVERAGE_DIR_NAME } from './test-coverage-fixtures';
import {
  activateWithScratch,
  drainDiscovery,
  pollUntilDiscovered,
  teardownFixtureSolution,
} from './test-explorer-kit';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, FIXTURE_BUILD_MS } from './test-timeouts';

/** A fixture solution, built and discovered once for its suite. */
export interface WarmFixture {
  readonly api: SharpLspExtensionApi;
  readonly root: string;
  readonly slnPath: string;
  /** Where the Coverage profile drops TRX + Cobertura, next to the solution. */
  readonly coverageDir: string;
}

/**
 * Pay restore, build and adapter JIT for `slnPath` once, load it, and wait for
 * `expected` to be discovered in the SETTLED tree: a solution load also
 * schedules a DEBOUNCED sweep, which has to land first.
 */
export async function warmAndDiscover(
  api: SharpLspExtensionApi,
  slnPath: string,
  root: string,
  expected: readonly string[],
): Promise<void> {
  await warmDiscovery(slnPath, root);
  await api.explorerProvider.loadSolution(slnPath);
  await api.testController.activateAndDiscover();
  await drainDiscovery(() => undefined, api.testController);
  await pollUntilDiscovered(api.testController, expected);
}

/**
 * Build solution `name` from the projects `write` lays down under a fresh
 * scratch root (`prefix`) and discover `expected`, once for the suite. After
 * each test the coverage directory is cleared — once the controller is idle —
 * and the suite ends with `teardownFixtureSolution`.
 */
export function useWarmFixture(
  prefix: string,
  name: string,
  write: (root: string) => string[],
  expected: readonly string[],
): () => WarmFixture {
  let fixture: WarmFixture | undefined;
  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    const { api, root } = await activateWithScratch(prefix);
    const slnPath = await createSolution(root, name, write(root));
    fixture = { api, root, slnPath, coverageDir: path.join(root, COVERAGE_DIR_NAME) };
    await warmAndDiscover(api, slnPath, root, expected);
  });
  teardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    if (fixture === undefined) return;
    await fixture.api.testController.whenIdle();
    removeDirRecursive(fixture.coverageDir);
  });
  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    if (fixture !== undefined)
      await teardownFixtureSolution(fixture.api, fixture.root, removeDirRecursive);
  });
  return () => {
    assert.ok(fixture, 'the fixture solution must be built in suiteSetup');
    return fixture;
  };
}
