// The pure readers the Microsoft.Testing.Platform path depends on, exercised
// against the shapes real modules produce.
//
// These readers decide whether an MTP project appears in the Testing view at
// all, and whether anything in it can be run:
//
//   • `mtpRunnerSelected` reads the `global.json` opt-in. It must PARSE, never
//     search: the string "Microsoft.Testing.Platform" also appears in package
//     names and in unrelated properties, and a search would put a VSTest
//     solution on a path that cannot run it.
//   • `parseMtpTestList` turns a module's `--list-tests json` answer into ids.
//     The id comes from the listing's `type` block and NEVER from its display
//     name, because MSTest renders the display name as the BARE method name —
//     the issue-#180 defect in its MTP shape.
//   • `mtpUidsById` collapses the rows of a data-driven test onto the one id
//     they share while keeping every row's uid, so running that id runs them
//     all.
//   • `rejectedMtpOption` names the option a module refused, which is what
//     tells the user to reference `Microsoft.Testing.Extensions.TrxReport`
//     instead of reporting every test as "No result reported".
//   • `uidBatches` keeps one invocation under the Windows command-line ceiling.
//
// Covers [TEST-MTP-DETECT], [TEST-MTP-DISCOVERY] and [TEST-MTP-RUN].
import * as assert from 'node:assert/strict';
import {
  mtpIds,
  mtpLocationsById,
  mtpRunnerSelected,
  mtpUidsById,
  parseMtpTestList,
  rejectedMtpOption,
} from '../../test-mtp.js';
import { parseSolutionProjects } from '../../test-mtp-modules.js';
import { runArgs, trxNameFor, uidBatches, uidsFor } from '../../test-mtp-run.js';
import { announcedTestHostPid, TestHostWatcher } from '../../test-host-announce.js';
import { parseMtpSummary } from '../../test-run-output.js';

/** One node of a real `xunit.v3` listing, verbatim but for the shortened uid. */
const XUNIT_NODE = {
  uid: '9e472c8a9cdfb972d394daf60a3393384c4a50fdde9096e397d24d3e7521538d',
  displayName: 'Cs.XunitMtp.Fixtures.CalculatorTests.Adds_TwoNumbers',
  type: {
    assemblyFullName: 'XunitMtpCs, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null',
    namespace: 'Cs.XunitMtp.Fixtures',
    typeName: 'CalculatorTests',
    methodName: 'Adds_TwoNumbers',
  },
  location: { file: '/repo/XunitMtpCs/Tests.cs', lineStart: 7, lineEnd: 7 },
};

/** MSTest reports the BARE method name as its display name. */
const MSTEST_NODE = {
  uid: '1bc6cc0f-b32c-8a85-9f76-bfe4ce0054a9',
  displayName: 'Adds_Row (2,2,4)',
  type: {
    namespace: 'Cs.MstestMtp.Fixtures',
    typeName: 'CalculatorTests',
    methodName: 'Adds_Row',
  },
  location: { file: '/repo/MstestMtpCs/Tests.cs', lineStart: 12, lineEnd: 12 },
};

/** NUnit's uid is a DECORATED name, and it reports NO location. */
const NUNIT_NODE = {
  uid: 'Cs.NunitMtp.Fixtures.CalculatorTests.Adds_Case(2,2,4)',
  displayName: 'Adds_Case(2,2,4)',
  type: {
    namespace: 'Cs.NunitMtp.Fixtures',
    typeName: 'CalculatorTests',
    methodName: 'Adds_Case',
  },
};

/** A second row of the same xUnit theory — its own uid, the same `type`. */
const THEORY_ROW_ONE = {
  uid: '7e2c244d8fa669534e414cf9d0084978d32f4128ece29c5934516b47036f5de8',
  displayName: 'Cs.XunitMtp.Fixtures.CalculatorTests.Mixed_Theory(a: 2, b: 2, expected: 4)',
  type: {
    namespace: 'Cs.XunitMtp.Fixtures',
    typeName: 'CalculatorTests',
    methodName: 'Mixed_Theory',
  },
};
const THEORY_ROW_TWO = {
  ...THEORY_ROW_ONE,
  uid: '1d5d1e9898ba0e8a1b4b2a6b0b6f8c2d1e0a9f8b7c6d5e4f3a2b1c0d9e8f7a6b',
  displayName: 'Cs.XunitMtp.Fixtures.CalculatorTests.Mixed_Theory(a: 1, b: 1, expected: 99)',
};

/** A listing document, in the shape a module writes it. */
function listing(...tests: readonly unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, tests });
}

suite('Test Explorer MTP — the readers that decide what is discovered and run', () => {
  test('the global.json opt-in is PARSED, and nothing that merely mentions MTP counts', function () {
    const optIn = JSON.stringify({
      sdk: { version: '10.0.303' },
      test: { runner: 'Microsoft.Testing.Platform' },
    });
    assert.equal(mtpRunnerSelected(optIn), true, 'the documented opt-in must select MTP');
    assert.equal(
      mtpRunnerSelected(JSON.stringify({ test: { runner: 'microsoft.testing.platform' } })),
      true,
      'the runner name is compared without letter case',
    );
    assert.equal(
      mtpRunnerSelected(JSON.stringify({ test: { runner: 'VSTest' } })),
      false,
      'the explicit VSTest runner must NOT select MTP',
    );

    // A file that merely CONTAINS the words, in every place a real repository
    // puts them. A string search would switch each of these onto a path that
    // cannot run them.
    const decoys = [
      JSON.stringify({ msbuild: { 'Microsoft.Testing.Platform': '2.4.0' } }),
      JSON.stringify({ test: { runner: 'Microsoft.Testing.Platform.Extra' } }),
      JSON.stringify({ tools: { test: 'Microsoft.Testing.Platform' } }),
      '{ "test": { "runner": "Microsoft.Testing.Platform" ',
    ];
    for (const decoy of decoys) {
      assert.equal(mtpRunnerSelected(decoy), false, `must not select MTP for: ${decoy}`);
    }
    assert.equal(mtpRunnerSelected(''), false, 'an empty file selects nothing and never throws');
  });

  test('an id comes from the type block, so a bare MSTest display name is never one', function () {
    const parsed = parseMtpTestList(listing(XUNIT_NODE, MSTEST_NODE, NUNIT_NODE));

    assert.deepStrictEqual(parsed.warnings, [], 'a known schema produces no warning');
    assert.deepStrictEqual(
      mtpIds(parsed.tests),
      [
        'Cs.XunitMtp.Fixtures.CalculatorTests.Adds_TwoNumbers',
        'Cs.MstestMtp.Fixtures.CalculatorTests.Adds_Row',
        'Cs.NunitMtp.Fixtures.CalculatorTests.Adds_Case',
      ],
      'every id is namespace + type + method, with NO row data',
    );
    assert.equal(
      parsed.tests[1]?.label,
      'Adds_Row (2,2,4)',
      'the display name survives as the LABEL, which is not a key',
    );
    assert.equal(
      parsed.tests[2]?.uid,
      'Cs.NunitMtp.Fixtures.CalculatorTests.Adds_Case(2,2,4)',
      'an NUnit uid keeps its parentheses and commas verbatim',
    );

    // The location is optional, and its absence is not an error.
    const locations = mtpLocationsById(parsed.tests);
    assert.equal(locations.get('Cs.XunitMtp.Fixtures.CalculatorTests.Adds_TwoNumbers')?.line, 7);
    assert.equal(
      locations.get('Cs.XunitMtp.Fixtures.CalculatorTests.Adds_TwoNumbers')?.file,
      '/repo/XunitMtpCs/Tests.cs',
    );
    assert.equal(
      locations.has('Cs.NunitMtp.Fixtures.CalculatorTests.Adds_Case'),
      false,
      'NUnit reports no location, and the reader must not invent one',
    );
  });

  test('the rows of a data-driven test collapse onto one id that owns every uid', function () {
    const parsed = parseMtpTestList(listing(THEORY_ROW_ONE, THEORY_ROW_TWO, XUNIT_NODE));
    const id = 'Cs.XunitMtp.Fixtures.CalculatorTests.Mixed_Theory';

    assert.equal(mtpIds(parsed.tests).length, 2, 'two rows and one fact make two ids');
    const uids = mtpUidsById(parsed.tests);
    assert.deepStrictEqual(
      uids.get(id),
      [THEORY_ROW_ONE.uid, THEORY_ROW_TWO.uid],
      'both rows must run when the one id is selected',
    );

    // And that is exactly what the run turns into a filter.
    const module = { modulePath: '/repo/bin/XunitMtpCs.dll', uidsById: uids };
    assert.deepStrictEqual(uidsFor(module, [id]), [THEORY_ROW_ONE.uid, THEORY_ROW_TWO.uid]);
    assert.deepStrictEqual(uidsFor(module, []), [], 'an empty selection means "run everything"');
    assert.deepStrictEqual(uidsFor(module, ['Not.A.Test']), [], 'an unknown id contributes none');
  });

  test('a hostile listing degrades with a warning and never throws', function () {
    const bom = `\uFEFF\n  ${listing(XUNIT_NODE)}`;
    assert.equal(
      parseMtpTestList(bom).tests.length,
      1,
      'a byte-order mark and a leading blank line must not hide the document',
    );

    const future = JSON.stringify({ schemaVersion: 99, tests: [XUNIT_NODE] });
    const parsedFuture = parseMtpTestList(future);
    assert.equal(parsedFuture.tests.length, 1, 'an unknown schema still yields what it can');
    assert.equal(parsedFuture.warnings.length, 1, 'and says so exactly once');
    assert.match(parsedFuture.warnings[0] ?? '', /schemaVersion 99/);

    assert.deepStrictEqual(parseMtpTestList(listing()).tests, [], 'an empty listing is empty');
    assert.deepStrictEqual(
      parseMtpTestList('Unhandled exception. System.TypeLoadException').tests,
      [],
      'a crashed module produces no test',
    );
    assert.equal(parseMtpTestList('not json at all').warnings.length, 1);
    assert.equal(
      parseMtpTestList(JSON.stringify({ schemaVersion: 1 })).warnings[0],
      'Test listing carried no "tests" array',
    );

    // A node with no `type` falls back to the display name rather than vanishing.
    const untyped = parseMtpTestList(listing({ uid: 'u1', displayName: 'Ns.Type.Method' }));
    assert.deepStrictEqual(mtpIds(untyped.tests), ['Ns.Type.Method']);
    assert.deepStrictEqual(
      parseMtpTestList(listing({ displayName: 'no uid' })).tests,
      [],
      'a node with no uid could never be run, so it is dropped',
    );
  });

  test('a rejected option is named, so the missing package can be told to the user', function () {
    const output = [
      "Unknown option '--report-trx'",
      'Command line: --report-trx --results-directory /tmp',
      'Usage dotnet exec XunitMtpCs.dll [option providers]',
    ].join('\n');

    assert.equal(rejectedMtpOption(output), '--report-trx');
    assert.equal(rejectedMtpOption("Unknown option '--coverage'"), '--coverage');
    assert.equal(rejectedMtpOption('Test run summary: Passed!'), undefined);
    assert.equal(rejectedMtpOption(''), undefined);
  });

  test('a run is one command line per module, under the Windows ceiling', function () {
    const args = runArgs(
      '/repo/bin/XunitMtpCs.dll',
      ['uid-one', 'uid-two'],
      '/tmp/results',
      {},
      'XunitMtpCs.0.trx',
    );

    assert.deepStrictEqual(args, [
      'exec',
      '/repo/bin/XunitMtpCs.dll',
      '--filter-uid',
      'uid-one',
      'uid-two',
      '--report-trx',
      '--report-trx-filename',
      'XunitMtpCs.0.trx',
      '--results-directory',
      '/tmp/results',
      '--no-banner',
      '--no-ansi',
    ]);
    assert.equal(
      args.includes('--no-progress'),
      false,
      '--no-progress is deprecated since MTP 2.3 and warns on every run',
    );
    assert.equal(
      runArgs('/m.dll', [], '/tmp', {}, 'm.trx').includes('--filter-uid'),
      false,
      'an empty selection sends no filter at all',
    );
    assert.deepStrictEqual(
      runArgs('/m.dll', [], '/tmp', { coverage: true }, 'm.trx').slice(-3),
      ['--coverage', '--coverage-output-format', 'cobertura'],
      'MTP has no --collect:"XPlat Code Coverage"; it collects Cobertura this way',
    );

    // Two modules must not write one file name into a shared directory.
    assert.equal(trxNameFor('/repo/bin/XunitMtpCs.dll', 0), 'XunitMtpCs.0.trx');
    assert.notEqual(
      trxNameFor('/repo/bin/XunitMtpCs.dll', 0),
      trxNameFor('/repo/bin/MstestMtpCs.dll', 0),
    );
    assert.notEqual(
      trxNameFor('/repo/bin/XunitMtpCs.dll', 0),
      trxNameFor('/repo/bin/XunitMtpCs.dll', 1),
      'a second batch of one module must not overwrite the first',
    );
  });

  test('uids are batched, never dropped and never split', function () {
    const uids = Array.from(
      { length: 400 },
      (_, index) => `uid-${String(index).padStart(64, '0')}`,
    );
    const batches = uidBatches(uids, 1_000);

    assert.ok(batches.length > 1, 'a large selection must be split');
    assert.deepStrictEqual(batches.flat(), uids, 'every uid survives, in order');
    for (const batch of batches) {
      const width = batch.reduce((sum, uid) => sum + uid.length + 3, 0);
      assert.ok(width <= 1_000 || batch.length === 1, 'only a lone over-long uid may exceed');
    }
    assert.deepStrictEqual(uidBatches([], 1_000), [], 'nothing selected is nothing to run');
    assert.deepStrictEqual(
      uidBatches(['x'.repeat(5_000)], 1_000),
      [['x'.repeat(5_000)]],
      'one over-budget uid gets its own batch rather than being dropped',
    );
  });

  test('the MTP summary block is read, and a skip is never called a failure', function () {
    const output = [
      'Test run summary: Failed! - /repo/bin/XunitMtpCs.dll (net10.0|x64)',
      '  total: 5',
      '  failed: 1',
      '  succeeded: 3',
      '  skipped: 1',
      '  duration: 425ms',
      'Test run summary: Passed! - /repo/bin/MstestMtpCs.dll (net10.0|x64)',
      '  total: 4',
      '  failed: 0',
      '  succeeded: 4',
      '  skipped: 0',
    ].join('\n');

    const summary = parseMtpSummary(output);
    assert.ok(summary, 'two modules print two blocks, and both are read');
    assert.equal(summary.total, 9, 'the counts of every module are summed');
    assert.equal(summary.failed, 1);
    assert.equal(summary.passed, 7);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.outcome, 'failed');

    const allSkipped = parseMtpSummary(
      [
        'Test run summary: Zero tests ran',
        '  total: 1',
        '  failed: 0',
        '  succeeded: 0',
        '  skipped: 1',
      ].join('\n'),
    );
    assert.equal(allSkipped?.outcome, 'skipped', 'a skipped run is NOT a failure');
    assert.equal(parseMtpSummary('nothing here'), undefined, 'no block means no summary');
  });

  test('a waiting host is found whether it announces itself bare or behind a prefix', function () {
    // VSTest's `testhost.dll` prints the line on its own. A Microsoft.Testing
    // .Platform module IS the test host and prints the SAME text behind a
    // prefix. Anchored to the start of the line, every MTP debug run hung on a
    // module nothing ever attached to.
    assert.equal(announcedTestHostPid('Process Id: 4242, Name: testhost'), 4242);
    assert.equal(
      announcedTestHostPid('Waiting for debugger to attach... Process Id: 212243, Name: dotnet'),
      212243,
      'the MTP announcement carries a prefix, and its pid must still be found',
    );
    assert.equal(announcedTestHostPid('  Process Id: 7, Name: x  '), 7, 'indentation is trimmed');

    // Nothing that is not a real pid may aim the debugger.
    for (const line of [
      'Process Id: , Name: x',
      'Process Id: 12ab, Name: x',
      'Process Id: 0, Name: x',
      'Process Id: -3, Name: x',
      'no announcement here',
      '',
    ]) {
      assert.equal(announcedTestHostPid(line), undefined, `must not read a pid from: '${line}'`);
    }

    // The watcher reassembles split chunks and reports each host exactly once.
    const seen: number[] = [];
    const watcher = new TestHostWatcher((pid) => seen.push(pid));
    watcher.absorb('Waiting for debugger to attach... Proce');
    watcher.absorb('ss Id: 900, Name: dotnet\nProcess Id: 900, Name: dotnet\n');
    watcher.absorb('Process Id: 901, Name: testhost\n');
    assert.deepStrictEqual(seen, [900, 901], 'one report per host, across chunk boundaries');
  });

  test('the solution project list is classified line by line, not sliced past a header', function () {
    const output = [
      'Project(s)',
      '----------',
      'XunitMtpFs/XunitMtpFs.fsproj',
      'XunitMtpCs/XunitMtpCs.csproj',
      '',
    ].join('\n');
    const projects = parseSolutionProjects(output, '/repo');

    assert.deepStrictEqual(projects, [
      '/repo/XunitMtpFs/XunitMtpFs.fsproj',
      '/repo/XunitMtpCs/XunitMtpCs.csproj',
    ]);
    assert.deepStrictEqual(
      parseSolutionProjects(['Projekt(e)', '------', 'A/A.csproj'].join('\n'), '/repo'),
      ['/repo/A/A.csproj'],
      'a localized header must not become a project path',
    );
    assert.deepStrictEqual(parseSolutionProjects('', '/repo'), []);
  });
});
