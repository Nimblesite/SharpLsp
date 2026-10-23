import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import Mocha from 'mocha';
import { globSync } from 'glob';
import { splitTrimmed } from '../../utils';
import { pathKey, resolvePath } from '../../paths';
import { DEFAULT_TEST_MS } from './test-timeouts';

/** Every compiled suite — the default when no chunk filter is supplied. */
const ALL_SUITES = '**/*.test.js';

/**
 * Comma-separated globs (relative to the compiled suite directory) selecting
 * which suites run. CI's Windows feature chunks set this so each chunk drives a
 * different slice of the SAME suite ([DIST-CI-WIN-VSIX]); unset runs everything.
 */
function requestedGlobs(): string[] {
  const raw = process.env['MOCHA_FILES']?.trim();
  if (!raw) {
    return [ALL_SUITES];
  }
  return splitTrimmed(raw, ',');
}

/** The directory of the suites that need a MULTI-ROOT workspace. */
const MULTI_ROOT_DIR = 'multiroot';

/**
 * True when `file` belongs to the editor start running now.
 *
 * `.vscode-test.mjs` starts the editor once per workspace SHAPE — the fixture
 * folder, and a two-folder workspace — and names the shape in the environment.
 * Each start runs only its own suites, so a single-folder suite never sees a
 * second folder and a multi-root suite never runs without one.
 */
function matchesShape(file: string): boolean {
  const multiRoot = path.normalize(file).split(path.sep)[0] === MULTI_ROOT_DIR;
  return (process.env['SHARPLSP_WORKSPACE_SHAPE'] === 'multiroot') === multiRoot;
}

/** The slice of `test-chunks.json` the platform guard reads. */
export interface ChunkManifest {
  readonly chunks: Record<
    string,
    {
      readonly files: string[];
      readonly windowsOnly?: boolean;
      readonly linuxOnly?: boolean;
    }
  >;
}

/**
 * Full local runs honor the same platform ownership as CI's feature chunks.
 * Implements [DIST-CI-VSIX-SHARDS] and [NETFX-SCOPE].
 */
function platformExclusions(platform: NodeJS.Platform): ReadonlyMap<string, 'Windows' | 'Linux'> {
  const manifest = resolvePath(__dirname, '..', '..', '..', 'test-chunks.json');
  const { chunks } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as ChunkManifest;
  return new Map(
    Object.values(chunks).flatMap((chunk) => {
      const owner =
        chunk.windowsOnly === true && platform !== 'win32'
          ? 'Windows'
          : chunk.linuxOnly === true && platform !== 'linux'
            ? 'Linux'
            : undefined;
      return owner ? chunk.files.map((file) => [pathKey(file), owner] as const) : [];
    }),
  );
}

/** Preserve a useful failure when every match belongs to another platform. */
function platformReason(matches: readonly string[], excluded: ReadonlyMap<string, string>): string {
  const owners = new Set(matches.map((file) => excluded.get(pathKey(file))));
  if (owners.size > 1) return 'platform-specific suites, which do not share a runnable platform';
  return owners.has('Windows')
    ? 'Windows-only suites, which run on Windows alone ([NETFX-SCOPE])'
    : 'Linux-only suites, which run on Linux alone ([DIST-CI-VSIX-SHARDS])';
}

/** Match real compiled files; an unsupported explicit pattern cannot turn into a zero-test pass. */
function matchingSuites(
  testsRoot: string,
  pattern: string,
  excluded: ReadonlyMap<string, string>,
): string[] {
  const matches = globSync(pattern, { cwd: testsRoot });
  if (matches.length === 0)
    throw new Error(`MOCHA_FILES pattern matched no compiled suite: ${pattern}`);
  const runnable = matches.filter((match) => !excluded.has(pathKey(match)));
  if (runnable.length === 0) {
    throw new Error(
      `MOCHA_FILES pattern selects only ${platformReason(matches, excluded)}: ${pattern}`,
    );
  }
  return runnable;
}

/**
 * A chunk that selects nothing must fail loudly: a mistyped file list would
 * otherwise report a green run that executed zero assertions. So must a pattern
 * that, off Windows, names only Windows-only suites: dropping every one of them
 * would pass a run of nothing.
 */
export function resolveSuiteFiles(
  testsRoot: string,
  globs: readonly string[] = requestedGlobs(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const selected = new Set<string>();
  const excluded = platformExclusions(platform);
  for (const pattern of globs) {
    const runnable = matchingSuites(testsRoot, pattern, excluded);
    for (const match of runnable.filter(matchesShape)) {
      selected.add(match);
    }
  }
  return [...selected].sort();
}

/**
 * Make the test host's temp root CANONICAL before any suite builds a fixture.
 *
 * On the GitHub Windows runner `os.tmpdir()` reports the 8.3 short form
 * `C:\Users\RUNNER~1\AppData\Local\Temp`, while MSBuild, `dotnet` and every path
 * the extension derives from a project it actually built report the long form
 * `C:\Users\runneradmin\...`. Both name the same directory, so a fixture rooted
 * at the short spelling makes every "program must sit under <fixture>" and
 * "must be rooted in the fixture directory" assertion fail on Windows and
 * nowhere else ([DIST-CI-WIN-VSIX]). Case folding cannot repair it: 8.3 is a
 * different SPELLING of the path, not a different case, so `comparablePath`
 * sees two unequal strings for one directory.
 *
 * Correcting the environment once, here, is what keeps it corrected:
 * `os.tmpdir()` re-reads these variables on every call, so every suite, kit and
 * spawned `dotnet` child agrees on one spelling — instead of ~25 fixture roots
 * each having to remember to canonicalise themselves.
 */
function canonicaliseTempRoot(): void {
  const canonical = fs.realpathSync.native(os.tmpdir());
  for (const variable of ['TMPDIR', 'TEMP', 'TMP']) {
    process.env[variable] = canonical;
  }
}

export function run(): Promise<void> {
  canonicaliseTempRoot();
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    // The ceiling a suite inherits when it declares none. Every deliberate
    // ceiling names a tier from ./test-timeouts; this is the floor under the
    // ones that never said ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    timeout: parseInt(process.env['MOCHA_TIMEOUT'] ?? String(DEFAULT_TEST_MS), 10),
    // Opt-in test filter for local debugging; CI leaves it unset (runs all).
    ...(process.env['MOCHA_GREP'] ? { grep: process.env['MOCHA_GREP'] } : {}),
  });

  const testsRoot = path.resolve(__dirname);

  for (const file of resolveSuiteFiles(testsRoot)) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}
