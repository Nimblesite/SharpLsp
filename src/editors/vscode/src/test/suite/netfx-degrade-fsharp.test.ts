// [NETFX-PROJECTS-FSHARP]: "If the design-time compile fails, the project
// degrades to its <Compile> items against the sidecar runtime and the log says
// why."
//
// The fixture's Directory.Build.targets fails every F# design-time compile on
// purpose — and only that: evaluation still runs, so the project still KNOWS
// its frameworks, but no framework's compiler arguments ever arrive. So the
// project must keep answering from its literal Compile items, compiled against
// the sidecar's own runtime with NO framework defines; a switch to another
// framework must fail with MSBuild's own reason rather than pretend to succeed;
// and the F# sidecar's log must say why.
//
// Covers [NETFX-PROJECTS-FSHARP] and [NETFX-CONTEXT].
import * as assert from 'node:assert/strict';
import {
  assertContext,
  assertHoverInert,
  assertHoverResolves,
  frameworkContextOf,
  switchFramework,
} from './netfx-context-kit';
import { useLoadedFixture } from './netfx-language-kit';
import {
  DESIGN_TIME_FAILURE,
  fsharpSidecarLinesAbout,
  NETFX_NAME,
  PLAIN,
  writeDegradeFixture,
} from './netfx-msbuild-kit';
import { openRepoFile, positionOf } from './real-repo-helpers';
import { pollUntilResult } from './test-helpers';
import { LSP_RESPONSE_MS } from './test-timeouts';

/** What the sidecar logs when a project keeps its literal Compile items. */
const KEEPS_COMPILE_ITEMS = 'keeps its <Compile> items';

suite(
  '.NET Framework F# — a failing design-time compile degrades to the <Compile> items, and says why',
  () => {
    const fixture = useLoadedFixture('sharplsp-netfx-degrade-', writeDegradeFixture);

    test('evaluation still knows every framework: the project answers from its first, net48', async function () {
      this.timeout(LSP_RESPONSE_MS * 2);
      const { project, probe } = fixture();
      const { doc, uri } = await openRepoFile(fixture().root, probe);
      assertContext(await frameworkContextOf(uri), project.first, project.available, 'Degrade');
      await assertHoverResolves(
        uri,
        positionOf(doc, ...PLAIN),
        'plain',
        'plain code still answers',
      );
    });

    test('the fallback compiles with NO framework defines: #if NETFRAMEWORK stays dark even with net48 active', async function () {
      this.timeout(LSP_RESPONSE_MS * 2);
      const { probe } = fixture();
      const { doc, uri } = await openRepoFile(fixture().root, probe);
      await assertHoverInert(
        uri,
        positionOf(doc, ...NETFX_NAME),
        'netfxName, with no NETFRAMEWORK define',
      );
      await assertHoverResolves(
        uri,
        positionOf(doc, ...PLAIN),
        'plain',
        'while the plain code resolves',
      );
    });

    test("switching to another framework FAILS with MSBuild's own reason, and the context stays put", async function () {
      this.timeout(LSP_RESPONSE_MS * 4);
      const { project, probe } = fixture();
      const { uri } = await openRepoFile(fixture().root, probe);
      await assert.rejects(
        switchFramework(uri, project.available.at(-1) ?? ''),
        (error: unknown) => {
          assert.ok(error instanceof Error, 'the request fails with an error');
          assert.ok(
            error.message.includes(DESIGN_TIME_FAILURE),
            `carrying MSBuild's reason: ${error.message}`,
          );
          return true;
        },
      );
      assertContext(await frameworkContextOf(uri), project.first, project.available, 'unchanged');
    });

    test('the F# sidecar log says why: the project keeps its <Compile> items, with the reason', async function () {
      this.timeout(LSP_RESPONSE_MS * 2);
      const { projectFile } = fixture();
      const lines = await pollUntilResult(
        async () => fsharpSidecarLinesAbout(projectFile),
        (found) => found.some((line) => line.includes(KEEPS_COMPILE_ITEMS)),
        LSP_RESPONSE_MS,
        500,
        `the F# sidecar log to say ${projectFile} ${KEEPS_COMPILE_ITEMS}`,
      );
      const line = lines.find((each) => each.includes(KEEPS_COMPILE_ITEMS)) ?? '';
      assert.ok(line.includes('[WRN]'), `logged as a warning: ${line}`);
      const named = line.indexOf('F# project ');
      assert.ok(
        named >= 0 && named < line.indexOf(KEEPS_COMPILE_ITEMS),
        `names the project first: ${line}`,
      );
      assert.ok(line.includes(DESIGN_TIME_FAILURE), `and says why, in MSBuild's words: ${line}`);
      const degraded = lines.filter((each) => each.includes(KEEPS_COMPILE_ITEMS));
      assert.ok(
        degraded.every((each) => each.includes('[WRN]')),
        'every such line is a warning, none an error',
      );
    });
  },
);
