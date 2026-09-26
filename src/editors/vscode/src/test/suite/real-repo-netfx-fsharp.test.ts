// Real-world .NET Framework corpus, F# FIRST: kekyo/GitReader, pinned.
//
// GitReader is the F# shape [NETFX] exists for. Its F# library is built for
// four .NET Framework versions, two .NET Standard versions and eleven .NET
// ones; its F# NUnit test project for net48 and three .NET versions; and that
// test project's helpers really do differ per framework — the `#if NETFRAMEWORK`
// branch calls `Process.WaitForExit` and `File.WriteAllText`, the `#else` branch
// the .NET-only `WaitForExitAsync` and `File.WriteAllTextAsync`. Every framework
// below is read off the pinned project files, and every runtime off this agent.
//
// Covers [NETFX-CORPUS] through [NETFX-CONTEXT], [NETFX-PROJECTS-FSHARP],
// [NETFX-SCOPE], [NETFX-TEST-DISCOVERY], [NETFX-TEST-RESULTS] and
// [NETFX-TEST-PROFILES].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  SELECT_TARGET_FRAMEWORK,
  assertBranches,
  assertContext,
  assertStatusShows,
  declared,
  frameworkContextOf,
  pickFramework,
  underFramework,
} from './netfx-context-kit';
import {
  assertDeclaresFamilies,
  assertFrameworkProfiles,
  assertFrameworkRoot,
  assertTaggedFor,
  classRowOf,
  frameworkProfilesOf,
  profileFor,
  rootLabelled,
  runWithProfile,
  runnableOf,
} from './netfx-test-kit';
import { openRepoFile, positionOf, waitForError, waitForErrorsCleared } from './real-repo-helpers';
import {
  type Anchor,
  assertDefinitionIn,
  completeAfterProbe,
  completionLabels,
} from './real-repo-kit';
import { GITREADER, useCorpus } from './real-repo-netfx-kit';
import { collectLeafIds, findItem } from './test-explorer-kit';
import { assertPassed, assertReported, itemsFor } from './test-explorer-outcome-assertions';
import { flattenSymbolNames, waitForDocumentSymbols } from './test-helpers';
import { LSP_RESPONSE_MS, REAL_REPO_MS, REAL_REPO_WARMUP_MS } from './test-timeouts';
import { installUiStubs } from './ui-stubs';

const TESTS_UTILITIES = 'FSharp.GitReader.Tests/Utilities.fs';
const GLOB_TESTS = 'FSharp.GitReader.Tests/GlobTests.fs';
const LIBRARY_UTILITIES = 'FSharp.GitReader/Utilities.fs';
const GLOB = 'FSharp.GitReader/Glob.fs';

/** The F# test project, and the C# one beside it in the same solution. */
const TEST_PROJECT = 'FSharp.GitReader.Tests';
const CSHARP_TEST_PROJECT = 'GitReader.Tests';

/** The F# test project's `<TargetFrameworks>`: net48 FIRST, so net48 answers. */
const TESTS = declared('net48', 'net8.0', 'net9.0', 'net10.0');

/** The F# library's `<TargetFrameworks>`: four .NET Framework, two .NET Standard, eleven .NET. */
const LIBRARY = declared(
  ...['net461', 'net462', 'net48', 'net481', 'netstandard2.0', 'netstandard2.1'],
  ...['netcoreapp2.0', 'netcoreapp2.1', 'netcoreapp2.2', 'netcoreapp3.0', 'netcoreapp3.1'],
  ...['net5.0', 'net6.0', 'net7.0', 'net8.0', 'net9.0', 'net10.0'],
);

/** `runGitCommandAsync` waits for git one way on .NET Framework, another on .NET. */
const WAIT_NETFX: Anchor = ['do! Task.Run(fun () -> proc.WaitForExit()).asAsync()', 'WaitForExit'];
const WAIT_NET: Anchor = ['do! proc.WaitForExitAsync().asAsync()', 'WaitForExitAsync'];

/** `TestUtilities.WriteAllTextAsync` writes one way on .NET Framework, another on .NET. */
const WRITE_NETFX: Anchor = [
  'Task.Run(fun () -> File.WriteAllText(path, contents))',
  'WriteAllText',
];
const WRITE_NET: Anchor = ['File.WriteAllTextAsync(path, contents)', 'WriteAllTextAsync'];

/** What each framework family compiles in the test project's Utilities.fs. */
const NETFX_BRANCH = { live: [WAIT_NETFX, WRITE_NETFX], inert: [WAIT_NET, WRITE_NET] };
const NET_BRANCH = { live: [WAIT_NET, WRITE_NET], inert: [WAIT_NETFX, WRITE_NETFX] };

/** `#if NET45_OR_GREATER || NETSTANDARD || NETCOREAPP2_1_OR_GREATER` — dark on netcoreapp2.0. */
const VALUE_TASK: Anchor = ['    type ValueTask with', 'ValueTask'];
/** `#if NET45_OR_GREATER || NETSTANDARD || NETCOREAPP` — live on every library framework. */
const VALUE_TASK_OF_T: Anchor = ["    type ValueTask<'T> with", 'ValueTask'];

/** `Glob.isMatch`, called from the F# tests and defined in the F# library. */
const IS_MATCH: Anchor = ['ClassicAssert.IsTrue(Glob.isMatch("test.txt", "*.txt"))', 'isMatch'];

/** F# NUnit ids exactly as NUnit reports them: SPACES, and a `#`, verbatim. */
const GLOB_CLASS = 'GitReader.Tests.GlobTests';
const GLOB_IDS = [
  `${GLOB_CLASS}.isMatch should work with basic patterns`,
  `${GLOB_CLASS}.isMatch should work with directory patterns`,
  `${GLOB_CLASS}.createExcludeFilter should return F# function type`,
  `${GLOB_CLASS}.F# pipe operator should work with filters`,
];

/** Every test NUnit lists in the F# GlobTests fixture at the pinned commit. */
const GLOB_TEST_COUNT = 18;

/** Appended to Utilities.fs: a .NET-only API, used unguarded. */
const NET_ONLY_PROBE =
  '\nmodule SharpLspFrameworkProbe =\n    let probe () = System.IO.File.WriteAllTextAsync("p", "")\n';

suite('Real repo .NET Framework — GitReader (F#)', () => {
  const { repoDir, api, installed, discovered, runClass } = useCorpus(
    GITREADER,
    TESTS_UTILITIES,
    WAIT_NETFX,
    GLOB_IDS,
  );

  test('the F# test project answers from its FIRST framework: net48, whose #if branch is live', async function () {
    this.timeout(LSP_RESPONSE_MS * 4);
    const { doc, uri } = await openRepoFile(repoDir(), TESTS_UTILITIES);
    assertContext(await frameworkContextOf(uri), TESTS.first, TESTS.available, TEST_PROJECT);
    await assertStatusShows(api(), TESTS.first, TESTS.available);
    // [NETFX-PROJECTS-FSHARP]: net48 compiles with NETFRAMEWORK defined, so the
    // .NET Framework calls resolve and the .NET-only calls sit in dead code.
    await assertBranches(doc, TESTS.first, NETFX_BRANCH);
    const glob = await openRepoFile(repoDir(), GLOB_TESTS);
    assertContext(await frameworkContextOf(glob.uri), TESTS.first, TESTS.available, 'every file');
    await assertStatusShows(api(), TESTS.first, TESTS.available);
  });

  test('switching the test PROJECT to net8.0 flips which #if branch answers, in every file of it', async function () {
    this.timeout(LSP_RESPONSE_MS * 6);
    const { doc, uri } = await openRepoFile(repoDir(), TESTS_UTILITIES);
    const glob = await openRepoFile(repoDir(), GLOB_TESTS);
    await underFramework(uri, 'net8.0', TESTS, async () => {
      await assertBranches(doc, 'net8.0', NET_BRANCH);
      assertContext(await frameworkContextOf(glob.uri), 'net8.0', TESTS.available, 'a sibling');
      await assertStatusShows(api(), 'net8.0', TESTS.available);
    });
    assertContext(await frameworkContextOf(glob.uri), TESTS.first, TESTS.available, 'restored');
    await assertBranches(doc, TESTS.first, NETFX_BRANCH);
  });

  test('the switch is per PROJECT: the F# library keeps its own first framework, net461', async function () {
    this.timeout(LSP_RESPONSE_MS * 6);
    const tests = await openRepoFile(repoDir(), TESTS_UTILITIES);
    const library = await openRepoFile(repoDir(), LIBRARY_UTILITIES);
    const libraryContext = await frameworkContextOf(library.uri);
    assertContext(libraryContext, 'net461', LIBRARY.available, 'library');
    const families = {
      netfx: ['net461', 'net462', 'net48', 'net481'],
      standards: ['netstandard2.0', 'netstandard2.1'],
    };
    assertDeclaresFamilies(libraryContext.available, families, 'FSharp.GitReader');
    await underFramework(tests.uri, 'net10.0', TESTS, async () => {
      assertContext(await frameworkContextOf(library.uri), 'net461', LIBRARY.available, 'kept');
      const both = { live: [VALUE_TASK, VALUE_TASK_OF_T], inert: [] };
      await assertBranches(library.doc, 'net461', both);
      await vscode.window.showTextDocument(library.doc);
      await assertStatusShows(api(), 'net461', LIBRARY.available);
    });
  });

  test('the library flips per framework: netcoreapp2.0 darkens one ValueTask region, netstandard2.1 lights both', async function () {
    this.timeout(LSP_RESPONSE_MS * 8);
    const { doc, uri } = await openRepoFile(repoDir(), LIBRARY_UTILITIES);
    await underFramework(uri, 'netcoreapp2.0', LIBRARY, async () => {
      await assertBranches(doc, 'netcoreapp2.0', { live: [VALUE_TASK_OF_T], inert: [VALUE_TASK] });
    });
    await underFramework(uri, 'netstandard2.1', LIBRARY, async () => {
      const both = { live: [VALUE_TASK, VALUE_TASK_OF_T], inert: [] };
      await assertBranches(doc, 'netstandard2.1', both);
    });
    const tests = await openRepoFile(repoDir(), TESTS_UTILITIES);
    assertContext(await frameworkContextOf(tests.uri), TESTS.first, TESTS.available, 'tests kept');
  });

  test('the framework pick lists every declared framework; an argument switches without asking', async function () {
    this.timeout(LSP_RESPONSE_MS * 4);
    const { uri } = await openRepoFile(repoDir(), GLOB_TESTS);
    const stubs = installUiStubs();
    try {
      const choice = { tfm: 'net10.0', active: TESTS.first, available: TESTS.available };
      await pickFramework(stubs, TEST_PROJECT, choice);
      assertContext(await frameworkContextOf(uri), 'net10.0', TESTS.available, 'picked net10.0');
      await assertStatusShows(api(), 'net10.0', TESTS.available);
      const picks = stubs.log.quickPickItems.length;
      await vscode.commands.executeCommand(SELECT_TARGET_FRAMEWORK, TESTS.first);
      assert.strictEqual(stubs.log.quickPickItems.length, picks, 'an argument switches, no pick');
      assertContext(await frameworkContextOf(uri), TESTS.first, TESTS.available, 'by argument');
    } finally {
      stubs.restore();
    }
  });

  test('a .NET-only API is an Error under net48 and clean under net8.0: diagnostics follow the switch', async function () {
    this.timeout(LSP_RESPONSE_MS * 6);
    const { doc, uri, editor } = await openRepoFile(repoDir(), TESTS_UTILITIES);
    const pristine = doc.getText().length;
    const applied = await editor.edit((edit) => {
      edit.insert(doc.positionAt(pristine), NET_ONLY_PROBE);
    });
    assert.ok(applied, 'the unguarded .NET-only probe applies');
    try {
      const onProbe = (d: vscode.Diagnostic): boolean => d.message.includes('WriteAllTextAsync');
      const error = await waitForError(uri, LSP_RESPONSE_MS, onProbe);
      assert.ok(doc.getText(error.range).includes('WriteAllTextAsync'), 'on the missing member');
      assert.ok(error.range.start.line >= doc.positionAt(pristine).line, 'on the probe alone');
      await underFramework(uri, 'net8.0', TESTS, async () => {
        await waitForErrorsCleared(uri, LSP_RESPONSE_MS);
      });
    } finally {
      const tail = new vscode.Range(doc.positionAt(pristine), doc.positionAt(doc.getText().length));
      const reverted = await editor.edit((edit) => {
        edit.delete(tail);
      });
      assert.ok(reverted, 'the probe is removed');
    }
    assert.strictEqual(doc.getText().length, pristine, 'the file is pristine again');
    await waitForErrorsCleared(uri, LSP_RESPONSE_MS);
  });

  test('completion offers only what the ACTIVE framework has: File.WriteAllTextAsync on net8.0, never on net48', async function () {
    this.timeout(LSP_RESPONSE_MS * 6);
    const { doc, editor, uri } = await openRepoFile(repoDir(), TESTS_UTILITIES);
    const end = (): vscode.Position => doc.positionAt(doc.getText().length);
    // Written in the document's OWN line ending: VS Code turns an inserted "\n"
    // into the document's EOL, and a probe that is no longer in the text verbatim
    // would put the completion cursor somewhere other than after `File.`.
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const probe = [
      '',
      'module SharpLspCompletionProbe =',
      '    let probe () = System.IO.File.',
    ].join(eol);
    const onNetfx = completionLabels(
      await completeAfterProbe(editor, end(), probe, 'WriteAllText'),
    );
    assert.ok(onNetfx.has('ReadAllText'), 'net48 offers File members');
    assert.ok(!onNetfx.has('WriteAllTextAsync'), 'net48 has no File.WriteAllTextAsync to offer');
    assert.ok(!onNetfx.has('Utilities'), "a list of File's members, never the file's own modules");
    await underFramework(uri, 'net8.0', TESTS, async () => {
      const list = await completeAfterProbe(editor, end(), probe, 'WriteAllTextAsync');
      const onNet = completionLabels(list);
      assert.ok(onNet.has('WriteAllText') && onNet.has('ReadAllTextAsync'), 'both generations');
    });
    assert.ok(!doc.getText().includes('SharpLspCompletionProbe'), 'undo leaves the file pristine');
  });

  test('outline and cross-project definition answer under BOTH framework families', async function () {
    this.timeout(LSP_RESPONSE_MS * 4);
    const { doc, uri } = await openRepoFile(repoDir(), GLOB_TESTS);
    const names = flattenSymbolNames(await waitForDocumentSymbols(uri, LSP_RESPONSE_MS));
    assert.ok(names.includes('GlobTests'), `the outline names the type: ${names.join(' | ')}`);
    const named = (text: string): boolean => names.some((name) => name.includes(text));
    assert.ok(named('isMatch should work with basic patterns'), 'and its tests');
    assert.ok(named('F# pipe operator should work with filters'), 'with # intact');
    const at = positionOf(doc, ...IS_MATCH);
    await assertDefinitionIn(uri, at, GLOB, 'isMatch');
    await underFramework(uri, 'net10.0', TESTS, async () => {
      await assertDefinitionIn(uri, at, GLOB, 'isMatch');
    });
  });

  test('discovery: ONE root per test project, describing every framework — unrunnable ones named', async function () {
    this.timeout(REAL_REPO_WARMUP_MS);
    await discovered();
    for (const project of [TEST_PROJECT, CSHARP_TEST_PROJECT]) {
      assertFrameworkRoot(rootLabelled(api(), project), TESTS.available, installed());
    }
    const runnable = runnableOf(TESTS.available, installed());
    for (const id of GLOB_IDS) {
      const item = findItem(api().testController.items, id);
      assert.ok(item, `${id} is a row, spaces and # verbatim`);
      assert.strictEqual(item.label, id.slice(GLOB_CLASS.length + 1), `${id}: its method`);
      assertTaggedFor(item, runnable);
    }
  });

  test('running the GlobTests class: every test passes, and a framework with no runtime is logged, not failed', async function () {
    this.timeout(REAL_REPO_MS);
    const anyTest = GLOB_IDS[0] ?? '';
    await runClass({ anyTest, count: GLOB_TEST_COUNT, declared: TESTS.available });
    assert.strictEqual(classRowOf(api(), anyTest).label, 'GlobTests', 'the F# type is the class');
  });

  test('Run on <tfm>: one profile per framework, and Run on net48 reports the whole class', async function () {
    this.timeout(REAL_REPO_MS);
    await discovered();
    const profiles = frameworkProfilesOf(api());
    assertFrameworkProfiles(profiles, TESTS.available);
    const net48 = profileFor(profiles, 'net48');
    const row = classRowOf(api(), GLOB_IDS[0] ?? '');
    await runWithProfile(net48, [row]);
    for (const id of collectLeafIds(row.children)) assertPassed(assertReported(api(), id), id);
    for (const item of itemsFor(api(), GLOB_IDS)) {
      const scoped = item.tags.some((tag) => tag.id === net48.tag?.id);
      assert.ok(net48.tag !== undefined && scoped, `${item.id} is in Run on net48's scope`);
    }
  });
});
