import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import Mocha from 'mocha';
import { globSync } from 'glob';
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
  return raw
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

/**
 * A chunk that selects nothing must fail loudly: a mistyped file list would
 * otherwise report a green run that executed zero assertions.
 */
function resolveSuiteFiles(testsRoot: string): string[] {
  const selected = new Set<string>();
  for (const pattern of requestedGlobs()) {
    const matches = globSync(pattern, { cwd: testsRoot });
    if (matches.length === 0) {
      throw new Error(`MOCHA_FILES pattern matched no compiled suite: ${pattern}`);
    }
    for (const match of matches) {
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
