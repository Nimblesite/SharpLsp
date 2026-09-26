// [NETFX-PROJECTS-FSHARP]: an F# project's options come from MSBuild's
// design-time compile, per framework — so "source order, globs, conditions and
// Directory.Build.* are MSBuild's", and "relative arguments resolve against the
// project directory".
//
// The fixture (netfx-msbuild-kit.ts) can only compile the way MSBuild says: a
// Directory.Build.props adds a file that lives OUTSIDE the project, LINKED in by
// a path relative to the project directory and CONDITIONED on .NET Framework; a
// Directory.Build.targets defines a symbol the source guards a name behind; and
// a glob pulls in two files the compiler accepts only in MSBuild's order. A
// sidecar that read the project file itself, or compiled against its own
// runtime, fails every one of these.
//
// Covers [NETFX-PROJECTS-FSHARP] and [NETFX-CONTEXT].
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  assertContext,
  assertHoverResolves,
  frameworkContextOf,
  underFramework,
} from './netfx-context-kit';
import { useLoadedFixture } from './netfx-language-kit';
import {
  DIRECTORY_BUILD_NAME,
  LINKED_USE,
  type MsbuildFixture,
  ORDERED_USE,
  writeMsbuildFixture,
} from './netfx-msbuild-kit';
import { openRepoFile, positionOf, waitForError, waitForErrorsCleared } from './real-repo-helpers';
import { type Anchor, assertDefinitionIn } from './real-repo-kit';
import { LSP_RESPONSE_MS } from './test-timeouts';

/** `file` open in an editor, where `anchor` sits in it, and the fixture's .NET framework. */
async function openAt(
  fixture: MsbuildFixture,
  file: string,
  anchor: Anchor,
): Promise<{ readonly uri: vscode.Uri; readonly at: vscode.Position; readonly net: string }> {
  const { doc, uri } = await openRepoFile(fixture.root, file);
  return { uri, at: positionOf(doc, ...anchor), net: fixture.project.available.at(-1) ?? '' };
}

/** The distinct lines of `uri`'s Error diagnostics, in order. */
function errorLines(uri: vscode.Uri): number[] {
  const errors = vscode.languages
    .getDiagnostics(uri)
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);
  return [...new Set(errors.map((error) => error.range.start.line))].sort((a, b) => a - b);
}

suite(
  '.NET Framework F# — MSBuild owns the compilation: conditions, links, globs, Directory.Build.*',
  () => {
    const fixture = useLoadedFixture('sharplsp-netfx-msbuild-', writeMsbuildFixture);

    test('under net48 the conditioned LINKED file compiles: its name resolves to the file outside the project', async function () {
      this.timeout(LSP_RESPONSE_MS * 4);
      const { project, files } = fixture();
      const { doc, uri } = await openRepoFile(fixture().root, files.program);
      assertContext(await frameworkContextOf(uri), project.first, project.available, 'Msb');
      const at = positionOf(doc, ...LINKED_USE);
      await assertHoverResolves(uri, at, 'linkedValue', 'the linked name under net48');
      await assertDefinitionIn(uri, at, files.linked, 'linkedValue');
      await waitForErrorsCleared(uri, LSP_RESPONSE_MS);
    });

    test('under .NET the condition drops the linked file: its use is the ONE Error line, and nothing else breaks', async function () {
      this.timeout(LSP_RESPONSE_MS * 6);
      const { project, files } = fixture();
      const { uri } = await openRepoFile(fixture().root, files.program);
      await underFramework(uri, project.available.at(-1) ?? '', project, async () => {
        const error = await waitForError(uri, LSP_RESPONSE_MS, (d) => d.message.includes('Linked'));
        assert.strictEqual(error.range.start.line, 2, 'the Error sits on `let viaLink = …`');
        assert.deepStrictEqual(errorLines(uri), [2], 'the glob and the define still resolve');
      });
      await waitForErrorsCleared(uri, LSP_RESPONSE_MS);
    });

    test('the glob expands in MSBuild order: B.fs uses A.fs cleanly under BOTH frameworks', async function () {
      this.timeout(LSP_RESPONSE_MS * 6);
      const { uri, at, net } = await openAt(fixture(), fixture().files.b, ORDERED_USE);
      await waitForErrorsCleared(uri, LSP_RESPONSE_MS);
      await assertDefinitionIn(uri, at, fixture().files.a, 'first');
      await underFramework(uri, net, fixture().project, async () => {
        await waitForErrorsCleared(uri, LSP_RESPONSE_MS);
        await assertDefinitionIn(uri, at, fixture().files.a, 'first');
      });
    });

    test('a Directory.Build.targets define reaches the compiler under BOTH frameworks', async function () {
      this.timeout(LSP_RESPONSE_MS * 6);
      const { uri, at, net } = await openAt(fixture(), fixture().files.first, DIRECTORY_BUILD_NAME);
      await assertHoverResolves(uri, at, 'fromDirectoryBuild', 'the guarded name under net48');
      await underFramework(uri, net, fixture().project, async () => {
        await assertHoverResolves(uri, at, 'fromDirectoryBuild', 'and under .NET');
      });
    });

    test('globbed and linked files belong to the PROJECT: each answers its framework context', async function () {
      this.timeout(LSP_RESPONSE_MS * 4);
      const { project, files, root } = fixture();
      for (const file of [files.a, files.b, files.linked]) {
        const uri = vscode.Uri.file(path.join(root, file));
        const context = await frameworkContextOf(uri);
        assertContext(context, project.first, project.available, `${file} belongs to Msb`);
      }
    });
  },
);
