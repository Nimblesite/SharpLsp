// Real Debug-profile dependency graph. Implements [TEST-BUILD-GRAPH].
import * as fs from 'node:fs';
import { directoryOf, fileNameOf, joinPath } from '../../paths';
import type { FixtureLanguage, FixtureRunner, TestDebugFixture } from './debug-test-kit';
import {
  buildProjectXml,
  dotnet,
  MTP_PROPERTIES,
  MTP_XUNIT_PACKAGES,
  writeBuildCounter,
  writeProject,
  XUNIT_PACKAGES,
} from './dotnet-project-kit';

export interface DebugGraph {
  readonly libraryFile: string;
  readonly siblingFile: string;
  readonly assemblies: readonly string[];
  readonly counter: string;
}

/** Whole library sources: changing the result requires rebuilding a project reference. */
function librarySource(revision: number): string {
  return `namespace DebugGraph; public static class Value { public static int Current() => ${String(revision)}; }`;
}

/** An unrelated test project must be discoverable before its source is broken. */
function writeSibling(root: string, runner: FixtureRunner): string {
  return writeProject(
    joinPath(root, 'Unrelated'),
    'Unrelated.csproj',
    buildProjectXml({
      packages: runner === 'mtp' ? MTP_XUNIT_PACKAGES : XUNIT_PACKAGES,
      properties: runner === 'mtp' ? MTP_PROPERTIES : {},
    }),
    'Other.cs',
    'public class Other { [Xunit.Fact] public void Unselected() => Xunit.Assert.True(true); }',
  );
}

/** MSBuild owns project references and solution membership, without editing project XML. */
async function referenceGraph(
  fixture: TestDebugFixture,
  language: FixtureLanguage,
  library: string,
  sibling: string,
): Promise<void> {
  const root = directoryOf(fixture.sourceFile);
  const selected = joinPath(
    root,
    fileNameOf(root) + (language === 'fsharp' ? '.fsproj' : '.csproj'),
  );
  await dotnet(
    ['add', selected, 'reference', joinPath(library, 'GraphLibrary.csproj')],
    fixture.scratchDir,
  );
  await dotnet(['sln', fixture.solutionPath, 'add', library, sibling], fixture.scratchDir);
}

/** Extend the canonical debugger fixture before discovery, sharing the ordinary project kit. */
export async function addDebugGraph(
  fixture: TestDebugFixture,
  language: FixtureLanguage,
  runner: FixtureRunner,
): Promise<DebugGraph> {
  const library = writeLibrary(fixture.scratchDir);
  const sibling = writeSibling(fixture.scratchDir, runner);
  await referenceGraph(fixture, language, library, sibling);
  return graphArtifacts(fixture, library, sibling);
}

/** Buildable project references share the ordinary real-project writer. */
function writeLibrary(root: string): string {
  return writeProject(
    joinPath(root, 'Library'),
    'GraphLibrary.csproj',
    buildProjectXml({}),
    'Value.cs',
    librarySource(1),
  );
}

/** Paths used to observe the actual compiler outputs, without invoking a build. */
function graphArtifacts(fixture: TestDebugFixture, library: string, sibling: string): DebugGraph {
  const selected = directoryOf(fixture.sourceFile);
  return {
    libraryFile: joinPath(library, 'Value.cs'),
    siblingFile: joinPath(sibling, 'Other.cs'),
    assemblies: [
      joinPath(library, 'bin', 'Debug', 'net10.0', 'GraphLibrary.dll'),
      joinPath(selected, 'bin', 'Debug', 'net10.0', `${fileNameOf(selected)}.dll`),
    ],
    counter: writeBuildCounter(fixture.scratchDir),
  };
}

/** Replace complete sources rather than modifying code as text. */
export function updateDebugGraph(graph: DebugGraph, revision: number): void {
  fs.writeFileSync(graph.libraryFile, librarySource(revision));
}
