// Implements [TUTORIAL-TESTING].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import { isMeaningful, isUserRequest, stepForResponse } from '../../tutorial/detect.js';
import type { TutorialProgress } from '../../tutorial/model.generated.js';
import {
  currentStep,
  EMPTY_PROGRESS,
  isTutorialProgress,
  withStep,
} from '../../tutorial/progress.js';
import type { PanelView } from '../../tutorial/panel-view.js';
import { contextKey, filmOf, LANGUAGES, stepKey, stepOf, stepsOf } from '../../tutorial/steps.js';
import {
  openFSharpFixture,
  pollDefinition,
  pollHover,
  pollReferences,
  positionOf,
} from './fsharp-helpers';
import { waitForCodeActions } from './refactor-test-helpers';
import {
  EXTENSION_ID,
  closeAllEditors,
  pollUntilResult,
  setupLspTestSuite,
  teardownLspTestSuite,
} from './test-helpers';
import { COMMAND_MS, LSP_RESPONSE_MS, SIDECAR_COLD_MS } from './test-timeouts';

type Tutorial = NonNullable<SharpLspExtensionApi['tutorial']>;

const LOCATION = {
  uri: 'file:///a.fs',
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
};
const QUICK_FIX = { title: 'Fix', kind: 'quickfix' };
const INVOKED = { context: { diagnostics: [], triggerKind: 1 } };
const AUTOMATIC = { context: { diagnostics: [], triggerKind: 2 } };
const CALL = '= Geometry.totalArea';
const MEMBER = CALL.indexOf('totalArea');

function done(tutorial: Tutorial): Set<string> {
  return new Set(tutorial.progress.value.done.map(stepKey));
}

/** Wait until SharpLsp's answer has ticked `key`. */
async function ticked(tutorial: Tutorial, key: string): Promise<Set<string>> {
  return pollUntilResult(
    async () => Promise.resolve(done(tutorial)),
    (keys) => keys.has(key),
    COMMAND_MS,
    100,
    `the tutorial to tick ${key}`,
  );
}

function view(tutorial: Tutorial): PanelView {
  const shown = tutorial.panel.view();
  const tabs = vscode.window.tabGroups.all.map((group) =>
    group.tabs.map(
      (tab) => `${String(group.viewColumn)}:${tab.label}${tab.isPreview ? '(preview)' : ''}`,
    ),
  );
  assert.ok(shown, `the tutorial panel is open and shows a view; tabs: ${JSON.stringify(tabs)}`);
  return shown;
}

function assertCurrent(tutorial: Tutorial, key: string | null, film?: string): void {
  const current = view(tutorial).current;
  assert.equal(current?.key ?? null, key, `the panel's current step is ${String(key)}`);
  if (film !== undefined)
    assert.equal(current?.film.webm.endsWith(`/${film}.webm`), true, `the panel plays ${film}`);
}

suite('Interactive tutorial [TUTORIAL]', () => {
  let tmpDir: string;
  let tutorial: Tutorial;

  suiteSetup(async function () {
    this.timeout(SIDECAR_COLD_MS);
    ({ tmpDir } = await setupLspTestSuite('tutorial-'));
    const api = await vscode.extensions
      .getExtension<SharpLspExtensionApi>(EXTENSION_ID)
      ?.activate();
    assert.ok(api?.tutorial, 'the extension API exposes the tutorial');
    tutorial = api.tutorial;
    await vscode.commands.executeCommand('sharplsp.tutorial.reset');
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  test('[TUTORIAL-DETECT-LSP] only a meaningful SharpLsp answer ticks a step', () => {
    // Hover: content that shows something, in any of the protocol's shapes.
    assert.equal(isMeaningful('Hover', null), false);
    assert.equal(isMeaningful('Hover', { contents: '  ' }), false);
    assert.equal(isMeaningful('Hover', { contents: { kind: 'markdown', value: '' } }), false);
    assert.equal(
      isMeaningful('Hover', { contents: ['', { language: 'fsharp', value: 'int' }] }),
      true,
    );
    // Completion: an array or a list, with at least one item.
    assert.equal(isMeaningful('Completion', []), false);
    assert.equal(isMeaningful('Completion', { isIncomplete: false, items: [] }), false);
    assert.equal(
      isMeaningful('Completion', { isIncomplete: false, items: [{ label: 'map' }] }),
      true,
    );
    // Definition and references: one location, or a non-empty list.
    assert.equal(isMeaningful('Definition', null), false);
    assert.equal(isMeaningful('Definition', LOCATION), true);
    assert.equal(isMeaningful('References', []), false);
    assert.equal(isMeaningful('References', [LOCATION]), true);
    // Code actions: at least one action offered.
    assert.equal(isMeaningful('CodeAction', null), false);
    assert.equal(isMeaningful('CodeAction', []), false);
    assert.equal(isMeaningful('CodeAction', [QUICK_FIX]), true);
  });

  test('[TUTORIAL-DETECT-LSP] only a code action the user invoked ticks, never the automatic lightbulb', () => {
    assert.equal(isUserRequest('CodeAction', INVOKED), true);
    assert.equal(isUserRequest('CodeAction', AUTOMATIC), false);
    assert.equal(isUserRequest('CodeAction', undefined), false, 'no context, no proof');
    assert.equal(isUserRequest('Hover', undefined), true, 'only code actions run unasked');
    assert.deepEqual(
      stepForResponse('textDocument/codeAction', 'fsharp', [QUICK_FIX], INVOKED),
      stepOf('FSharp', 'CodeAction'),
    );
    assert.equal(
      stepForResponse('textDocument/codeAction', 'csharp', [QUICK_FIX], AUTOMATIC),
      undefined,
      'the editor asking on a caret move is not the user',
    );
    assert.equal(stepForResponse('textDocument/codeAction', 'fsharp', [], INVOKED), undefined);
  });

  test('[TUTORIAL-DETECT-LSP] the request method and the document language pick the step', () => {
    const hover = { contents: { kind: 'markdown', value: 'val x: int' } };
    assert.deepEqual(
      stepForResponse('textDocument/hover', 'fsharp', hover),
      stepOf('FSharp', 'Hover'),
    );
    assert.deepEqual(
      stepForResponse('textDocument/references', 'csharp', [LOCATION]),
      stepOf('CSharp', 'References'),
    );
    assert.equal(
      stepForResponse('textDocument/hover', 'razor', hover),
      undefined,
      'Razor is not taught',
    );
    assert.equal(
      stepForResponse('textDocument/hover', undefined, hover),
      undefined,
      'no open document',
    );
    assert.equal(stepForResponse('textDocument/documentSymbol', 'fsharp', [LOCATION]), undefined);
    assert.equal(stepForResponse('textDocument/hover', 'fsharp', null), undefined);
  });

  test('[TUTORIAL-PROGRESS] progress is ordered, idempotent and validated when restored', () => {
    const hover = stepOf('FSharp', 'Hover');
    const once: TutorialProgress = withStep(EMPTY_PROGRESS, hover);
    assert.equal(
      withStep(once, hover),
      once,
      'recording a done step again returns the same object',
    );
    assert.deepEqual(currentStep(EMPTY_PROGRESS, 'FSharp'), stepOf('FSharp', 'OpenFile'));
    assert.deepEqual(
      currentStep(withStep(once, stepOf('FSharp', 'OpenFile')), 'FSharp'),
      stepOf('FSharp', 'Completion'),
    );
    const all = stepsOf('CSharp').reduce(withStep, EMPTY_PROGRESS);
    assert.equal(currentStep(all, 'CSharp'), undefined, 'every C# step done');
    assert.equal(isTutorialProgress(once), true);
    assert.equal(
      isTutorialProgress({ done: [{ language: { kind: 'Rust' }, action: { kind: 'Hover' } }] }),
      false,
    );
    assert.equal(isTutorialProgress({ done: 'all' }), false);
    assert.equal(isTutorialProgress(undefined), false);
  });

  test('[TUTORIAL-PANEL] every film is a WebM from the website or its pinned commit, never an MP4', () => {
    for (const step of LANGUAGES.flatMap(stepsOf)) {
      const film = filmOf(step);
      assert.match(
        film.webm,
        /^https:\/\/(sharplsp\.dev\/assets\/videos|media\.githubusercontent\.com\/media\/Nimblesite\/SharpLsp\/[0-9a-f]{40}\/src\/website\/src\/assets\/videos)\/[a-z-]+\.webm$/,
      );
      assert.match(film.poster, /-poster\.webp$/);
      const assets = film.poster.replace(/-poster\.webp$/, '');
      assert.equal(film.captions === null || film.captions === `${assets}.en.vtt`, true);
      assert.equal(film.webm.endsWith(`/${assets.split('/').pop() ?? ''}.webm`), true);
    }
    assert.equal(filmOf(stepOf('FSharp', 'Hover')).captions?.endsWith('/hover.en.vtt'), true);
    assert.equal(
      filmOf(stepOf('CSharp', 'SolutionExplorer')).captions,
      null,
      'sharplsp-tour has no captions',
    );
    assert.equal(
      filmOf(stepOf('FSharp', 'OpenFile')).webm.endsWith('/fsharp-language.webm'),
      true,
      'F# opens on the F# film',
    );
    // Code actions play the FilmMakers' lesson, each language from its own chapter.
    const fsharpFix = filmOf(stepOf('FSharp', 'CodeAction'));
    const csharpFix = filmOf(stepOf('CSharp', 'CodeAction'));
    // Not deployed yet: GitHub serves the LFS WebM, and the poster and captions, from one commit.
    assert.match(
      fsharpFix.webm,
      /^https:\/\/media\.githubusercontent\.com\/media\/.+\/refactoring-lesson\.webm$/,
    );
    assert.match(
      fsharpFix.poster,
      /^https:\/\/raw\.githubusercontent\.com\/.+\/refactoring-lesson-poster\.webp$/,
    );
    assert.equal(fsharpFix.captions, fsharpFix.poster.replace('-poster.webp', '.en.vtt'));
    assert.deepEqual([fsharpFix.start, csharpFix.start], [44, 116], 'F# fixes at 0:44, C# at 1:56');
    assert.equal(filmOf(stepOf('FSharp', 'Hover')).start, 0, 'other films play from the start');
  });

  test('[TUTORIAL-WALKTHROUGH] the F# walkthrough comes first, and each step completes on its own context key', async () => {
    // The raw manifest: `packageJSON` arrives already localized, its `%keys%` replaced.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'the extension is installed');
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(extension.extensionUri, 'package.json'),
    );
    const manifest = JSON.parse(new TextDecoder().decode(raw)) as {
      contributes: {
        walkthroughs: {
          id: string;
          steps: { id: string; description: string; completionEvents: string[] }[];
        }[];
      };
    };
    const walkthroughs = manifest.contributes.walkthroughs;
    assert.deepEqual(
      walkthroughs.map((w) => w.id),
      ['sharplsp.tutorial.fsharp', 'sharplsp.tutorial.csharp'],
    );
    LANGUAGES.forEach((language, index) => {
      const steps = walkthroughs[index]?.steps ?? [];
      assert.deepEqual(
        steps.map((s) => s.id),
        stepsOf(language).map(stepKey),
        `${language} steps, in order`,
      );
      steps.forEach((s, i) => {
        const step = stepsOf(language)[i];
        assert.ok(step);
        assert.deepEqual(
          s.completionEvents,
          [`onContext:${contextKey(step)}`],
          `${s.id} completes on its key only`,
        );
        assert.match(
          s.description,
          /^%walkthrough\.\w+\.\w+\.description%$/,
          `${s.id} is localized`,
        );
      });
    });
  });

  test('[TUTORIAL-PANEL] opening the tutorial shows the first F# step, its film and a locked-down webview', async function () {
    this.timeout(COMMAND_MS * 2);
    await closeAllEditors();
    await vscode.commands.executeCommand('sharplsp.tutorial.reset');
    await vscode.commands.executeCommand('sharplsp.tutorial.open');
    assertCurrent(tutorial, 'FSharp.OpenFile', 'fsharp-language');
    assert.deepEqual(
      view(tutorial).steps.map((s) => s.done),
      [false, false, false, false, false, false, false],
    );
    assert.deepEqual(
      view(tutorial).languages.map((l) => [l.kind, l.selected, l.done]),
      [
        ['FSharp', true, 0],
        ['CSharp', false, 0],
      ],
    );
    const html = tutorial.panel.html() ?? '';
    assert.match(html, /default-src 'none'/, 'nothing loads unless the policy names it');
    assert.match(
      html,
      /media-src https:\/\/sharplsp\.dev https:\/\/media\.githubusercontent\.com https:\/\/raw\.githubusercontent\.com;/,
      'films come from the website, or GitHub until it deploys, only',
    );
    assert.match(
      html,
      /<script nonce="[^"]+" src="[^"]+panel\.js"><\/script>/,
      'the one script runs by nonce',
    );
  });

  test('[TUTORIAL-DETECT] carrying out the F# steps in the live editor ticks each one, and no C# step', async function () {
    this.timeout(SIDECAR_COLD_MS * 2);
    const { doc, uri } = await openFSharpFixture('Usage.fs');
    assert.ok((await ticked(tutorial, 'FSharp.OpenFile')).has('FSharp.OpenFile'));
    assertCurrent(tutorial, 'FSharp.Hover', 'hover');

    const member = positionOf(doc, CALL, MEMBER + 2);
    await pollHover(uri, member);
    assert.equal(
      (await ticked(tutorial, 'FSharp.Hover')).has('CSharp.Hover'),
      false,
      'an F# hover ticks no C# step',
    );
    assertCurrent(tutorial, 'FSharp.Completion', 'code-completions');

    await pollUntilResult(
      async () =>
        vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          uri,
          positionOf(doc, CALL, MEMBER),
          '.',
        ),
      (list) => list.items.length > 0,
      LSP_RESPONSE_MS,
      1_000,
      'F# member completion after Geometry.',
    );
    await ticked(tutorial, 'FSharp.Completion');
    assertCurrent(tutorial, 'FSharp.Definition', 'navigation');

    await pollDefinition(uri, member);
    await ticked(tutorial, 'FSharp.Definition');
    await pollReferences(uri, positionOf(doc, 'let double', 4), 2);
    await ticked(tutorial, 'FSharp.References');
    assertCurrent(tutorial, 'FSharp.CodeAction', 'refactoring-lesson');

    const fixes = await openFSharpFixture('CodeFixes.fs');
    const unusedOpen = fixes.doc.lineAt(positionOf(fixes.doc, 'open System.Text').line).range;
    await waitForCodeActions({
      uri: fixes.uri,
      range: unusedOpen,
      kind: vscode.CodeActionKind.QuickFix,
      predicate: (items) => items.some((item) => item.title === 'Remove unused open'),
      timeoutMs: LSP_RESPONSE_MS,
    });
    const keys = await ticked(tutorial, 'FSharp.CodeAction');
    assert.deepEqual(
      [...keys].filter((key) => key.startsWith('CSharp.')),
      [],
      'no C# step ticked',
    );
    assertCurrent(tutorial, 'FSharp.SolutionExplorer', 'sharplsp-tour');
  });

  test('[TUTORIAL-DETECT-EDITOR] the Solution Explorer ticks both languages, and C# picks up where it stands', async function () {
    this.timeout(LSP_RESPONSE_MS * 2);
    await vscode.commands.executeCommand('workbench.view.extension.sharplsp-explorer');
    await ticked(tutorial, 'FSharp.SolutionExplorer');
    assert.ok(
      done(tutorial).has('CSharp.SolutionExplorer'),
      'the explorer is shared by both languages',
    );
    assertCurrent(tutorial, null);
    assert.equal(view(tutorial).languages[0]?.done, 7, 'all seven F# steps done');

    await vscode.commands.executeCommand('sharplsp.tutorial.openFile', 'CSharp');
    assert.equal(
      vscode.window.activeTextEditor?.document.languageId,
      'csharp',
      'the command opened a C# file',
    );
    await ticked(tutorial, 'CSharp.OpenFile');
    await vscode.commands.executeCommand('sharplsp.tutorial.open', 'CSharp');
    assert.equal(view(tutorial).language, 'CSharp');
    assertCurrent(tutorial, 'CSharp.Hover', 'hover');
  });

  test('[TUTORIAL-PROGRESS] reset returns every step and the panel to the start', async () => {
    assert.ok(done(tutorial).size > 0, 'there is progress to reset');
    await vscode.commands.executeCommand('sharplsp.tutorial.reset');
    assert.equal(done(tutorial).size, 0, 'no step is done');
    assertCurrent(tutorial, 'CSharp.OpenFile', 'getting-started');
    assert.deepEqual(
      view(tutorial).languages.map((l) => l.done),
      [0, 0],
    );
  });
});
