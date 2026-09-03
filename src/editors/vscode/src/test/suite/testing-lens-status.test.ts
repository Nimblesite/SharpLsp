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
import { fixtureFor, LIBRARY_TEST, writeCoverageFixture } from './test-explorer-fixtures';
import {
  activateTestExplorer,
  drainDiscovery,
  pollUntilDiscovered,
  rootsOf,
  runViaProfile,
} from './test-explorer-kit';
import { cachedFor, itemsFor, sorted } from './test-explorer-outcome-assertions';
import { closeAllEditors, removeDirRecursive } from './test-helpers.js';
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

  suiteSetup(async function () {
    this.timeout(FIXTURE_BUILD_MS);
    api = await activateTestExplorer();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-lensstatus-'));
    const slnPath = await createSolution(root, 'LensStatus', writeCoverageFixture(root));
    csFile = vscode.Uri.file(path.join(root, CS.projectName, CS.sourceFileName));
    fsFile = vscode.Uri.file(path.join(root, FSX.projectName, FSX.sourceFileName));
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
  });
});
