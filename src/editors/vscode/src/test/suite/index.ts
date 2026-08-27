import * as path from 'node:path';
import Mocha from 'mocha';
import { globSync } from 'glob';

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

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: parseInt(process.env['MOCHA_TIMEOUT'] ?? '60000', 10),
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
