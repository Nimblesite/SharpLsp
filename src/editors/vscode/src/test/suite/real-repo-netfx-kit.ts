// The [NETFX-CORPUS]: real repositories whose projects target SEVERAL .NET
// Framework versions AND SEVERAL .NET Standard versions (plus modern .NET),
// pinned to COMMITS rather than tags. Each one was checked at its commit: the
// declared frameworks below are read off its project files, and the whole
// solution builds with the current SDK.
//
// A pinned commit cannot be cloned with `--branch`, so it is fetched by id into
// an empty repository and checked out detached. Everything after that —
// `global.json` removal, the audit-free restore, the solution load and the
// semantic warm-up — is the shared real-repo lifecycle, reused unchanged.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SharpLspExtensionApi } from '../../extension.js';
import { installedNetCoreTargets } from './dotnet-project-kit';
import {
  assertClassRunPasses,
  assertTaggedFor,
  type ClassRun,
  classRowOf,
  discoverOnce,
  runnableOf,
} from './netfx-test-kit';
import { realWorldFixturesRoot, type RealRepoSpec } from './real-repo-helpers';
import { type Anchor, useRealRepo } from './real-repo-kit';
import { activateTestExplorer, clearTestTree, rootsOf } from './test-explorer-kit';
import { removeDirRecursive } from './test-helpers';
import { DOTNET_CLI_MS, REAL_REPO_MS } from './test-timeouts';

/** A real repository pinned to one commit. */
export interface PinnedRepoSpec extends RealRepoSpec {
  /** The full commit id the clone is checked out at. */
  readonly commit: string;
}

/**
 * A spec pinned to `commit`. The shared restore step records the pin it
 * restored under `tag`, so a commit-pinned clone records its commit there.
 */
function pinned(spec: Omit<PinnedRepoSpec, 'tag'>): PinnedRepoSpec {
  return { ...spec, tag: spec.commit };
}

/**
 * F# AND C#, NUnit. `FSharp.GitReader` targets net461, net462, net48, net481,
 * netstandard2.0 and netstandard2.1 plus eleven .NET versions; its C# core adds
 * net35, net40, net45 and netstandard1.6. Both test projects target net48 and
 * three .NET versions.
 */
export const GITREADER: PinnedRepoSpec = pinned({
  name: 'netfx-gitreader',
  url: 'https://github.com/kekyo/GitReader',
  commit: '079ea8530fafde82731e5a8cb8fd2989e2bdb0a2',
  sln: 'GitReader.sln',
});

/**
 * C#, xUnit 2. `CsvHelper` targets net462, net47, net48, netstandard2.0,
 * netstandard2.1, net8.0 and net9.0; its tests target all three .NET Framework
 * versions plus net8.0 and net9.0.
 */
export const CSVHELPER: PinnedRepoSpec = pinned({
  name: 'netfx-csvhelper',
  url: 'https://github.com/JoshClose/CsvHelper',
  commit: '33970e5183383bdac1fbce3b3fbcdf46b318ca52',
  sln: 'CsvHelper.sln',
});

/**
 * C#, xUnit 2. `NLog` targets net35, net46, netstandard2.0 and netstandard2.1;
 * its unit tests target net462 and, under the .NET 10 SDK, net10.0.
 */
export const NLOG: PinnedRepoSpec = pinned({
  name: 'netfx-nlog',
  url: 'https://github.com/NLog/NLog',
  commit: '73c79454015b193b1ee836153d7a82d42500fc5d',
  sln: 'src/NLog.sln',
});

/** Run one git step in the clone, its output streamed to the test log. */
function git(args: readonly string[], cwd: string): void {
  execFileSync('git', [...args], { cwd, stdio: 'inherit', timeout: REAL_REPO_MS });
}

/** Fetch exactly `spec.commit` into a fresh repository and check it out, once. */
function checkOutPinned(spec: PinnedRepoSpec): void {
  const repoDir = path.join(realWorldFixturesRoot(), spec.name);
  if (fs.existsSync(path.join(repoDir, spec.sln))) return;
  removeDirRecursive(repoDir);
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init', '--quiet'], repoDir);
  git(['fetch', '--quiet', '--depth', '1', spec.url, spec.commit], repoDir);
  git(['checkout', '--quiet', 'FETCH_HEAD'], repoDir);
}

/**
 * Check `spec` out at its pinned commit, then hand over to the shared real-repo
 * lifecycle: restore, load through the real extension, and wait until `file`
 * answers SEMANTIC hover at `anchor`. Returns the clone directory's accessor.
 */
export function usePinnedRepo(spec: PinnedRepoSpec, file: string, anchor: Anchor): () => string {
  suiteSetup(function () {
    this.timeout(REAL_REPO_MS);
    checkOutPinned(spec);
  });
  return useRealRepo(spec, file, anchor);
}

/** A corpus suite's whole lifecycle, held once for all of its tests. */
export interface Corpus {
  readonly repoDir: () => string;
  readonly api: () => SharpLspExtensionApi;
  /** The `netN.0` runtimes this agent has. */
  readonly installed: () => readonly string[];
  /** Discover the solution once; fails when any expected id is missing. */
  readonly discovered: () => Promise<void>;
  /** ▶ on the class of `anyTest`: all `count` tests pass; unrunnable frameworks are logged. */
  readonly runClass: (run: CorpusClassRun) => Promise<void>;
}

/**
 * A class to run in a corpus suite, and the frameworks EVERY test in it is
 * tagged for — by default, every declared framework this agent can run.
 */
export interface CorpusClassRun extends Omit<ClassRun, 'installed'> {
  readonly tagged?: readonly string[];
}

/** The Test Explorer and this agent's runtimes, read once; the tree is cleared after. */
function useExplorer(repoDir: () => string): Pick<Corpus, 'api' | 'installed'> {
  let api: SharpLspExtensionApi | undefined;
  let installed: string[] | undefined;
  suiteSetup(async function () {
    this.timeout(DOTNET_CLI_MS);
    api = await activateTestExplorer();
    installed = await installedNetCoreTargets(repoDir());
  });
  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    if (api !== undefined) await clearTestTree(api);
  });
  return {
    api: () => {
      assert.ok(api, 'the Test Explorer is activated in suiteSetup');
      return api;
    },
    installed: () => {
      assert.ok(installed, "this agent's runtimes are read in suiteSetup");
      return installed;
    },
  };
}

/**
 * Everything a corpus suite needs: the pinned repo loaded through the real
 * extension, the Test Explorer, this agent's runtimes, one discovery of the
 * solution expecting `expected`, and class runs against it.
 */
export function useCorpus(
  spec: PinnedRepoSpec,
  file: string,
  anchor: Anchor,
  expected: readonly string[],
): Corpus {
  const repoDir = usePinnedRepo(spec, file, anchor);
  const { api, installed } = useExplorer(repoDir);
  const discovered = discoverOnce(api, () => path.join(repoDir(), spec.sln), expected);
  const runClass = async (run: CorpusClassRun): Promise<void> => {
    await discovered();
    await assertClassRunPasses(api(), { ...run, installed: installed() });
    const tagged = run.tagged ?? runnableOf(run.declared, installed());
    for (const test of rootsOf(classRowOf(api(), run.anyTest).children)) {
      assertTaggedFor(test, tagged);
    }
  };
  return { repoDir, api, installed, discovered, runClass };
}
