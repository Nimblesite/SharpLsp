// The [NETFX-CONTEXT] language suite, defined ONCE and instantiated per
// language — F# in `netfx-language-fsharp.test.ts`, C# in `netfx-language.test.ts`
// — because every assertion here is the same contract in both: "Every feature
// serves every framework it declares, in F# as in C#."
//
// The fixture (see netfx-language-kit.ts) builds Probe for net462, net472,
// net48, netstandard2.0, netstandard2.1 and the newest .NET this agent runs, so
// the default context, each framework's own `#if` name, Remoting behind
// NETFRAMEWORK, the Errors of unguarded .NET-only code, and the Shared build
// MSBuild hands each framework are all observed framework by framework.
//
// Covers [NETFX-CONTEXT], [NETFX-PROJECTS-CSHARP] and [NETFX-PROJECTS-FSHARP].
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { SharpLspExtensionApi } from '../../extension.js';
import {
  assertBranches,
  assertContext,
  assertHoverResolves,
  assertOwnedBy,
  assertStatusHidden,
  assertStatusShows,
  frameworkContextOf,
  pickFramework,
  type ProjectFrameworks,
  switchFramework,
  underFramework,
} from './netfx-context-kit';
import {
  assertFlipErrors,
  flipErrorsUnder,
  type LanguageFixture,
  type NetfxLanguage,
  useLanguageFixture,
} from './netfx-language-kit';
import { assertDeclaresFamilies, isNetFramework } from './netfx-test-kit';
import { openRepoFile, positionOf } from './real-repo-helpers';
import { type Anchor, assertDefinitionIn } from './real-repo-kit';
import { activateTestExplorer } from './test-explorer-kit';
import { LSP_RESPONSE_MS } from './test-timeouts';
import { installUiStubs } from './ui-stubs';

/** Every framework's `#if` name EXCEPT `tfm`'s own. */
function othersOf(fixture: LanguageFixture, tfm: string): Anchor[] {
  return fixture.probe.available
    .filter((other) => other !== tfm)
    .map((other) => fixture.nameOf(other));
}

/** Under `tfm`: its own name live, every other name dark, Remoting live iff .NET Framework. */
async function assertFrameworkLit(
  fixture: LanguageFixture,
  doc: vscode.TextDocument,
  tfm: string,
): Promise<void> {
  const remoting = isNetFramework(tfm)
    ? { live: [fixture.remoting], inert: [] }
    : { live: [], inert: [fixture.remoting] };
  await assertBranches(doc, tfm, {
    live: [fixture.nameOf(tfm), ...remoting.live],
    inert: [...othersOf(fixture, tfm), ...remoting.inert],
  });
}

/** A fixture file open in a visible editor. */
interface Opened {
  readonly doc: vscode.TextDocument;
  readonly uri: vscode.Uri;
}

/** Open one of the fixture's files: Probe, Flip, Shared or Single. */
async function openIn(
  fixture: LanguageFixture,
  file: keyof LanguageFixture['files'],
): Promise<Opened> {
  const { doc, uri } = await openRepoFile(fixture.root, fixture.files[file]);
  return { doc, uri };
}

/** Probe open in an editor, with the frameworks it declares. */
async function openProbe(fixture: LanguageFixture): Promise<Opened & { probe: ProjectFrameworks }> {
  return { ...(await openIn(fixture, 'probe')), probe: fixture.probe };
}

/** Define the whole suite for `language`. */
export function defineNetfxLanguageSuite(language: NetfxLanguage, title: string): void {
  suite(title, () => {
    const fixture = useLanguageFixture(language);
    let api: SharpLspExtensionApi;

    suiteSetup(async () => {
      api = await activateTestExplorer();
    });

    test('Probe answers from its FIRST framework, net462: only net462 lights up, Remoting included', async function () {
      this.timeout(LSP_RESPONSE_MS * 10);
      const { probe, doc, uri } = await openProbe(fixture());
      const context = await frameworkContextOf(uri);
      assertContext(context, probe.first, probe.available, 'Probe');
      assertOwnedBy(context, fixture().projects.probe, 'Probe answers for its own project');
      const families = {
        netfx: ['net462', 'net472', 'net48'],
        standards: ['netstandard2.0', 'netstandard2.1'],
      };
      assertDeclaresFamilies(context.available, families, 'Probe, as the server reports it');
      await assertStatusShows(api, probe.first, probe.available);
      await assertFrameworkLit(fixture(), doc, probe.first);
    });

    test('each later .NET Framework version lights its own name, and Remoting stays live', async function () {
      this.timeout(LSP_RESPONSE_MS * 20);
      const { probe, doc, uri } = await openProbe(fixture());
      for (const tfm of probe.available.filter(isNetFramework).slice(1)) {
        await underFramework(uri, tfm, probe, async () => {
          await assertFrameworkLit(fixture(), doc, tfm);
          await assertStatusShows(api, tfm, probe.available);
        });
      }
    });

    test('both .NET Standard versions and .NET light their own names, with Remoting dark', async function () {
      this.timeout(LSP_RESPONSE_MS * 20);
      const { probe, doc, uri } = await openProbe(fixture());
      for (const tfm of probe.available.filter((each) => !isNetFramework(each))) {
        await underFramework(uri, tfm, probe, async () => {
          await assertFrameworkLit(fixture(), doc, tfm);
          assertContext(await frameworkContextOf(uri), tfm, probe.available, `re-reading ${tfm}`);
        });
      }
    });

    test("Flip's Errors follow the framework AND the Shared build MSBuild picks for it", async function () {
      this.timeout(LSP_RESPONSE_MS * 20);
      const { probe } = fixture();
      const { uri } = await openIn(fixture(), 'flip');
      await assertFlipErrors(fixture(), uri, flipErrorsUnder(fixture(), probe.first), probe.first);
      for (const tfm of probe.available.slice(1)) {
        await underFramework(uri, tfm, probe, async () => {
          await assertFlipErrors(fixture(), uri, flipErrorsUnder(fixture(), tfm), tfm);
        });
      }
      const newest = probe.available.at(-1) ?? '';
      assert.deepStrictEqual(flipErrorsUnder(fixture(), newest), [], '.NET compiles it all');
    });

    test('a .NET Standard reference from BOTH families: Go to Definition reaches Shared from every family', async function () {
      this.timeout(LSP_RESPONSE_MS * 10);
      const { probe, doc, uri } = await openProbe(fixture());
      const at = positionOf(doc, ...fixture().greetCall);
      const [, name] = fixture().greetCall;
      const shared = fixture().files.shared;
      await assertDefinitionIn(uri, at, shared, name);
      for (const tfm of ['netstandard2.0', probe.available.at(-1) ?? '']) {
        await underFramework(uri, tfm, probe, async () => {
          await assertDefinitionIn(uri, at, shared, name);
        });
      }
    });

    test('the switch is per PROJECT: Shared keeps netstandard2.0 until it is switched itself', async function () {
      this.timeout(LSP_RESPONSE_MS * 10);
      const { probe, uri: probeUri } = await openProbe(fixture());
      const { shared, combineHash } = fixture();
      const { doc, uri } = await openIn(fixture(), 'shared');
      const sharedContext = await frameworkContextOf(uri);
      assertContext(sharedContext, shared.first, shared.available, 'Shared');
      assertOwnedBy(sharedContext, fixture().projects.shared, 'Shared.fs/Shared.cs');
      await assertStatusShows(api, shared.first, shared.available);
      await assertBranches(doc, shared.first, { live: [], inert: [combineHash] });
      await underFramework(uri, 'netstandard2.1', shared, async () => {
        await assertBranches(doc, 'netstandard2.1', { live: [combineHash], inert: [] });
        assertContext(await frameworkContextOf(probeUri), probe.first, probe.available, 'kept');
      });
    });

    test('a single-target project answers available: [] and hides the item; focus brings it back', async function () {
      this.timeout(LSP_RESPONSE_MS * 6);
      const single = await openIn(fixture(), 'single');
      const singleContext = await frameworkContextOf(single.uri);
      assertContext(singleContext, null, [], 'the single-target project');
      assertOwnedBy(
        singleContext,
        fixture().projects.single,
        'a single-target project still owns it',
      );
      const [snippet, focus] = fixture().singleName;
      const at = positionOf(single.doc, snippet, focus);
      await assertHoverResolves(single.uri, at, focus, 'a single-target project keeps its sources');
      await assertStatusHidden(api, 'a single-target document is focused');
      const { probe } = await openProbe(fixture());
      await assertStatusShows(api, probe.first, probe.available);
      const plain = await vscode.workspace.openTextDocument({
        content: 'plain',
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(plain);
      await assertStatusHidden(api, 'a plain-text document is focused');
    });

    test('a document NO loaded project compiles answers no framework and no project, and switching it is an error', async function () {
      this.timeout(LSP_RESPONSE_MS * 4);
      const loose = await openIn(fixture(), 'loose');
      const context = await frameworkContextOf(loose.uri);
      assertContext(context, null, [], 'the loose file');
      assertOwnedBy(context, null, 'the loose file');
      await assert.rejects(switchFramework(loose.uri, 'net48'), (error: unknown) => {
        assert.ok(
          error instanceof Error,
          `switching a file no project compiles fails: ${String(error)}`,
        );
        return true;
      });
      await assertStatusHidden(api, 'a document no project compiles is focused');
    });

    test('the pick lists all six frameworks; choosing netstandard2.1 switches every file of the project', async function () {
      this.timeout(LSP_RESPONSE_MS * 6);
      const flip = await openIn(fixture(), 'flip');
      const { probe, uri } = await openProbe(fixture());
      const stubs = installUiStubs();
      try {
        const choice = { tfm: 'netstandard2.1', active: probe.first, available: probe.available };
        await pickFramework(stubs, 'Probe', choice);
        assertContext(await frameworkContextOf(flip.uri), choice.tfm, probe.available, 'Flip too');
        const errors = flipErrorsUnder(fixture(), choice.tfm);
        await assertFlipErrors(fixture(), flip.uri, errors, choice.tfm);
      } finally {
        stubs.restore();
        const restored = await switchFramework(uri, probe.first);
        assertContext(restored, probe.first, probe.available, 'restored');
      }
    });
  });
}
