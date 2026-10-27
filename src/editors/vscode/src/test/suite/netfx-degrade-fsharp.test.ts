// [NETFX-PROJECTS-FSHARP]: "If the design-time compile fails, fallback options
// retain project ownership but cannot authorize diagnostic findings; diagnostic
// requests preserve the SDK failure ([DIAG-TRUTH-GUARANTEES], #488)."
//
// The fixture's Directory.Build.targets fails every F# design-time compile on
// purpose — and only that: evaluation still runs, so the project still KNOWS
// its frameworks, but no framework's compiler arguments ever arrive. So the
// project must keep answering from its fallback options, compiled against the
// sidecar's own runtime with NO framework defines; a switch to another
// framework must fail with MSBuild's own reason rather than pretend to succeed;
// and the F# sidecar's log must say its compiler inputs are unavailable, and why.
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

/** What the sidecar logs when a project answers from fallback options. */
const INPUTS_UNAVAILABLE = 'compiler inputs unavailable';

/**
 * The sidecar always logs at Debug, and its IPC trace quotes each refused request's
 * reason — the SDK failure every diagnostic request must preserve. A trace states no
 * severity; every line logged at a stated level must be a warning.
 */
const TRACE_LEVEL = '[DBG]';

/** A line in which the sidecar itself states that the project's inputs are unavailable. */
function statesUnavailable(line: string): boolean {
  return line.includes(INPUTS_UNAVAILABLE) && !line.includes(TRACE_LEVEL);
}

suite(
  '.NET Framework F# — a failing design-time compile keeps ownership on fallback options, and says why',
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

    test("the F# sidecar log says why: the project's compiler inputs are unavailable, with the reason", async function () {
      this.timeout(LSP_RESPONSE_MS * 2);
      const { projectFile } = fixture();
      const lines = await pollUntilResult(
        async () => fsharpSidecarLinesAbout(projectFile),
        (found) => found.some(statesUnavailable),
        LSP_RESPONSE_MS,
        500,
        `the F# sidecar log to say ${projectFile} ${INPUTS_UNAVAILABLE}`,
      );
      const stated = lines.filter(statesUnavailable);
      const line = stated[0] ?? '';
      assert.ok(line.includes('[WRN]'), `logged as a warning: ${line}`);
      const named = line.indexOf('F# project ');
      assert.ok(
        named >= 0 && named < line.indexOf(INPUTS_UNAVAILABLE),
        `names the project first: ${line}`,
      );
      assert.ok(line.includes(DESIGN_TIME_FAILURE), `and says why, in MSBuild's words: ${line}`);
      assert.ok(
        stated.every((each) => each.includes('[WRN]')),
        'every such line is a warning, none an error',
      );
    });
  },
);
