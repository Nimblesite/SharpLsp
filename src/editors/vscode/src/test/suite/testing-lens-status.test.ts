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
});
