import * as path from 'node:path';
import Mocha from 'mocha';
import { globSync } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: parseInt(process.env['MOCHA_TIMEOUT'] ?? '60000', 10),
    // Opt-in test filter for local debugging; CI leaves it unset (runs all).
    ...(process.env['MOCHA_GREP'] ? { grep: process.env['MOCHA_GREP'] } : {}),
  });

  const testsRoot = path.resolve(__dirname);
  const files = globSync('**/*.test.js', { cwd: testsRoot });

  for (const file of files) {
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
