// The xunit.v3 NATIVE console, read and spoken: the pure readers and argument
// vectors of `test-mtp-cli.ts`, and the package-graph half of MTP detection.
//
// Every input here was captured from a REAL module the `dotnet` CLI built —
// `xunit.v3` 4.0.3 with no runner switch — because these readers exist to read
// that module's exact voice, ANSI escapes included. The same project shape
// pressed through the real profiles is `test-explorer-mtp-native.test.ts`.
//
// Implements [TEST-MTP-DISCOVERY], [TEST-MTP-RUN]; issue #581.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseXunitTestList,
  rejectedXunitOption,
  xunitListArgs,
  xunitRunArgs,
} from '../../test-mtp-cli.js';
import { joinPath } from '../../paths.js';
import { runArgs } from '../../test-mtp-report.js';
import { referencesMtpPackage } from '../../test-mtp-modules.js';
import { removeDirRecursive } from './test-helpers';

/** `-list full/json` of a real F# module: backtick ids carry SPACES. */
const FSHARP_LISTING = [
  '[{"Assembly":"/repo/fsx/bin/Debug/net10.0/Tests.dll",',
  '"DisplayName":"Fs.XunitNative.Fixtures.adds theory rows",',
  '"ID":"a93e1a733e4f867e7c4cea5d08ee229cb826eaae49b98d4e2f6cad3992344abf",',
  '"Class":"Fs.XunitNative.Fixtures","Method":"adds theory rows","Explicit":false},',
  '{"Assembly":"/repo/fsx/bin/Debug/net10.0/Tests.dll",',
  '"DisplayName":"Fs.XunitNative.Fixtures.adds two numbers with spaces",',
  '"ID":"02e0b6a6b3b06884060548f721da9c82ff351a9be85fddb22f7442338b08de39",',
  '"Class":"Fs.XunitNative.Fixtures","Method":"adds two numbers with spaces",',
  '"Explicit":false}]',
  '',
].join('\n');

/** The same module's refusal of an MTP option, ANSI colour and all. */
const REFUSAL = '\u001B[91merror: unknown option: --filter-uid\n\u001B[0m';

/** One project directory whose `obj` holds the given assets document. */
function withAssets(assets: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slsp-mtp-cli-'));
  fs.mkdirSync(path.join(root, 'obj'), { recursive: true });
  fs.writeFileSync(path.join(root, 'obj', 'project.assets.json'), assets, 'utf8');
  return path.join(root, 'Tests.csproj');
}

/** The restore graph of a project that reaches MTP transitively through xunit.v3. */
const MTP_ASSETS = JSON.stringify({
  libraries: {
    'Microsoft.Testing.Extensions.Telemetry/2.5.2': { type: 'package' },
    'Microsoft.Testing.Platform/2.5.2': { type: 'package' },
    'Microsoft.Testing.Platform.MSBuild/2.5.2': { type: 'package' },
    'xunit.v3/4.0.3': { type: 'package' },
  },
});

/** The restore graph of an ordinary VSTest project: no MTP package anywhere. */
const VSTEST_ASSETS = JSON.stringify({
  libraries: {
    'Microsoft.NET.Test.Sdk/17.11.1': { type: 'package' },
    'xunit/2.9.3': { type: 'package' },
    'xunit.runner.visualstudio/3.1.4': { type: 'package' },
  },
});

suite('xunit.v3 native console — readers and arguments (#581)', () => {
  test('a real F# listing becomes ids, uids and labels', () => {
    const { tests, warnings } = parseXunitTestList(FSHARP_LISTING);
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      tests.map((test) => test.id),
      [
        'Fs.XunitNative.Fixtures.adds theory rows',
        'Fs.XunitNative.Fixtures.adds two numbers with spaces',
      ],
    );
    for (const test of tests) {
      assert.match(test.uid, /^[0-9a-f]{64}$/, 'the uid is the listing ID, verbatim');
      assert.equal(test.file, undefined, 'the native listing reports no location');
      assert.equal(test.line, undefined);
      assert.equal(test.label, test.id, 'the default display name is the id');
    }
  });

  test('the id is class and method, never the bare display name', () => {
    const listing = parseXunitTestList(
      JSON.stringify([
        {
          Assembly: '/repo/Cs.dll',
          DisplayName: 'Adds_TwoNumbers',
          ID: 'aa',
          Class: 'Cs.XunitNative.Fixtures.CalculatorTests',
          Method: 'Adds_TwoNumbers',
          Explicit: false,
        },
      ]),
    );
    assert.deepEqual(listing.warnings, []);
    assert.deepEqual(listing.tests, [
      {
        id: 'Cs.XunitNative.Fixtures.CalculatorTests.Adds_TwoNumbers',
        uid: 'aa',
        label: 'Adds_TwoNumbers',
        file: undefined,
        line: undefined,
      },
    ]);
  });

  test('a node without an ID warns instead of vanishing silently', () => {
    const listing = parseXunitTestList(
      JSON.stringify([
        { DisplayName: 'NoIdHere', Class: 'Ns.C', Method: 'M' },
        { DisplayName: 'HasOne', ID: 'bb', Class: 'Ns.C', Method: 'M2' },
      ]),
    );
    assert.deepEqual(
      listing.tests.map((test) => test.uid),
      ['bb'],
    );
    assert.deepEqual(listing.warnings, ['Test listing contained nodes without usable IDs']);
  });

  test('a document that is no listing is a warning, never a throw', () => {
    assert.deepEqual(parseXunitTestList('not json at all').tests, []);
    assert.deepEqual(parseXunitTestList('{"tests":[]}').warnings, [
      'Test listing was not a JSON document',
    ]);
    assert.deepEqual(parseXunitTestList('').warnings, ['Test listing was not a JSON document']);
  });

  test('the refusal reader knows the native voice and only that voice', () => {
    assert.equal(rejectedXunitOption(REFUSAL), '--filter-uid');
    assert.equal(rejectedXunitOption('error: missing argument for -list'), '-list');
    assert.equal(rejectedXunitOption("error : Unknown option '--report-trx'"), undefined);
    assert.equal(
      rejectedXunitOption("Option '--list-tests' from provider 'p' (UID: u) expects no arguments"),
      undefined,
    );
    assert.equal(rejectedXunitOption('  Discovered:  Tests\n  Finished: Tests'), undefined);
  });

  test('the native listing asks with the runner own options', () => {
    assert.deepEqual(xunitListArgs('/repo/bin/Tests.dll'), [
      'exec',
      '/repo/bin/Tests.dll',
      '-list',
      'full/json',
    ]);
  });

  test('a native run selects by uid pairs and reports by absolute path', () => {
    // The report path is the native join: `\\` on Windows, `/` elsewhere.
    assert.deepEqual(xunitRunArgs([], '/tmp/res', 'Tests.0.trx'), [
      '-noLogo',
      '-noColor',
      '-result-trx',
      joinPath('/tmp/res', 'Tests.0.trx'),
    ]);
    assert.deepEqual(xunitRunArgs(['aa', 'bb'], '/tmp/res', 'Tests.1.trx'), [
      '-noLogo',
      '-noColor',
      '-result-trx',
      joinPath('/tmp/res', 'Tests.1.trx'),
      '-id',
      'aa',
      '-id',
      'bb',
    ]);
  });

  test('a native invocation carries no MTP option anywhere', () => {
    const args = runArgs(
      '/m.dll',
      ['aa'],
      '/tmp/res',
      { coverage: true },
      'M.0.trx',
      'trx',
      'xunit',
    );
    assert.ok(args.includes('-id'), 'the selection is the listing ID');
    for (const refused of ['--filter-uid', '--report-trx', '--results-directory', '--coverage'])
      assert.ok(!args.includes(refused), `${refused} must not reach a native module`);
  });

  test('the package graph decides which projects earn an MSBuild evaluation', () => {
    const mtp = withAssets(MTP_ASSETS);
    assert.equal(referencesMtpPackage(mtp), true, 'a transitive MTP package counts');
    const vstest = withAssets(VSTEST_ASSETS);
    assert.equal(referencesMtpPackage(vstest), false, 'an ordinary VSTest graph is definitive');
    fs.rmSync(path.dirname(vstest), { recursive: true, force: true });
    assert.equal(
      referencesMtpPackage(path.join(path.sep, 'nowhere', 'Tests.csproj')),
      undefined,
      'nothing restored is undecidable, not false',
    );
    removeDirRecursive(path.dirname(mtp));
  });

  test('a corrupt assets file is undecidable, never a false negative', () => {
    const broken = withAssets('{"libraries": [');
    try {
      assert.equal(referencesMtpPackage(broken), undefined);
    } finally {
      removeDirRecursive(path.dirname(broken));
    }
  });
});
