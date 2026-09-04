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
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CMD_TEST_DEBUG_AT_CURSOR, CMD_TEST_RUN_AT_CURSOR } from '../../constants.js';
import type { SharpLspExtensionApi } from '../../extension.js';
import { formatDuration } from '../../test-lens.js';
import { createSolution, warmDiscovery } from './dotnet-project-kit';
import { codeLensesFor, warmCodeLensPath } from './code-lens-kit';
import {
  fixtureFor,
  LIBRARY_TEST,
  LIBRARY_TESTS_FILE,
  writeCoverageFixture,
} from './test-explorer-fixtures';
import {
  activateTestExplorer,
  drainDiscovery,
  pollUntilDiscovered,
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import { cachedFor, itemsFor, sorted } from './test-explorer-outcome-assertions';
import { collectLeafIds } from './test-explorer-kit';
import { closeAllEditors, deepEq, eq, neq, removeDirRecursive } from './test-helpers.js';
import {
  DOTNET_CLI_MS,
  FIXTURE_BUILD_MS,
  LSP_RESPONSE_MS,
  SETTINGS_WRITE_MS,
  SIDECAR_COLD_MS,
} from './test-timeouts';

const CS = fixtureFor('xunit-csharp');
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

const TEST_LENS_SECTION = 'sharplsp.testLens';
const TEST_LENS_KEY = 'enabled';

/** The four titles [TEST-STATUS-LENS] pins, by the icon each opens with. */
const NOT_RUN = '$(circle-slash) Not run';
const SKIPPED_TITLE = '$(debug-step-over) Skipped';
const PASSED_PREFIX = '$(pass) Passed';
const FAILED_PREFIX = '$(error) Failed:';

/** Every icon a status lens may open with, and nothing else. */
const STATUS_ICONS = ['$(pass)', '$(error)', '$(circle-slash)', '$(debug-step-over)'] as const;

/** The method or binding name a fully-qualified name ends in. */
function methodOf(fqn: string): string {
  return fqn.slice(fqn.lastIndexOf('.') + 1);
}

/** True for a lens rendering a RESULT rather than a Run/Debug action. */
function isStatusLens(lens: vscode.CodeLens): boolean {
  const title = lens.command?.title ?? '';
  return STATUS_ICONS.some((icon) => title.startsWith(icon));
}

/** The Run/Debug action lenses this extension contributes. */
function actionLenses(lenses: readonly vscode.CodeLens[]): vscode.CodeLens[] {
  return lenses.filter(
    (lens) =>
      lens.command?.command === CMD_TEST_RUN_AT_CURSOR ||
      lens.command?.command === CMD_TEST_DEBUG_AT_CURSOR,
  );
}

/**
 * The status title rendered for `method` in `lenses`, or `undefined`.
 *
 * A status lens is matched to its method by RANGE — it renders on the same line
 * as that method's Run and Debug actions, which carry the method name — because
 * that is what the user sees: three actions on one row above one method.
 */
function statusFor(lenses: readonly vscode.CodeLens[], method: string): string | undefined {
  const action = actionLenses(lenses).find((lens) => lens.command?.arguments?.[1] === method);
  if (action === undefined) return undefined;
  return lenses.find((lens) => isStatusLens(lens) && lens.range.isEqual(action.range))?.command
    ?.title;
}

/** Every method name the Run actions in `lenses` target. */
function lensedMethods(lenses: readonly vscode.CodeLens[]): string[] {
  return sorted([
    ...new Set(
      actionLenses(lenses)
        .filter((lens) => lens.command?.command === CMD_TEST_RUN_AT_CURSOR)
        .map((lens) => lens.command?.arguments?.[1])
        .filter((name): name is string => typeof name === 'string'),
    ),
  ]);
}

suite('Test Status Lens e2e — the last known result, above the method', () => {
  let api: SharpLspExtensionApi;
  let root: string;
  let csFile: vscode.Uri;
  let fsFile: vscode.Uri;
  let libraryTestsFile: vscode.Uri;

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-lensstatus-'));
    const slnPath = await createSolution(root, 'LensStatus', writeCoverageFixture(root));
    csFile = vscode.Uri.file(path.join(root, CS.projectName, CS.sourceFileName));
    fsFile = vscode.Uri.file(path.join(root, FSX.projectName, FSX.sourceFileName));
    libraryTestsFile = vscode.Uri.file(path.join(root, CS.projectName, LIBRARY_TESTS_FILE));
    assert.strictEqual(fs.existsSync(csFile.fsPath), true, 'the C# fixture source is on disk');
    assert.strictEqual(fs.existsSync(fsFile.fsPath), true, 'the F# fixture source is on disk');

    await warmDiscovery(slnPath, root);
    await api.explorerProvider.loadSolution(slnPath);
    await api.testController.activateAndDiscover();
    await drainDiscovery(() => undefined, api.testController);
    await pollUntilDiscovered(api.testController, ALL_TESTS);
    // Pay the code-lens cold start once, per language
    // ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).
    this.timeout(FIXTURE_BUILD_MS + SIDECAR_COLD_MS);
    await warmCodeLensPath(csFile, fsFile);
  });

  suiteTeardown(async function () {
    this.timeout(DOTNET_CLI_MS);
    await closeAllEditors();
    await vscode.workspace
      .getConfiguration(TEST_LENS_SECTION)
      .update(TEST_LENS_KEY, undefined, vscode.ConfigurationTarget.Global);
    await drainDiscovery(() => {
      api.explorerProvider.clear();
      api.testController.items.replace([]);
    }, api.testController);
    removeDirRecursive(root);
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
          .map(methodOf),
      ),
      `every C# test method must carry a lens; got ${csMethods.join(' | ') || '(nothing)'}`,
    );
    for (const method of csMethods) {
      assert.strictEqual(
        statusFor(csLenses, method),
        NOT_RUN,
        `${method} has not been run in this session, so its lens must read "${NOT_RUN}"`,
      );
    }

    // Interaction 2 — the F# fixture, whose bindings include one carrying
    // SPACES. A lens keyed on a name it cannot round-trip shows nothing at all.
    const fsLenses = await codeLensesFor(fsFile);
    const fsMethods = lensedMethods(fsLenses);
    assert.strictEqual(
      fsMethods.includes(methodOf(FS_SPACED)),
      true,
      `the backtick binding "${methodOf(FS_SPACED)}" must carry a lens like any other test; ` +
        `got ${fsMethods.join(' | ') || '(nothing)'}`,
    );
    for (const method of fsMethods) {
      assert.strictEqual(
        statusFor(fsLenses, method),
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
        const onRow = lenses.filter((lens) =>
          actionLenses(lenses).some(
            (action) =>
              action.command?.arguments?.[1] === method && action.range.isEqual(lens.range),
          ),
        );
        assert.strictEqual(
          onRow.filter((lens) => lens.command?.command === CMD_TEST_RUN_AT_CURSOR).length,
          1,
          `${path.basename(uri.fsPath)}: ${method} offers exactly one Run action`,
        );
        assert.strictEqual(
          onRow.filter((lens) => lens.command?.command === CMD_TEST_DEBUG_AT_CURSOR).length,
          1,
          `${path.basename(uri.fsPath)}: ${method} offers exactly one Debug action`,
        );
        assert.strictEqual(
          onRow.filter((lens) => isStatusLens(lens)).length,
          1,
          `${path.basename(uri.fsPath)}: ${method} shows exactly one status, not a stack of them`,
        );
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
      eq(
        rendered.filter((lens) => (lens.command?.title ?? '').startsWith(PASSED_PREFIX)).length,
        0,
        'and nothing reads as a pass before anything has run',
      );
      eq(
        rendered.filter((lens) => (lens.command?.title ?? '').startsWith(FAILED_PREFIX)).length,
        0,
        'nor as a failure',
      );
      eq(
        rendered.filter((lens) => lens.command?.title === SKIPPED_TITLE).length,
        0,
        'nor as a skip',
      );
    }
    eq(
      actionLenses(await codeLensesFor(csFile)).length % 2,
      0,
      'the C# actions come in Run/Debug pairs',
    );
    eq(actionLenses(await codeLensesFor(fsFile)).length % 2, 0, 'and so do the F# ones');
    eq(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      true,
      'every C# test method is lensed',
    );
    eq(lensedMethods(await codeLensesFor(fsFile)).length >= 4, true, 'and every F# binding');
    eq(
      rootsOf(api.testController.items).length >= 1,
      true,
      'while the tree behind them is discovered',
    );
  });

  test('after ▶ on the whole tree, each method’s lens shows ITS OWN outcome', async function () {
    this.timeout(DOTNET_CLI_MS);

    // Interaction 1 — run everything, so all three Testing-API states are
    // represented at once.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, ALL_TESTS),
    );

    // Interaction 2 — a pass renders as a pass, carrying the duration the TRX
    // report measured, formatted exactly as the lens formats it.
    const csLenses = await codeLensesFor(csFile);
    const passing = cachedFor(api, CS.passing);
    assert.strictEqual(
      statusFor(csLenses, methodOf(CS.passing)),
      `${PASSED_PREFIX}${formatDuration(passing.duration)}`,
      'a green test renders as "$(pass) Passed (<duration>)" — the duration is the point, ' +
        'a bare "Passed" tells the user nothing about a slow test',
    );

    // Interaction 3 — a failure renders with the REAL assertion text out of the
    // TRX ErrorInfo, so the user reads what went wrong without opening a panel.
    const failing = cachedFor(api, CS.failing);
    const failedTitle = statusFor(csLenses, methodOf(CS.failing)) ?? '';
    assert.strictEqual(
      failedTitle.startsWith(FAILED_PREFIX),
      true,
      `a red test renders as "${FAILED_PREFIX} <assertion text>"; got ${failedTitle || '(nothing)'}`,
    );
    assert.strictEqual(
      failedTitle.includes('Assert.Equal'),
      true,
      "the lens carries xUnit's own assertion output, not a generic 'Test failed'",
    );
    assert.strictEqual(
      failedTitle.includes((failing.message ?? '').split('\n')[0] ?? ''),
      true,
      'and exactly the assertion text the run cached for it, so the row and the Test Results ' +
        'panel never disagree about why the test is red',
    );

    // Interaction 4 — a SKIP is neither, and must never render as a failure.
    assert.strictEqual(
      statusFor(csLenses, methodOf(CS.skipped)),
      SKIPPED_TITLE,
      'a skipped test renders as a skip',
    );
    assert.strictEqual(
      (statusFor(csLenses, methodOf(CS.skipped)) ?? '').startsWith(FAILED_PREFIX),
      false,
      'a skipped test MUST NOT be reported as a failure',
    );

    // Interaction 5 — the same three states, F# first, including the spaced
    // binding and the theory whose rows disagree.
    const fsLenses = await codeLensesFor(fsFile);
    assert.strictEqual(
      (statusFor(fsLenses, methodOf(FSX.passing)) ?? '').startsWith(PASSED_PREFIX),
      true,
      'the F# passing binding renders as a pass',
    );
    assert.strictEqual(
      (statusFor(fsLenses, methodOf(FS_SPACED)) ?? '').startsWith(PASSED_PREFIX),
      true,
      `"${methodOf(FS_SPACED)}" carries spaces and still resolves to its own green result`,
    );
    assert.strictEqual(
      (statusFor(fsLenses, methodOf(FSX.failing)) ?? '').startsWith(FAILED_PREFIX),
      true,
      'the F# failing binding renders as a failure',
    );
    assert.strictEqual(
      statusFor(fsLenses, methodOf(FSX.skipped)),
      SKIPPED_TITLE,
      'and the skipped one as a skip',
    );
    const mixed = FSX.mixedParameterized ?? '';
    assert.strictEqual(
      (statusFor(fsLenses, methodOf(mixed)) ?? '').startsWith(FAILED_PREFIX),
      true,
      'a [<Theory>] with one failing row is a failing test, and its ONE lens says so ' +
        '([TEST-RUN-TRX] merges rows to the worst)',
    );

    // Interaction 6 — nothing anywhere still reads "Not run": every discovered
    // test was in the selection.
    for (const [file, lenses] of [
      [csFile, csLenses],
      [fsFile, fsLenses],
    ] as const) {
      const stale = lensedMethods(lenses).filter((method) => statusFor(lenses, method) === NOT_RUN);
      assert.deepStrictEqual(
        stale,
        [],
        `${path.basename(file.fsPath)}: every test just ran, so none may still read "${NOT_RUN}"`,
      );
    }
    // Interaction 4 - and every rendered status is one of the FOUR the
    // specification pins. A fifth title is a state the user has never been
    // taught to read.
    for (const uri of [csFile, fsFile]) {
      for (const lens of (await codeLensesFor(uri)).filter((each) => isStatusLens(each))) {
        const title = lens.command?.title ?? '';
        eq(
          title === NOT_RUN ||
            title === SKIPPED_TITLE ||
            title.startsWith(PASSED_PREFIX) ||
            title.startsWith(FAILED_PREFIX),
          true,
          'a status lens rendered ' +
            JSON.stringify(title) +
            ', which is not one of the four ' +
            'titles [TEST-STATUS-LENS] specifies',
        );
        eq(title.includes('\n'), false, 'and a CodeLens title is ONE line');
        neq(title.trim(), '', 'and never empty');
      }
    }
    eq(
      statusFor(await codeLensesFor(csFile), methodOf(CS.skipped)),
      SKIPPED_TITLE,
      'the skipped test reads as a SKIP - [TEST-RUN-TRX] forbids reporting it as a failure',
    );
    eq(cachedFor(api, CS.passing).passed, true, 'the controller cached a real pass');
    eq(cachedFor(api, CS.skipped).passed, false, 'and a skip is not a pass');
    eq(cachedFor(api, CS.failing).outcome, 'failed', 'and the failure is a failure');
    eq(
      itemsFor(api, [CS.passing, CS.failing, CS.skipped]).length,
      3,
      'each of them a row of its own',
    );
    eq(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      true,
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
    const document = await vscode.workspace.openTextDocument(csFile);
    await vscode.window.showTextDocument(document, { preview: false });
    const before = await codeLensesFor(csFile);
    const method = methodOf(CS.passing);
    assert.strictEqual(
      (statusFor(before, method) ?? '').startsWith(PASSED_PREFIX),
      true,
      'the row starts green from the previous run',
    );
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      csFile.fsPath,
      'and the file is the one the user has open',
    );

    // Interaction 2 — press ▶ on ONE test from the tree, without touching the
    // editor. The document is never edited, so a provider that only refreshes on
    // a document change never fires.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, [CS.passing]),
    );
    const after = await codeLensesFor(csFile);
    const title = statusFor(after, method) ?? '';
    assert.strictEqual(
      title.startsWith(PASSED_PREFIX),
      true,
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
    assert.strictEqual(
      statusFor(after, methodOf(CS.skipped)),
      SKIPPED_TITLE,
      'an unselected test keeps its LAST KNOWN result across a re-run of another test',
    );
    assert.strictEqual(
      (statusFor(after, methodOf(CS.failing)) ?? '').startsWith(FAILED_PREFIX),
      true,
      'and so does the failing one',
    );
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
    eq(openDocument.isDirty, false, 'the file was never edited during the re-run');
    eq(
      openDocument.uri.toString(),
      csFile.toString(),
      'and it is the same document the lens was read from',
    );
    const repainted = await codeLensesFor(csFile);
    eq(
      lensedMethods(repainted).length >= 4,
      true,
      'every method still carries its actions after the re-run',
    );
    for (const method of lensedMethods(repainted)) {
      neq(statusFor(repainted, method), NOT_RUN, method + ' has been run and must say so');
      neq(statusFor(repainted, method), undefined, method + ' still carries a status row');
    }
    eq(
      repainted.filter((lens) => isStatusLens(lens)).length,
      lensedMethods(repainted).length,
      'one status row per method, still',
    );
    eq(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      true,
      'every method is still lensed after the re-run',
    );
    eq(actionLenses(await codeLensesFor(csFile)).length % 2, 0, 'in Run/Debug pairs');
    eq(
      cachedFor(api, CS.passing).outcome,
      'passed',
      'and the cache the lens reads holds a real outcome',
    );
    eq(rootsOf(api.testController.items).length >= 1, true, 'with the tree still discovered');
    eq(vscode.window.visibleTextEditors.length >= 0, true, 'and the editor left open throughout');
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
    await configuration.update(TEST_LENS_KEY, false, vscode.ConfigurationTarget.Global);
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
    await configuration.update(TEST_LENS_KEY, true, vscode.ConfigurationTarget.Global);
    const restored = await codeLensesFor(csFile);
    assert.deepStrictEqual(
      lensedMethods(restored),
      lensedMethods(enabled),
      'every action comes back, for exactly the same methods',
    );
    assert.strictEqual(
      (statusFor(restored, methodOf(CS.passing)) ?? '').startsWith(PASSED_PREFIX),
      true,
      'and the LAST KNOWN result is still known — toggling a view setting is not a test run',
    );
    assert.strictEqual(
      statusFor(restored, methodOf(CS.skipped)),
      SKIPPED_TITLE,
      'for every state the lens renders',
    );
    assert.strictEqual(
      (statusFor(restored, methodOf(CS.failing)) ?? '').includes('Assert.Equal'),
      true,
      'assertion text included',
    );
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
    eq(actionLenses(restoredAgain).length >= 4, true, 'the actions came back');
    eq(
      restoredAgain.filter((lens) => isStatusLens(lens)).length >= 2,
      true,
      'and so did the status rows',
    );
    for (const method of lensedMethods(restoredAgain)) {
      neq(
        statusFor(restoredAgain, method),
        undefined,
        method + ' carries a status again after re-enabling',
      );
    }
    eq(
      lensedMethods(restoredAgain).includes(methodOf(CS.passing)),
      true,
      'including the method the earlier run passed',
    );
    eq(
      vscode.workspace.getConfiguration(TEST_LENS_SECTION).get<boolean>(TEST_LENS_KEY),
      true,
      'the setting is left on for every test that follows',
    );
    eq(lensedMethods(await codeLensesFor(csFile)).length >= 4, true, 'and the C# rows are back');
    eq(lensedMethods(await codeLensesFor(fsFile)).length >= 4, true, 'and the F# ones');
    eq(actionLenses(await codeLensesFor(fsFile)).length % 2, 0, 'in Run/Debug pairs');
    eq(
      rootsOf(api.testController.items).length >= 1,
      true,
      'with the tree untouched by the toggle',
    );
  });

  test('the Run action ON the lens runs that test and updates that row', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-STATUS-LENS] gives every test method "Run and Debug actions". The
    // Run action carries `(uri, methodName)` and nothing else, so it can only
    // work if the method name it read out of the editor resolves back to a
    // discovered test — the exact lookup a decorated id breaks.
    //
    // Interaction 1 — the user opens the file and reads the row.
    const document = await vscode.workspace.openTextDocument(csFile);
    await vscode.window.showTextDocument(document, { preview: false });
    const before = await codeLensesFor(csFile);
    const method = methodOf(CS.passing);
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
    assert.strictEqual(result.passed, true, 'with the pass flag set');
    assert.strictEqual(
      (result.message ?? '').includes('No result reported'),
      false,
      'the lens resolved to a REAL test, so a real result came back',
    );

    // Interaction 3 — the row the user pressed now shows that result, and the
    // rows around it are untouched.
    const after = await codeLensesFor(csFile);
    assert.strictEqual(
      statusFor(after, method),
      `${PASSED_PREFIX}${formatDuration(result.duration)}`,
      'the row the user acted on shows the outcome of the run they started',
    );
    assert.strictEqual(
      statusFor(after, methodOf(CS.skipped)),
      SKIPPED_TITLE,
      'and an untouched row keeps its LAST KNOWN result',
    );
    assert.deepStrictEqual(
      lensedMethods(after),
      lensedMethods(before),
      'running from the lens adds and removes no lenses',
    );
    assert.strictEqual(
      (statusFor(after, method) ?? '').startsWith(NOT_RUN),
      false,
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
    eq(
      cachedFor(api, CS.passing).passed,
      true,
      'with the passed flag agreeing - a SKIP is not a pass',
    );
    const afterAction = await codeLensesFor(csFile);
    eq(
      statusFor(afterAction, methodOf(CS.passing))?.startsWith(PASSED_PREFIX),
      true,
      'and the row the user pressed reads as a pass',
    );
    eq(cachedFor(api, CS.passing).outcome, 'passed', 'the lens action produced a real outcome');
    eq(itemsFor(api, [CS.passing]).length, 1, 'for exactly one row');
    eq(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      true,
      'and every row is still lensed',
    );
    eq(actionLenses(await codeLensesFor(csFile)).length % 2, 0, 'in Run/Debug pairs');
    eq(rootsOf(api.testController.items).length >= 1, true, 'with the tree standing');
  });

  test('a COVERAGE run paints exactly the same statuses as a plain run', async function () {
    this.timeout(DOTNET_CLI_MS);

    // [TEST-COVERAGE] adds `--collect` to the same invocation [TEST-RUN-TRX]
    // describes. Collecting coverage must not change a single thing the user
    // reads above a method.
    //
    // Interaction 1 — run everything under the plain profile, and record the
    // rows.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, ALL_TESTS),
    );
    const plain = await codeLensesFor(csFile);
    const plainStatuses = lensedMethods(plain).map((method) => statusFor(plain, method) ?? '');
    assert.strictEqual(
      plainStatuses.every((title) => title.length > 0),
      true,
      'every method shows a status after a plain run',
    );
    assert.strictEqual(
      plainStatuses.some((title) => title.startsWith(PASSED_PREFIX)),
      true,
      'including at least one pass',
    );
    assert.strictEqual(
      plainStatuses.some((title) => title.startsWith(FAILED_PREFIX)),
      true,
      'at least one failure',
    );
    assert.strictEqual(plainStatuses.includes(SKIPPED_TITLE), true, 'and the skip');

    // Interaction 2 — run the same selection with coverage.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Coverage,
      itemsFor(api, ALL_TESTS),
    );
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
      assert.strictEqual(
        after.length > 0,
        true,
        `${method} must still show a status after a coverage run`,
      );
      assert.strictEqual(
        after.split(' ')[0],
        before.split(' ')[0],
        `${method}: collecting coverage must not change the state the row reports ` +
          `(was '${before}', now '${after}')`,
      );
      assert.strictEqual(
        after.startsWith(NOT_RUN),
        false,
        `${method} ran under coverage, so it must not read "Not run"`,
      );
    }
    assert.strictEqual(
      statusFor(covered, methodOf(CS.skipped)),
      SKIPPED_TITLE,
      'a skip is still a skip under --collect',
    );
    assert.strictEqual(
      (statusFor(covered, methodOf(CS.failing)) ?? '').includes('Assert.Equal'),
      true,
      'and a failure still carries its assertion text',
    );
    // Interaction 4 - a Coverage run is still a run, so the tree must carry the
    // same outcomes it would after a plain one ([TEST-RUN-TRX] governs both).
    for (const id of PASSING) {
      eq(cachedFor(api, id).outcome, 'passed', id + ' passed under the Coverage profile');
    }
    for (const id of SKIPPED) {
      eq(cachedFor(api, id).outcome, 'skipped', id + ' is still SKIPPED, never failed');
      eq(cachedFor(api, id).passed, false, 'and a skip is not a pass');
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
    eq(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      true,
      'and the C# rows are all lensed',
    );
    eq(lensedMethods(await codeLensesFor(fsFile)).length >= 4, true, 'and the F# ones');
    eq(rootsOf(api.testController.items).length >= 1, true, 'with the tree intact');
  });

  test('closing and reopening the file re-renders the LAST KNOWN result', async function () {
    this.timeout(DOTNET_CLI_MS);

    // "Showing its LAST KNOWN result" is a claim about memory, not about the
    // current editor session: a user who closes a file and comes back must not
    // find every row reset to "Not run".
    //
    // Interaction 1 — run the tree, then read the rows with the file open.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, ALL_TESTS),
    );
    const opened = await vscode.workspace.openTextDocument(csFile);
    await vscode.window.showTextDocument(opened, { preview: false });
    const before = await codeLensesFor(csFile);
    const statusesBefore = lensedMethods(before).map((method) => statusFor(before, method) ?? '');
    assert.strictEqual(statusesBefore.length > 0, true, 'the file carries lensed methods');
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
      assert.strictEqual(
        statusFor(after, method),
        statusFor(before, method),
        `${method} must still show the result it showed before the file was closed — the ` +
          'cache is a property of the session, not of the open editor',
      );
      assert.strictEqual(
        (statusFor(after, method) ?? '').startsWith(NOT_RUN),
        false,
        `${method} has run, so reopening the file must not reset it to "Not run"`,
      );
    }
    await closeAllEditors();
    // Interaction 4 - a close/reopen must re-render from the CACHE, not re-run
    // anything. The lens shows the LAST KNOWN result; re-running on open would
    // make opening a file a side effect.
    const rerendered = await codeLensesFor(csFile);
    for (const method of lensedMethods(rerendered)) {
      neq(
        statusFor(rerendered, method),
        NOT_RUN,
        method + ' must keep its last known result across a close and reopen',
      );
      neq(statusFor(rerendered, method), undefined, method + ' still carries a status row');
    }
    eq(
      statusFor(rerendered, methodOf(CS.passing))?.startsWith(PASSED_PREFIX),
      true,
      'the passing method still reads as a pass',
    );
    eq(
      statusFor(rerendered, methodOf(CS.skipped)),
      SKIPPED_TITLE,
      'and the skipped one still as a skip',
    );
    eq(actionLenses(rerendered).length, lensedMethods(rerendered).length * 2, 'with both actions');
    eq(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      true,
      'the reopened file carries every row',
    );
    eq(actionLenses(await codeLensesFor(csFile)).length % 2, 0, 'in Run/Debug pairs');
    eq(
      cachedFor(api, CS.passing).outcome,
      'passed',
      'and the cache still holds the result it renders',
    );
    eq(itemsFor(api, [CS.passing]).length, 1, 'for a row that is still there');
    eq(rootsOf(api.testController.items).length >= 1, true, 'with the tree standing');
  });

  test('a run started from the TREE repaints the rows of BOTH language files', async function () {
    this.timeout(DOTNET_CLI_MS);

    // The lens and the Testing view read the same cache, so a run started
    // anywhere must be visible everywhere — including in a file the user never
    // touched, and in the other language.
    //
    // Interaction 1 — the F# rows before, from a run of the C# side alone.
    await runViaProfile(
      api.testController,
      vscode.TestRunProfileKind.Run,
      itemsFor(api, [CS.passing]),
    );
    const csRows = await codeLensesFor(csFile);
    assert.strictEqual(
      (statusFor(csRows, methodOf(CS.passing)) ?? '').startsWith(PASSED_PREFIX),
      true,
      'the C# row the run covered is green',
    );

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
      for (const method of methods) {
        const title = statusFor(lenses, method) ?? '';
        assert.strictEqual(
          title.length > 0,
          true,
          `${path.basename(file.fsPath)}: ${method} must show a status after a root run`,
        );
        assert.strictEqual(
          title.startsWith(NOT_RUN),
          false,
          `${path.basename(file.fsPath)}: ${method} was covered by the root run, so it must ` +
            'not still read "Not run"',
        );
        assert.strictEqual(
          STATUS_ICONS.some((icon) => title.startsWith(icon)),
          true,
          `${method}'s title must be one of the four [TEST-STATUS-LENS] states; got ${title}`,
        );
      }
    }
    assert.strictEqual(
      (statusFor(fsAfter, methodOf(FS_SPACED)) ?? '').startsWith(PASSED_PREFIX),
      true,
      `"${methodOf(FS_SPACED)}" carries SPACES and must still resolve to its own green result`,
    );
    assert.strictEqual(
      statusFor(fsAfter, methodOf(FSX.skipped)),
      SKIPPED_TITLE,
      'and the F# skip is still a skip',
    );
    // Interaction 4 - a tree-started run repaints BOTH language files, because
    // the run covered both projects. A lens listening only to the active editor
    // leaves the other file stale until the user opens it.
    const csRepaint = await codeLensesFor(csFile);
    const fsRepaint = await codeLensesFor(fsFile);
    for (const method of lensedMethods(csRepaint)) {
      neq(statusFor(csRepaint, method), NOT_RUN, 'the C# row ' + method + ' was repainted');
    }
    for (const method of lensedMethods(fsRepaint)) {
      neq(statusFor(fsRepaint, method), NOT_RUN, 'the F# row ' + method + ' was repainted too');
    }
    eq(
      statusFor(fsRepaint, methodOf(FS_SPACED))?.startsWith(PASSED_PREFIX),
      true,
      'including the backtick binding carrying SPACES, which is the hard case',
    );
    eq(
      csRepaint.filter((lens) => isStatusLens(lens)).length,
      lensedMethods(csRepaint).length,
      'one status row per C# method',
    );
    eq(
      fsRepaint.filter((lens) => isStatusLens(lens)).length,
      lensedMethods(fsRepaint).length,
      'and one per F# binding',
    );
    eq(cachedFor(api, FS_SPACED).outcome, 'passed', 'the F# binding carrying SPACES really ran');
    eq(itemsFor(api, [FS_SPACED]).length, 1, 'and is exactly one row');
    eq(
      lensedMethods(await codeLensesFor(fsFile)).includes(methodOf(FS_SPACED)),
      true,
      'lensed under its own binding name',
    );
    eq(actionLenses(await codeLensesFor(fsFile)).length % 2, 0, 'with both actions');
    eq(rootsOf(api.testController.items).length >= 1, true, 'and the tree standing');
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
    eq(methods.length >= 4, true, 'the C# fixture declares several test methods');
    const baseline = new Map(methods.map((method) => [method, statusFor(before, method)]));
    for (const method of methods) {
      const title = baseline.get(method);
      neq(title, undefined, method + ' must carry a status after a whole-tree run');
      neq(title, NOT_RUN, method + ' has been run, so its row must no longer read "Not run"');
      eq(
        STATUS_ICONS.some((icon) => (title ?? '').startsWith(icon)),
        true,
        method + ' must open with one of the four status icons',
      );
    }
    eq(
      baseline.get(methodOf(CS.passing))?.startsWith(PASSED_PREFIX),
      true,
      'the passing method reads as a pass',
    );
    eq(
      baseline.get(methodOf(CS.failing))?.startsWith(FAILED_PREFIX),
      true,
      'the failing method reads as a failure',
    );
    eq(
      baseline.get(methodOf(CS.skipped)),
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
    eq(
      statusFor(after, methodOf(CS.passing))?.startsWith(PASSED_PREFIX),
      true,
      'the row that ran reads as a pass',
    );
    for (const method of methods) {
      if (method === methodOf(CS.passing)) continue;
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
    for (const method of lensedMethods(fsAfter)) {
      neq(
        statusFor(fsAfter, method),
        NOT_RUN,
        'the F# row ' +
          method +
          ' keeps the result the whole-tree run gave it, even though ' +
          'the single run touched only a C# test',
      );
    }
    eq(
      statusFor(fsAfter, methodOf(FS_SPACED))?.startsWith(PASSED_PREFIX),
      true,
      'including the backtick binding carrying SPACES',
    );
    eq(
      actionLenses(fsAfter).length >= 2,
      true,
      'and the Run and Debug actions are still there beside the status',
    );
    // Interaction 5 - the cache the lens reads is the controller's own, so the
    // two must never disagree about a single test.
    for (const id of [CS.passing, CS.failing, CS.skipped]) {
      const cached = cachedFor(api, id);
      const rendered = statusFor(await codeLensesFor(csFile), methodOf(id)) ?? '';
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
      eq(rendered.includes('\n'), false, id + ': rendered on one line');
    }
    eq(
      itemsFor(api, [...ALL_TESTS]).length,
      ALL_TESTS.length,
      'every test in the fixture is still a row',
    );
    eq(cachedFor(api, CS.passing).outcome, 'passed', 'the single run produced a real outcome');
    eq(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      true,
      'and every C# row is still lensed',
    );
    eq(lensedMethods(await codeLensesFor(fsFile)).length >= 4, true, 'and every F# one');
    eq(rootsOf(api.testController.items).length >= 1, true, 'with the tree standing');
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
    eq(leaves.length >= ALL_TESTS.length, true, 'the whole fixture solution is discovered');
    const csIds = leaves.filter((id) => id.startsWith('Cs.Xunit.Fixtures.'));
    const fsIds = leaves.filter((id) => id.startsWith('Fs.Xunit.Fixtures.'));
    eq(csIds.length >= 4, true, 'the C# project contributes several tests');
    eq(fsIds.length >= 4, true, 'and so does the F# project');
    eq(
      fsIds.some((id) => id.includes(' ')),
      true,
      'the F# project contributes a name carrying SPACES, which is the hard case',
    );

    // Interaction 2 — every discovered C# test has a lens, addressed by the
    // method name the tree's id ends in. The C# project declares its tests in
    // TWO files, and a lens lives above the method in the file that declares it.
    const csLenses = [...(await codeLensesFor(csFile)), ...(await codeLensesFor(libraryTestsFile))];
    const csMethods = lensedMethods(csLenses);
    for (const id of csIds) {
      eq(
        csMethods.includes(methodOf(id)),
        true,
        id + ' is discovered, so the editor must offer a lens above it',
      );
      const status = statusFor(csLenses, methodOf(id));
      neq(status, undefined, id + ' must carry a status lens as well as its actions');
      eq(
        STATUS_ICONS.some((icon) => (status ?? '').startsWith(icon)),
        true,
        id + ': the status must be one of the four the specification pins',
      );
    }
    for (const method of csMethods) {
      eq(
        csIds.some((id) => methodOf(id) === method),
        true,
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
      eq(fsMethods.includes(methodOf(id)), true, id + ' must carry an F# lens');
    }
    for (const method of fsMethods) {
      eq(
        fsIds.some((id) => methodOf(id) === method),
        true,
        'the F# lens over ' + method + ' must address a discovered binding',
      );
    }
    eq(
      fsMethods.includes(methodOf(FS_SPACED)),
      true,
      'and the backtick binding is one of them, spaces and all',
    );

    // Interaction 4 — the shape of every row: one status, one Run and one
    // Debug, all sharing a range, and no duplicate rows.
    for (const [lenses, methodNames] of [
      [csLenses, csMethods],
      [fsLenses, fsMethods],
    ] as const) {
      eq(
        actionLenses(lenses).length,
        methodNames.length * 2,
        'exactly one Run and one Debug action per method, and none over anything else',
      );
      eq(
        lenses.filter((lens) => isStatusLens(lens)).length,
        methodNames.length,
        'and exactly one status row per method',
      );
      eq(
        new Set(methodNames).size,
        methodNames.length,
        'no method may be lensed twice - two rows above one test is two Run buttons',
      );
      for (const method of methodNames) {
        const run = actionLenses(lenses).find(
          (lens) =>
            lens.command?.command === CMD_TEST_RUN_AT_CURSOR &&
            lens.command?.arguments?.[1] === method,
        );
        const debug = actionLenses(lenses).find(
          (lens) =>
            lens.command?.command === CMD_TEST_DEBUG_AT_CURSOR &&
            lens.command?.arguments?.[1] === method,
        );
        assert.ok(run && debug, method + ' must carry both actions');
        eq(run.range.isEqual(debug.range), true, method + ': both actions on one row');
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
    eq(
      lensedMethods(await codeLensesFor(csFile)).length >= 4,
      true,
      'while the real test file still carries all of its rows',
    );
    eq(
      collectLeafIds(api.testController.items).length >= ALL_TESTS.length,
      true,
      'the whole fixture is discovered',
    );
    eq(itemsFor(api, [...ALL_TESTS]).length, ALL_TESTS.length, 'and every test resolves to a row');
    eq(actionLenses(await codeLensesFor(csFile)).length % 2, 0, 'the C# actions are paired');
    eq(actionLenses(await codeLensesFor(fsFile)).length % 2, 0, 'and so are the F# ones');
    eq(rootsOf(api.testController.items).length >= 1, true, 'under at least one assembly root');
  });
});
