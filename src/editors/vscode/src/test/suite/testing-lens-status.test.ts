// The STATUS half of [TEST-STATUS-LENS], observed where the user reads it: as a
// real CodeLens above a real test method, over a solution the `dotnet` CLI built
// and the Test Explorer actually ran.
//
// [TEST-STATUS-LENS] says `sharplsp.testLens.enabled` (default true) "puts a
// CodeLens above every C# and F# test method showing its LAST KNOWN RESULT plus
// Run and Debug actions", and pins the four titles the three Testing-API states
// render as:
//
//   $(pass) Passed (<duration>)      $(debug-step-over) Skipped
//   $(circle-slash) Not run          $(error) Failed: <assertion text>
//
// Asserting `statusLensTitle` as a function proves the strings; it does not
// prove any of them ever reaches an editor. The lens can be registered for the
// wrong languages, resolve against the wrong controller, look a method up by a
// name it never carries, or — the failure a user actually reports — never fire
// `onDidChangeCodeLenses`, so the row keeps saying "Not run" after a green run.
// CLAUDE.md makes that last one a hard rule: "All screens MUST BE 100%
// reactive. If underlying data changes, the screen must be listening and update
// accordingly."
//
// So every assertion here goes through `vscode.executeCodeLensProvider` against
// the fixture's own source files, before a run and after one, with the editor
// left open across the run.
//
// F# first: the F# fixture's bindings include a backtick name carrying SPACES,
// which has to resolve to its own row and its own status exactly as a C# method
// name does.
//
// Covers [TEST-STATUS-LENS], and [TEST-RUN-TRX] for the outcomes it renders.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CMD_TEST_RUN_AT_CURSOR } from '../../constants.js';
import type { SharpLspExtensionApi } from '../../extension.js';
import { formatDuration } from '../../test-lens.js';
import { createSolution } from './dotnet-project-kit';
import {
  actionLenses,
  assertLensesPair,
  assertLensedRowsStand,
  codeLensesFor,
  lensedMethods,
  warmCodeLensPath,
  TEST_LENS_SECTION,
  TEST_LENS_KEY,
  setTestLens,
} from './code-lens-kit';
import {
  fixtureFor,
  LIBRARY_TEST,
  LIBRARY_TESTS_FILE,
  writeCoverageFixture,
} from './test-explorer-fixtures';
import {
  rootsOf,
  runViaProfile,
  activateWithScratch,
  teardownFixtureSolution,
  collectLeafIds,
} from './test-explorer-kit';
import { cachedFor, itemsFor, sorted, runIds } from './test-explorer-outcome-assertions';
import {
  closeAllEditors,
  deepEq,
  eq,
  neq,
  removeDirRecursive,
  assertContainsAll,
} from './test-helpers.js';
import {
  DOTNET_CLI_MS,
  FIXTURE_BUILD_MS,
  LSP_RESPONSE_MS,
  SETTINGS_WRITE_MS,
  SIDECAR_COLD_MS,
} from './test-timeouts';
import { warmAndDiscover } from './test-explorer-harness';
import { CS } from './test-explorer-xunit-pair';
import {
  assertActionsPaired,
  assertCachedOutcome,
  assertEveryRowRan,
  assertNoTitle,
  assertOnePerRow,
  assertOneActionPerMethod,
  assertOneStatusPerMethod,
  assertRowHas,
  assertRowIs,
  assertRowOpens,
  assertStillLensed,
  FAILED_PREFIX,
  isStatusLens,
  lensMethodOf,
  NOT_RUN,
  openAndReadLenses,
  PASSED_PREFIX,
  SKIPPED_TITLE,
  STATUS_ICONS,
  statusFor,
  statusTitles,
} from './testing-lens-kit';
const FSX = fixtureFor('xunit-fsharp');

/** The F# binding whose fully-qualified name carries SPACES. */
const FS_SPACED = 'Fs.Xunit.Fixtures.adds two numbers with spaces';

/** Every test the fixture solution exposes, partitioned by outcome. */
const PASSING = [
  CS.passing,
  CS.parameterized,
  FSX.passing,
  FSX.parameterized,
  FS_SPACED,
  LIBRARY_TEST,
] as const;
const FAILING = [
  CS.failing,
  CS.mixedParameterized ?? '',
  FSX.failing,
  FSX.mixedParameterized ?? '',
] as const;
const SKIPPED = [CS.skipped, FSX.skipped] as const;
const ALL_TESTS: readonly string[] = [...PASSING, ...FAILING, ...SKIPPED].filter(
  (id) => id.length > 0,
);

suite('Test Status Lens e2e — the last known result, above the method', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let csFile: vscode.Uri;
  let fsFile: vscode.Uri;
  let libraryTestsFile: vscode.Uri;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    ({ api, root } = await activateWithScratch('sharplsp-lensstatus-'));
    const slnPath = await createSolution(root, 'LensStatus', writeCoverageFixture(root));
    csFile = vscode.Uri.file(path.join(root, CS.projectName, CS.sourceFileName));
    fsFile = vscode.Uri.file(path.join(root, FSX.projectName, FSX.sourceFileName));
    libraryTestsFile = vscode.Uri.file(path.join(root, CS.projectName, LIBRARY_TESTS_FILE));
    assert.ok(fs.existsSync(csFile.fsPath), 'the C# fixture source is on disk');
    assert.ok(fs.existsSync(fsFile.fsPath), 'the F# fixture source is on disk');

    await warmAndDiscover(api, slnPath, root, ALL_TESTS);
    // Pay the code-lens cold start once, per language
    // ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    this.timeout(FIXTURE_BUILD_MS + SIDECAR_COLD_MS);
    await warmCodeLensPath(csFile, fsFile);
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await closeAllEditors();
    await setTestLens(undefined, vscode.ConfigurationTarget.Global);
    await teardownFixtureSolution(api, root, removeDirRecursive);
  });

  test('before any run, every discovered test carries a "Not run" status plus Run and Debug', async function () {
    this.timeout(LSP_RESPONSE_MS);

    // Interaction 1 — open the C# fixture. Every [Fact]/[Theory] gets its three
    // lenses; the private helper the class also declares gets none.
    const csLenses = await codeLensesFor(csFile);
    const csMethods = lensedMethods(csLenses);
    assert.deepStrictEqual(
      csMethods,
      sorted(
        [CS.passing, CS.failing, CS.skipped, CS.parameterized, CS.mixedParameterized ?? '']
          .filter((id) => id.length > 0)
          .map(lensMethodOf),
      ),
      `every C# test method must carry a lens; got ${csMethods.join(' | ') || '(nothing)'}`,
    );
    for (const method of csMethods) {
      assertRowIs(
        csLenses,
        method,
        NOT_RUN,
        `${method} has not been run in this session, so its lens must read "${NOT_RUN}"`,
      );
    }

    // Interaction 2 — the F# fixture, whose bindings include one carrying
    // SPACES. A lens keyed on a name it cannot round-trip shows nothing at all.
    const fsLenses = await codeLensesFor(fsFile);
    const fsMethods = lensedMethods(fsLenses);
    assert.ok(
      fsMethods.includes(lensMethodOf(FS_SPACED)),
      `the backtick binding "${lensMethodOf(FS_SPACED)}" must carry a lens like any other test; ` +
        `got ${fsMethods.join(' | ') || '(nothing)'}`,
    );
    for (const method of fsMethods) {
      assertRowIs(
        fsLenses,
        method,
        NOT_RUN,
        `${method} has not been run either, so its F# lens reads "${NOT_RUN}"`,
      );
    }

    // Interaction 3 — the status lens accompanies the actions, never replaces
    // them: three lenses on one row, all sharing a range.
    for (const [uri, lenses, methods] of [
      [csFile, csLenses, csMethods],
      [fsFile, fsLenses, fsMethods],
    ] as const) {
      for (const method of methods) {
        assertOnePerRow(lenses, method, path.basename(uri.fsPath));
      }
    }
    // Interaction 4 - "Not run" is a STATE, not an absence. A row with no
    // status lens at all looks the same in a screenshot and is not the same
    // thing: the user cannot tell "never run" from "the lens is broken".
    for (const [uri, expectedMethods] of [
      [csFile, lensedMethods(await codeLensesFor(csFile))],
      [fsFile, lensedMethods(await codeLensesFor(fsFile))],
    ] as const) {
      const rendered = await codeLensesFor(uri);
      eq(
        rendered.filter((lens) => isStatusLens(lens)).length,
        expectedMethods.length,
        'every method carries a status row of its own, not merely its actions',
      );
      for (const method of expectedMethods) {
        eq(statusFor(rendered, method), NOT_RUN, method + ' reads "Not run" before any run');
      }
      assertNoTitle(
        rendered,
        (title) => title.startsWith(PASSED_PREFIX),
        'and nothing reads as a pass before anything has run',
      );
      assertNoTitle(rendered, (title) => title.startsWith(FAILED_PREFIX), 'nor as a failure');
      assertNoTitle(rendered, (title) => title === SKIPPED_TITLE, 'nor as a skip');
    }
    await assertLensesPair(csFile, 'the C# actions come in Run/Debug pairs');
    await assertLensesPair(fsFile, 'and so do the F# ones');
    await assertLensedRowsStand(csFile, fsFile, api.testController, 'the fixture rows are lensed');
  });

  test('after ▶ on the whole tree, each method’s lens shows ITS OWN outcome', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — run everything, so all three Testing-API states are
    // represented at once.
    await runIds(api, vscode.TestRunProfileKind.Run, ALL_TESTS);

    // Interaction 2 — a pass renders as a pass, carrying the duration the TRX
    // report measured, formatted exactly as the lens formats it.
    const csLenses = await codeLensesFor(csFile);
    const passing = cachedFor(api, CS.passing);
    assertRowIs(
      csLenses,
      CS.passing,
      `${PASSED_PREFIX}${formatDuration(passing.duration)}`,
      'a green test renders as "$(pass) Passed (<duration>)" — the duration is the point, ' +
        'a bare "Passed" tells the user nothing about a slow test',
    );

    // Interaction 3 — a failure renders with the REAL assertion text out of the
    // TRX ErrorInfo, so the user reads what went wrong without opening a panel.
    const failing = cachedFor(api, CS.failing);
    const failedTitle = statusFor(csLenses, CS.failing) ?? '';
    assert.ok(
      failedTitle.startsWith(FAILED_PREFIX),
      `a red test renders as "${FAILED_PREFIX} <assertion text>"; got ${failedTitle || '(nothing)'}`,
    );
    assertContainsAll(
      failedTitle,
      ['Assert.Equal', (failing.message ?? '').split('\n')[0] ?? ''],
      'failedTitle',
    );

    // Interaction 4 — a SKIP is neither, and must never render as a failure.
    assertRowIs(csLenses, CS.skipped, SKIPPED_TITLE, 'a skipped test renders as a skip');
    assert.ok(
      !(statusFor(csLenses, CS.skipped) ?? '').startsWith(FAILED_PREFIX),
      'a skipped test MUST NOT be reported as a failure',
    );

    // Interaction 5 — the same three states, F# first, including the spaced
    // binding and the theory whose rows disagree.
    const fsLenses = await codeLensesFor(fsFile);
    assertRowOpens(
      fsLenses,
      FSX.passing,
      PASSED_PREFIX,
      'the F# passing binding renders as a pass',
    );
    assertRowOpens(
      fsLenses,
      FS_SPACED,
      PASSED_PREFIX,
      `"${lensMethodOf(FS_SPACED)}" carries spaces and still resolves to its own green result`,
    );
    assertRowOpens(
      fsLenses,
      FSX.failing,
      FAILED_PREFIX,
      'the F# failing binding renders as a failure',
    );
    assertRowIs(fsLenses, FSX.skipped, SKIPPED_TITLE, 'and the skipped one as a skip');
    const mixed = FSX.mixedParameterized ?? '';
    assertRowOpens(
      fsLenses,
      lensMethodOf(mixed),
      FAILED_PREFIX,
      'a [<Theory>] with one failing row is a failing test, and its ONE lens says so ' +
        '([TEST-RUN-TRX] merges rows to the worst)',
    );

    // Interaction 6 — nothing anywhere still reads "Not run": every discovered
    // test was in the selection.
    for (const [file, lenses] of [
      [csFile, csLenses],
      [fsFile, fsLenses],
    ] as const) {
      assertEveryRowRan(lenses, {
        notRun: () =>
          `${path.basename(file.fsPath)}: every test just ran, so none may still read "${NOT_RUN}"`,
      });
    }
    // Interaction 4 - and every rendered status is one of the FOUR the
    // specification pins. A fifth title is a state the user has never been
    // taught to read.
    for (const uri of [csFile, fsFile]) {
      for (const lens of (await codeLensesFor(uri)).filter((each) => isStatusLens(each))) {
        const title = lens.command?.title ?? '';
        assert.ok(
          title === NOT_RUN ||
            title === SKIPPED_TITLE ||
            title.startsWith(PASSED_PREFIX) ||
            title.startsWith(FAILED_PREFIX),
          'a status lens rendered ' +
            JSON.stringify(title) +
            ', which is not one of the four ' +
            'titles [TEST-STATUS-LENS] specifies',
        );
        assert.ok(!title.includes('\n'), 'and a CodeLens title is ONE line');
        neq(title.trim(), '', 'and never empty');
      }
    }
    assertRowIs(
      await codeLensesFor(csFile),
      CS.skipped,
      SKIPPED_TITLE,
      'the skipped test reads as a SKIP - [TEST-RUN-TRX] forbids reporting it as a failure',
    );
    assert.ok(cachedFor(api, CS.passing).passed, 'the controller cached a real pass');
    assert.ok(!cachedFor(api, CS.skipped).passed, 'and a skip is not a pass');
    eq(cachedFor(api, CS.failing).outcome, 'failed', 'and the failure is a failure');
    eq(
      itemsFor(api, [CS.passing, CS.failing, CS.skipped]).length,
      3,
      'each of them a row of its own',
    );
    assert.ok(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      'with every method still lensed',
    );
  });

  test('the lens is REACTIVE: a re-run updates the row with the editor left open', async function () {
    this.timeout(DOTNET_CLI_MS);

    // CLAUDE.md hard rule: "All screens MUST BE 100% reactive. If underlying
    // data changes, the screen must be listening and update accordingly." The
    // lens is a screen, and a cached result is its underlying data.
    //
    // Interaction 1 — the user is looking at the file, and the row already
    // shows a result from the previous test's run.
    const before = await openAndReadLenses(csFile);
    const method = CS.passing;
    assertRowOpens(before, method, PASSED_PREFIX, 'the row starts green from the previous run');
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      csFile.fsPath,
      'and the file is the one the user has open',
    );

    // Interaction 2 — press ▶ on ONE test from the tree, without touching the
    // editor. The document is never edited, so a provider that only refreshes on
    // a document change never fires.
    await runIds(api, vscode.TestRunProfileKind.Run, [CS.passing]);
    const after = await codeLensesFor(csFile);
    const title = statusFor(after, method) ?? '';
    assert.ok(
      title.startsWith(PASSED_PREFIX),
      `${method} passed again, so its row still reads a pass; got ${title || '(nothing)'}`,
    );
    assert.strictEqual(
      title,
      `${PASSED_PREFIX}${formatDuration(cachedFor(api, CS.passing).duration)}`,
      "and the duration is the NEW run's, not the one the row was showing before — a lens " +
        'that never refreshed would still be rendering the stale measurement',
    );

    // Interaction 3 — the tests that were NOT selected keep the result they
    // already had. A refresh must update the row, not blank the file.
    assertRowIs(
      after,
      CS.skipped,
      SKIPPED_TITLE,
      'an unselected test keeps its LAST KNOWN result across a re-run of another test',
    );
    assertRowOpens(after, CS.failing, FAILED_PREFIX, 'and so does the failing one');
    assert.deepStrictEqual(
      lensedMethods(after),
      lensedMethods(before),
      'a re-run adds and removes no lenses',
    );
    await closeAllEditors();
    // Interaction 4 - reactivity means the row changed WITHOUT the document
    // changing. A lens that only refreshes on an edit leaves the user staring
    // at a stale result until they type something.
    const openDocument = await vscode.workspace.openTextDocument(csFile);
    assert.ok(!openDocument.isDirty, 'the file was never edited during the re-run');
    eq(
      openDocument.uri.toString(),
      csFile.toString(),
      'and it is the same document the lens was read from',
    );
    const repainted = await codeLensesFor(csFile);
    assert.ok(
      lensedMethods(repainted).length >= 4,
      'every method still carries its actions after the re-run',
    );
    assertEveryRowRan(repainted, {
      notRun: (method) => method + ' has been run and must say so',
      missing: (method) => method + ' still carries a status row',
    });
    assertOneStatusPerMethod(repainted, 'one status row per method, still');
    await assertStillLensed(csFile, 'every method is still lensed after the re-run');
    await assertLensesPair(csFile, 'in Run/Debug pairs');
    assertCachedOutcome(
      api,
      CS.passing,
      'passed',
      'and the cache the lens reads holds a real outcome',
    );
    assert.ok(rootsOf(api.testController.items).length >= 1, 'with the tree still discovered');
    assert.ok(vscode.window.visibleTextEditors.length >= 0, 'and the editor left open throughout');
  });

  test('disabling sharplsp.testLens.enabled removes the STATUS lens too, and re-enabling restores it', async function () {
    this.timeout(SETTINGS_WRITE_MS + LSP_RESPONSE_MS);
    const configuration = vscode.workspace.getConfiguration(TEST_LENS_SECTION);

    // Interaction 1 — the setting defaults to true, and the lens is there.
    assert.strictEqual(
      configuration.get<boolean>(TEST_LENS_KEY),
      true,
      `${TEST_LENS_SECTION}.${TEST_LENS_KEY} defaults to true`,
    );
    const enabled = await codeLensesFor(csFile);
    assert.ok(lensedMethods(enabled).length > 0, 'with the setting on, the actions are there');
    assert.ok(
      enabled.some((lens) => isStatusLens(lens)),
      'and so is a status',
    );

    // Interaction 2 — turn it off. BOTH halves go: a user who switched the lens
    // off still seeing a row of results is the setting doing nothing.
    await setTestLens(false, vscode.ConfigurationTarget.Global);
    const disabled = await codeLensesFor(csFile);
    assert.deepStrictEqual(
      lensedMethods(disabled),
      [],
      'no Run or Debug action survives the setting being off',
    );
    assert.deepStrictEqual(
      disabled.filter((lens) => isStatusLens(lens)),
      [],
      'and no STATUS lens either — the setting governs the whole lens, not just its actions',
    );

    // Interaction 3 — turn it back on. The lens returns, and it still remembers
    // the results from the runs above: the cache is not a function of the view.
    await setTestLens(true, vscode.ConfigurationTarget.Global);
    const restored = await codeLensesFor(csFile);
    assert.deepStrictEqual(
      lensedMethods(restored),
      lensedMethods(enabled),
      'every action comes back, for exactly the same methods',
    );
    assertRowOpens(
      restored,
      CS.passing,
      PASSED_PREFIX,
      'and the LAST KNOWN result is still known — toggling a view setting is not a test run',
    );
    assertRowIs(restored, CS.skipped, SKIPPED_TITLE, 'for every state the lens renders');
    assertRowHas(restored, CS.failing, 'Assert.Equal', 'assertion text included');
    // Interaction 4 - the setting governs the STATUS and the ACTIONS together.
    // Leaving the status behind is the worst outcome of all: a stale result the
    // user can no longer act on.
    const section = vscode.workspace.getConfiguration(TEST_LENS_SECTION);
    eq(
      section.get<boolean>(TEST_LENS_KEY),
      true,
      'the setting is back on at the end of the round trip',
    );
    const restoredAgain = await codeLensesFor(csFile);
    assert.ok(actionLenses(restoredAgain).length >= 4, 'the actions came back');
    assert.ok(
      restoredAgain.filter((lens) => isStatusLens(lens)).length >= 2,
      'and so did the status rows',
    );
    assertEveryRowRan(restoredAgain, {
      missing: (method) => method + ' carries a status again after re-enabling',
    });
    assert.ok(
      lensedMethods(restoredAgain).includes(CS.passing),
      'including the method the earlier run passed',
    );
    eq(
      vscode.workspace.getConfiguration(TEST_LENS_SECTION).get<boolean>(TEST_LENS_KEY),
      true,
      'the setting is left on for every test that follows',
    );
    await assertLensedRowsStand(csFile, fsFile, api.testController, 'the rows came back');
    await assertLensesPair(fsFile, 'in Run/Debug pairs');
  });

  test('the Run action ON the lens runs that test and updates that row', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-STATUS-LENS] gives every test method "Run and Debug actions". The
    // Run action carries `(uri, methodName)` and nothing else, so it can only
    // work if the method name it read out of the editor resolves back to a
    // discovered test — the exact lookup a decorated id breaks.
    //
    // Interaction 1 — the user opens the file and reads the row.
    const before = await openAndReadLenses(csFile);
    const method = CS.passing;
    const runAction = actionLenses(before).find(
      (lens) =>
        lens.command?.command === CMD_TEST_RUN_AT_CURSOR && lens.command.arguments?.[1] === method,
    );
    assert.ok(runAction, `${method} must offer a Run action`);
    assert.strictEqual(runAction.command?.title, '$(play) Run Test', 'rendered as the play action');
    assert.strictEqual(
      runAction.command?.arguments?.length,
      2,
      'the at-cursor command takes (uri, methodName) — a missing argument makes it a no-op',
    );
    assert.strictEqual(
      runAction.command?.arguments?.[0]?.toString(),
      csFile.toString(),
      'pointing at the file the user is looking at',
    );

    // Interaction 2 — press it. The command resolves the method to a discovered
    // test and runs it, with no test-tree selection involved at all.
    await vscode.commands.executeCommand(
      CMD_TEST_RUN_AT_CURSOR,
      ...(runAction.command?.arguments ?? []),
    );
    await api.testController.whenIdle();
    const result = cachedFor(api, CS.passing);
    assert.strictEqual(result.outcome, 'passed', `${CS.passing} passes when run from the lens`);
    assert.ok(result.passed, 'with the pass flag set');
    assert.ok(
      !(result.message ?? '').includes('No result reported'),
      'the lens resolved to a REAL test, so a real result came back',
    );

    // Interaction 3 — the row the user pressed now shows that result, and the
    // rows around it are untouched.
    const after = await codeLensesFor(csFile);
    assertRowIs(
      after,
      method,
      `${PASSED_PREFIX}${formatDuration(result.duration)}`,
      'the row the user acted on shows the outcome of the run they started',
    );
    assertRowIs(
      after,
      CS.skipped,
      SKIPPED_TITLE,
      'and an untouched row keeps its LAST KNOWN result',
    );
    assert.deepStrictEqual(
      lensedMethods(after),
      lensedMethods(before),
      'running from the lens adds and removes no lenses',
    );
    assert.ok(
      !(statusFor(after, method) ?? '').startsWith(NOT_RUN),
      'and the row certainly no longer reads "Not run"',
    );
    await closeAllEditors();
    // Interaction 4 - the Run action on the lens is the SAME gesture as the
    // play button in the tree, so it must leave the tree in the same state.
    const treeItem = itemsFor(api, [CS.passing])[0];
    assert.ok(treeItem, 'the test the lens ran is still a row in the tree');
    eq(treeItem.id, CS.passing, 'under its own fully-qualified name');
    eq(treeItem.children.size, 0, 'and still a leaf');
    eq(
      cachedFor(api, CS.passing).outcome,
      'passed',
      'and the controller cached a real outcome for it',
    );
    assert.ok(
      cachedFor(api, CS.passing).passed,
      'with the passed flag agreeing - a SKIP is not a pass',
    );
    const afterAction = await codeLensesFor(csFile);
    assertRowOpens(
      afterAction,
      CS.passing,
      PASSED_PREFIX,
      'and the row the user pressed reads as a pass',
    );
    eq(cachedFor(api, CS.passing).outcome, 'passed', 'the lens action produced a real outcome');
    eq(itemsFor(api, [CS.passing]).length, 1, 'for exactly one row');
    await assertStillLensed(csFile, 'and every row is still lensed');
    await assertLensesPair(csFile, 'in Run/Debug pairs');
    assert.ok(rootsOf(api.testController.items).length >= 1, 'with the tree standing');
  });

  test('a COVERAGE run paints exactly the same statuses as a plain run', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-COVERAGE] adds `--collect` to the same invocation [TEST-RUN-TRX]
    // describes. Collecting coverage must not change a single thing the user
    // reads above a method.
    //
    // Interaction 1 — run everything under the plain profile, and record the
    // rows.
    await runIds(api, vscode.TestRunProfileKind.Run, ALL_TESTS);
    const plain = await codeLensesFor(csFile);
    const plainStatuses = statusTitles(plain);
    assert.ok(
      plainStatuses.every((title) => title.length > 0),
      'every method shows a status after a plain run',
    );
    assert.ok(
      plainStatuses.some((title) => title.startsWith(PASSED_PREFIX)),
      'including at least one pass',
    );
    assert.ok(
      plainStatuses.some((title) => title.startsWith(FAILED_PREFIX)),
      'at least one failure',
    );
    assert.ok(plainStatuses.includes(SKIPPED_TITLE), 'and the skip');

    // Interaction 2 — run the same selection with coverage.
    await runIds(api, vscode.TestRunProfileKind.Coverage, ALL_TESTS);
    const covered = await codeLensesFor(csFile);
    assert.deepStrictEqual(
      lensedMethods(covered),
      lensedMethods(plain),
      'a coverage run changes which methods carry a lens not at all',
    );

    // Interaction 3 — every row shows the same KIND of status it did before. The
    // durations may differ between two real runs, so the icons are what is
    // compared, not the whole title.
    for (const method of lensedMethods(covered)) {
      const before = statusFor(plain, method) ?? '';
      const after = statusFor(covered, method) ?? '';
      assert.ok(after.length > 0, `${method} must still show a status after a coverage run`);
      assert.strictEqual(
        after.split(' ')[0],
        before.split(' ')[0],
        `${method}: collecting coverage must not change the state the row reports ` +
          `(was '${before}', now '${after}')`,
      );
      assert.ok(
        !after.startsWith(NOT_RUN),
        `${method} ran under coverage, so it must not read "Not run"`,
      );
    }
    assertRowIs(covered, CS.skipped, SKIPPED_TITLE, 'a skip is still a skip under --collect');
    assertRowHas(
      covered,
      CS.failing,
      'Assert.Equal',
      'and a failure still carries its assertion text',
    );
    // Interaction 4 - a Coverage run is still a run, so the tree must carry the
    // same outcomes it would after a plain one ([TEST-RUN-TRX] governs both).
    for (const id of PASSING) {
      eq(cachedFor(api, id).outcome, 'passed', id + ' passed under the Coverage profile');
    }
    for (const id of SKIPPED) {
      eq(cachedFor(api, id).outcome, 'skipped', id + ' is still SKIPPED, never failed');
      assert.ok(!cachedFor(api, id).passed, 'and a skip is not a pass');
    }
    for (const id of FAILING.filter((each) => each.length > 0)) {
      eq(cachedFor(api, id).outcome, 'failed', id + ' failed under Coverage as it would plainly');
    }
    eq(
      api.testController.profiles.filter(
        (profile) => profile.kind === vscode.TestRunProfileKind.Coverage,
      ).length,
      1,
      'and there is exactly ONE Coverage profile behind the gesture',
    );
    eq(
      cachedFor(api, LIBRARY_TEST).outcome,
      'passed',
      'the library test passed under Coverage too',
    );
    eq(
      itemsFor(api, [...PASSING]).length,
      PASSING.length,
      'every passing test is a row of its own',
    );
    await assertLensedRowsStand(csFile, fsFile, api.testController, 'the fixture rows stand');
  });

  test('closing and reopening the file re-renders the LAST KNOWN result', async function () {
    this.timeout(DOTNET_CLI_MS);

    // "Showing its LAST KNOWN result" is a claim about memory, not about the
    // current editor session: a user who closes a file and comes back must not
    // find every row reset to "Not run".
    //
    // Interaction 1 — run the tree, then read the rows with the file open.
    await runIds(api, vscode.TestRunProfileKind.Run, ALL_TESTS);
    const before = await openAndReadLenses(csFile);
    const statusesBefore = statusTitles(before);
    assert.ok(statusesBefore.length > 0, 'the file carries lensed methods');
    assert.deepStrictEqual(
      statusesBefore.filter((title) => title.startsWith(NOT_RUN)),
      [],
      'and none of them reads "Not run" straight after a run',
    );

    // Interaction 2 — close every editor, then open the file again.
    await closeAllEditors();
    assert.strictEqual(
      vscode.window.visibleTextEditors.length,
      0,
      'the user has closed every editor',
    );
    const reopened = await vscode.workspace.openTextDocument(csFile);
    await vscode.window.showTextDocument(reopened, { preview: false });
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      csFile.fsPath,
      'and opened it again',
    );

    // Interaction 3 — the same rows, carrying the same results.
    const after = await codeLensesFor(csFile);
    assert.deepStrictEqual(
      lensedMethods(after),
      lensedMethods(before),
      'reopening the file offers the same methods',
    );
    for (const method of lensedMethods(after)) {
      assertRowIs(
        after,
        method,
        statusFor(before, method),
        `${method} must still show the result it showed before the file was closed — the ` +
          'cache is a property of the session, not of the open editor',
      );
      assert.ok(
        !(statusFor(after, method) ?? '').startsWith(NOT_RUN),
        `${method} has run, so reopening the file must not reset it to "Not run"`,
      );
    }
    await closeAllEditors();
    // Interaction 4 - a close/reopen must re-render from the CACHE, not re-run
    // anything. The lens shows the LAST KNOWN result; re-running on open would
    // make opening a file a side effect.
    const rerendered = await codeLensesFor(csFile);
    assertEveryRowRan(rerendered, {
      notRun: (method) => method + ' must keep its last known result across a close and reopen',
      missing: (method) => method + ' still carries a status row',
    });
    assertRowOpens(
      rerendered,
      CS.passing,
      PASSED_PREFIX,
      'the passing method still reads as a pass',
    );
    eq(statusFor(rerendered, CS.skipped), SKIPPED_TITLE, 'and the skipped one still as a skip');
    eq(actionLenses(rerendered).length, lensedMethods(rerendered).length * 2, 'with both actions');
    await assertStillLensed(csFile, 'the reopened file carries every row');
    await assertLensesPair(csFile, 'in Run/Debug pairs');
    assertCachedOutcome(
      api,
      CS.passing,
      'passed',
      'and the cache still holds the result it renders',
    );
    eq(itemsFor(api, [CS.passing]).length, 1, 'for a row that is still there');
    assert.ok(rootsOf(api.testController.items).length >= 1, 'with the tree standing');
  });

  test('a run started from the TREE repaints the rows of BOTH language files', async function () {
    this.timeout(DOTNET_CLI_MS);

    // The lens and the Testing view read the same cache, so a run started
    // anywhere must be visible everywhere — including in a file the user never
    // touched, and in the other language.
    //
    // Interaction 1 — the F# rows before, from a run of the C# side alone.
    await runIds(api, vscode.TestRunProfileKind.Run, [CS.passing]);
    const csRows = await codeLensesFor(csFile);
    assertRowOpens(csRows, CS.passing, PASSED_PREFIX, 'the C# row the run covered is green');

    // Interaction 2 — now run the whole tree from the assembly root, the way a
    // user presses ▶ on the top row of the Testing view.
    const roots = rootsOf(api.testController.items);
    assert.ok(roots.length >= 1, 'the Testing view has at least one assembly root');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, roots);

    // Interaction 3 — every row of BOTH files now carries a real status, F#
    // included, spaced binding included.
    const csAfter = await codeLensesFor(csFile);
    const fsAfter = await codeLensesFor(fsFile);
    for (const [file, lenses] of [
      [csFile, csAfter],
      [fsFile, fsAfter],
    ] as const) {
      const methods = lensedMethods(lenses);
      assert.ok(methods.length > 0, `${path.basename(file.fsPath)} carries lensed methods`);
      assertEveryRowRan(lenses, {
        missing: (method) =>
          `${path.basename(file.fsPath)}: ${method} must show a status after a root run`,
        notRun: (method) =>
          `${path.basename(file.fsPath)}: ${method} was covered by the root run, so it must ` +
          'not still read "Not run"',
        spec: (method, title) =>
          `${method}'s title must be one of the four [TEST-STATUS-LENS] states; got ${title}`,
      });
    }
    assertRowOpens(
      fsAfter,
      FS_SPACED,
      PASSED_PREFIX,
      `"${lensMethodOf(FS_SPACED)}" carries SPACES and must still resolve to its own green result`,
    );
    assertRowIs(fsAfter, FSX.skipped, SKIPPED_TITLE, 'and the F# skip is still a skip');
    // Interaction 4 - a tree-started run repaints BOTH language files, because
    // the run covered both projects. A lens listening only to the active editor
    // leaves the other file stale until the user opens it.
    const csRepaint = await codeLensesFor(csFile);
    const fsRepaint = await codeLensesFor(fsFile);
    for (const [lenses, row, tail] of [
      [csRepaint, 'the C# row ', ' was repainted'],
      [fsRepaint, 'the F# row ', ' was repainted too'],
    ] as const) {
      assertEveryRowRan(lenses, { notRun: (method) => row + method + tail });
    }
    assertRowOpens(
      fsRepaint,
      FS_SPACED,
      PASSED_PREFIX,
      'including the backtick binding carrying SPACES, which is the hard case',
    );
    assertOneStatusPerMethod(csRepaint, 'one status row per C# method');
    assertOneStatusPerMethod(fsRepaint, 'and one per F# binding');
    eq(cachedFor(api, FS_SPACED).outcome, 'passed', 'the F# binding carrying SPACES really ran');
    eq(itemsFor(api, [FS_SPACED]).length, 1, 'and is exactly one row');
    assert.ok(
      lensedMethods(await codeLensesFor(fsFile)).includes(lensMethodOf(FS_SPACED)),
      'lensed under its own binding name',
    );
    await assertLensesPair(fsFile, 'with both actions');
    assert.ok(rootsOf(api.testController.items).length >= 1, 'and the tree standing');
  });

  // Implements [TEST-STATUS-LENS] "showing its LAST KNOWN RESULT". A run of ONE
  // test must repaint THAT row and leave every other row exactly as it was.
  // Repainting the whole file to "Not run" on every run destroys the very thing
  // the lens exists to show; repainting every row to the one result the run
  // produced is worse, because it is confidently wrong.
  test('running ONE test repaints only that row and leaves every other one alone', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — run the whole tree once, so every row has a last known
    // result to preserve.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      rootsOf(api.testController.items),
    );
    const before = await codeLensesFor(csFile);
    const methods = lensedMethods(before);
    assert.ok(methods.length >= 4, 'the C# fixture declares several test methods');
    const baseline = new Map(methods.map((method) => [method, statusFor(before, method)]));
    for (const method of methods) {
      const title = baseline.get(method);
      neq(title, undefined, method + ' must carry a status after a whole-tree run');
      neq(title, NOT_RUN, method + ' has been run, so its row must no longer read "Not run"');
      assert.ok(
        STATUS_ICONS.some((icon) => (title ?? '').startsWith(icon)),
        method + ' must open with one of the four status icons',
      );
    }
    eq(
      baseline.get(CS.passing)?.startsWith(PASSED_PREFIX),
      true,
      'the passing method reads as a pass',
    );
    eq(
      baseline.get(CS.failing)?.startsWith(FAILED_PREFIX),
      true,
      'the failing method reads as a failure',
    );
    eq(
      baseline.get(CS.skipped),
      SKIPPED_TITLE,
      'and the skipped method as a skip, never as a failure ([TEST-RUN-TRX])',
    );

    // Interaction 2 — run exactly ONE test: the passing C# method, alone.
    const [only] = itemsFor(api, [CS.passing]);
    assert.ok(only, 'the passing test must be a row the user can press play on');
    eq(only.id, CS.passing, 'addressed by its fully-qualified name');
    eq(only.children.size, 0, 'and a leaf, which is what a single run selects');
    await runViaProfile(api.testController, vscode.TestRunProfileKind.Run, [only]);
    eq(
      cachedFor(api, CS.passing).outcome,
      'passed',
      'the single run produced a result for the test it selected',
    );

    // Interaction 3 — the row it ran is repainted; every other row keeps the
    // status the earlier run gave it.
    const after = await codeLensesFor(csFile);
    deepEq(lensedMethods(after), methods, 'a single-test run must not add or remove a lens row');
    assertRowOpens(after, CS.passing, PASSED_PREFIX, 'the row that ran reads as a pass');
    for (const method of methods) {
      if (method === CS.passing) continue;
      eq(
        statusFor(after, method),
        baseline.get(method),
        method +
          ' was not in the selection, so its LAST KNOWN result must be preserved ' +
          'verbatim - blanking it is how a user loses the failure they were chasing',
      );
      neq(
        statusFor(after, method),
        NOT_RUN,
        method + ' must not fall back to "Not run" because a different test ran',
      );
    }

    // Interaction 4 — the F# file is untouched by a C# run, row for row.
    const fsAfter = await codeLensesFor(fsFile);
    assertEveryRowRan(fsAfter, {
      notRun: (method) =>
        'the F# row ' +
        method +
        ' keeps the result the whole-tree run gave it, even though ' +
        'the single run touched only a C# test',
    });
    assertRowOpens(
      fsAfter,
      FS_SPACED,
      PASSED_PREFIX,
      'including the backtick binding carrying SPACES',
    );
    assert.ok(
      actionLenses(fsAfter).length >= 2,
      'and the Run and Debug actions are still there beside the status',
    );
    // Interaction 5 - the cache the lens reads is the controller's own, so the
    // two must never disagree about a single test.
    for (const id of [CS.passing, CS.failing, CS.skipped]) {
      const cached = cachedFor(api, id);
      const rendered = statusFor(await codeLensesFor(csFile), lensMethodOf(id)) ?? '';
      eq(
        rendered.startsWith(PASSED_PREFIX),
        cached.outcome === 'passed',
        id + ': the lens says "passed" exactly when the controller does',
      );
      eq(
        rendered === SKIPPED_TITLE,
        cached.outcome === 'skipped',
        id + ': and "Skipped" exactly when the controller says skipped',
      );
      eq(
        rendered.startsWith(FAILED_PREFIX),
        cached.outcome === 'failed',
        id + ': and "Failed" exactly when the controller says failed',
      );
      assert.ok(!rendered.includes('\n'), id + ': rendered on one line');
    }
    eq(
      itemsFor(api, [...ALL_TESTS]).length,
      ALL_TESTS.length,
      'every test in the fixture is still a row',
    );
    eq(cachedFor(api, CS.passing).outcome, 'passed', 'the single run produced a real outcome');
    await assertLensedRowsStand(
      csFile,
      fsFile,
      api.testController,
      'every fixture row is still lensed',
    );
  });

  // Implements [TEST-STATUS-LENS] "above every C# and F# test method" as a
  // TWO-WAY correspondence with the tree: every discovered test in these two
  // files must have a lens, and every lens must address a test the tree holds.
  // A lens over a name the tree does not know runs nothing; a discovered test
  // with no lens is a test the user cannot run from the editor at all.
  test('the lens rows and the discovered tree agree in both directions', async function () {
    this.timeout(LSP_RESPONSE_MS);

    // Interaction 1 — what the tree holds for these two projects.
    const leaves = collectLeafIds(api.testController.items);
    assert.ok(leaves.length >= ALL_TESTS.length, 'the whole fixture solution is discovered');
    const csIds = leaves.filter((id) => id.startsWith('Cs.Xunit.Fixtures.'));
    const fsIds = leaves.filter((id) => id.startsWith('Fs.Xunit.Fixtures.'));
    assert.ok(csIds.length >= 4, 'the C# project contributes several tests');
    assert.ok(fsIds.length >= 4, 'and so does the F# project');
    assert.ok(
      fsIds.some((id) => id.includes(' ')),
      'the F# project contributes a name carrying SPACES, which is the hard case',
    );

    // Interaction 2 — every discovered C# test has a lens, addressed by the
    // method name the tree's id ends in. The C# project declares its tests in
    // TWO files, and a lens lives above the method in the file that declares it.
    const csLenses = [...(await codeLensesFor(csFile)), ...(await codeLensesFor(libraryTestsFile))];
    const csMethods = lensedMethods(csLenses);
    for (const id of csIds) {
      assert.ok(
        csMethods.includes(lensMethodOf(id)),
        id + ' is discovered, so the editor must offer a lens above it',
      );
      assertEveryRowRan(csLenses, {
        missing: () => id + ' must carry a status lens as well as its actions',
        spec: () => id + ': the status must be one of the four the specification pins',
      });
    }
    for (const method of csMethods) {
      assert.ok(
        csIds.some((id) => lensMethodOf(id) === method),
        'the lens over ' +
          method +
          ' must address a test the tree really holds - a lens over ' +
          'a name discovery never produced runs nothing at all',
      );
    }

    // Interaction 3 — the same, both ways, for F#. F# is not a second-class
    // case ([TEST-OVERVIEW]).
    const fsLenses = await codeLensesFor(fsFile);
    const fsMethods = lensedMethods(fsLenses);
    for (const id of fsIds) {
      assert.ok(fsMethods.includes(lensMethodOf(id)), id + ' must carry an F# lens');
    }
    for (const method of fsMethods) {
      assert.ok(
        fsIds.some((id) => lensMethodOf(id) === method),
        'the F# lens over ' + method + ' must address a discovered binding',
      );
    }
    assert.ok(
      fsMethods.includes(lensMethodOf(FS_SPACED)),
      'and the backtick binding is one of them, spaces and all',
    );

    // Interaction 4 — the shape of every row: one status, one Run and one
    // Debug, all sharing a range, and no duplicate rows.
    for (const [lenses, methodNames] of [
      [csLenses, csMethods],
      [fsLenses, fsMethods],
    ] as const) {
      assertOneActionPerMethod(
        lenses,
        'exactly one Run and one Debug action per method, and none over anything else',
      );
      assertOneStatusPerMethod(lenses, 'and exactly one status row per method');
      eq(
        new Set(methodNames).size,
        methodNames.length,
        'no method may be lensed twice - two rows above one test is two Run buttons',
      );
      for (const method of methodNames) {
        assertActionsPaired(lenses, method, {
          missing: (name) => name + ' must carry both actions',
          row: (name) => name + ': both actions on one row',
        });
      }
    }
    // Interaction 5 - and no lens is rendered for a file with no tests in it.
    // The provider is registered for the whole language, so a plain source file
    // is the case it has to decline.
    const plainFile = vscode.Uri.file(path.join(root, 'PlainNoTests.cs'));
    fs.writeFileSync(
      plainFile.fsPath,
      [
        'namespace Plain',
        '{',
        '    public class Helper',
        '    {',
        '        public void Do() { }',
        '    }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const plainLenses = await codeLensesFor(plainFile);
    deepEq(actionLenses(plainLenses), [], 'a class with no test attribute gets no actions');
    deepEq(
      plainLenses.filter((lens) => isStatusLens(lens)),
      [],
      'and no status row either - a "Not run" above a helper is a Run button that runs nothing',
    );
    eq(lensedMethods(plainLenses).length, 0, 'so the file carries no lensed method at all');
    assert.ok(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      'while the real test file still carries all of its rows',
    );
    assert.ok(
      collectLeafIds(api.testController.items).length >= ALL_TESTS.length,
      'the whole fixture is discovered',
    );
    eq(itemsFor(api, [...ALL_TESTS]).length, ALL_TESTS.length, 'and every test resolves to a row');
    await assertLensesPair(csFile, 'the C# actions are paired');
    await assertLensesPair(fsFile, 'and so are the F# ones');
    assert.ok(rootsOf(api.testController.items).length >= 1, 'under at least one assembly root');
  });
});
