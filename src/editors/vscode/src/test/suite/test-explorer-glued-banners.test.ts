// A solution's VSTest passes share ONE stdout and write to it unsynchronised,
// so a `Test run for <dll> (<framework>)` banner can arrive glued to another
// pass's text on either side. A real six-project listing printed
// `The following Tests are available:The following Tests are available:…` on
// one line. A banner glued AFTER other text was never read, and its whole
// project left the Test Explorer without a word (Linux CI, #529: five of six
// framework fixtures). One glued BEFORE other text lost its framework, which is
// how a multi-targeted project lost a build (#532).
// Implements [TEST-DISCOVERY-FQN] and [NETFX-TEST-DISCOVERY].
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseAnnouncedAssemblies,
  parseAnnouncedFrameworks,
  parseTestAssemblies,
} from '../../test-discovery.js';

const NET10 = '(.NETCoreApp,Version=v10.0)';
const NET8 = '(.NETCoreApp,Version=v8.0)';
const NET48 = '(.NETFramework,Version=v4.8)';
const NET47 = '(.NETFramework,Version=v4.7)';
const HEADER = 'The following Tests are available:';

suite('Test Explorer — banners glued by parallel VSTest passes [TEST-DISCOVERY-FQN]', () => {
  let root = '';
  const dll = (name: string): string => path.join(root, name, 'bin', 'Debug', `${name}.dll`);

  suiteSetup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-glued-'));
    for (const name of ['A', 'B', 'C', 'D', 'E', 'My (copy) F']) {
      fs.mkdirSync(path.dirname(dll(name)), { recursive: true });
      fs.writeFileSync(dll(name), '');
    }
  });

  suiteTeardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('every banner is announced, whatever another pass glued to either side of it', () => {
    const listing = [
      `Test run for ${dll('A')} ${NET10}`,
      `${HEADER}Test run for ${dll('B')} ${NET10}`,
      `Test run for ${dll('C')} ${NET48}Test run for ${dll('D')} ${NET8}`,
      `Test run for ${dll('E')} ${NET47}${HEADER}${HEADER}`,
      HEADER,
      '    A.UnitTest1.Test1',
    ].join('\n');
    const all = ['A', 'B', 'C', 'D', 'E'].map(dll);
    assert.deepStrictEqual(parseAnnouncedAssemblies(listing), all, 'all five, in banner order');
    assert.deepStrictEqual(parseTestAssemblies(listing), all, 'and all five are on disk');
    assert.deepStrictEqual(
      Object.fromEntries(parseAnnouncedFrameworks(listing)),
      {
        [dll('A')]: 'net10.0',
        [dll('B')]: 'net10.0',
        [dll('C')]: 'net48',
        [dll('D')]: 'net8.0',
        [dll('E')]: 'net47',
      },
      'each keeps the framework its own banner named, glue or no glue',
    );
  });

  test('a path with spaces and parentheses survives glue, and a parenthesised name after it does not move it', () => {
    const banner = `Test run for ${dll('My (copy) F')} ${NET10}`;
    const listing = `${HEADER}${banner}    Ns.Calc.Adds_Case (2)\r\n`;
    assert.deepStrictEqual(parseAnnouncedAssemblies(listing), [dll('My (copy) F')]);
    assert.deepStrictEqual(parseTestAssemblies(listing), [dll('My (copy) F')], 'it resolves');
    assert.strictEqual(
      parseAnnouncedFrameworks(listing).get(dll('My (copy) F')),
      'net10.0',
      'the framework is the group that names one, not the last parenthesis on the line',
    );
  });

  test('a test name carrying the words is not a banner, and a bare banner still is', () => {
    const named = `    Fs.Tests.Test run for widgets (fast)\n${HEADER}Test run for nothing`;
    assert.deepStrictEqual(parseAnnouncedAssemblies(named), [], 'no framework closes either one');
    assert.strictEqual(parseAnnouncedFrameworks(named).size, 0, 'and neither names a framework');
    const bare = `Test run for ${dll('A')}`;
    assert.deepStrictEqual(
      parseAnnouncedAssemblies(bare),
      [dll('A')],
      'a line it opens is a banner',
    );
    assert.strictEqual(parseAnnouncedFrameworks(bare).size, 0, 'one that names no framework');
  });
});
