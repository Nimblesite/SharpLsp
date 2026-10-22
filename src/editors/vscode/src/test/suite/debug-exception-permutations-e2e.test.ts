// Implements [CONFIG-DEBUG-EXCEPTIONS], [DEBUG-FEATURES-EXCEPTIONS].
// Actual workbench sessions: Just My Code × throw-site/user-boundary, both languages.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { directoryOf, joinPath, samePath } from '../../paths';
import { dap, type StopRecord } from './debug-dap-kit';
import { assertExceptionIs, assertStoppedAt, exceptionInfoOf, topFrame } from './debug-drive-kit';
import { CAUGHT_MESSAGE, CAUGHT_TYPE, MODE } from './debug-fixture-programs';
import {
  armBreakpoints,
  debugTest,
  startDebuggee,
  useDebuggee,
  type Debuggee,
} from './debug-suite-kit';
import { dotnet } from './dotnet-project-kit';

type Projection = 'throw-site' | 'user-boundary';

/** A real stop from the workbench tracker, never an assumed successful command. */
async function stopped(harness: Debuggee, count: number, reason: string): Promise<StopRecord> {
  const stop = (await harness.recorder.waitForStops(count)).at(count - 1);
  assert.ok(stop, `stop ${String(count)} exists`);
  const detail =
    stop.reason === reason
      ? ''
      : JSON.stringify(
          await vscode.debug.activeDebugSession?.customRequest('stackTrace', {
            threadId: stop.threadId,
            levels: 5,
          }),
        );
  assert.equal(stop.reason, reason, detail);
  assert.ok(stop.threadId > 0, 'the stop identifies a live CLR thread');
  return stop;
}

/** Provide original library sources/PDBs as well as the caller's symbols. */
async function buildWithLibrarySymbols(harness: Debuggee): Promise<void> {
  const fixture = harness.fixture;
  await dotnet(
    ['build', fixture.projectFile, '--no-restore', '-p:DebugType=portable', '-p:DebugSymbols=true'],
    fixture.dir,
  );
  assert.ok(
    fs.existsSync(joinPath(fixture.dir, 'bin', 'Debug', 'net10.0', 'ExternalExceptions.pdb')),
    'the original external throw site has real symbols',
  );
}

/** Frame projection must never change the exception identity or resume it. */
async function inspectExternal(
  harness: Debuggee,
  session: vscode.DebugSession,
  stop: StopRecord,
  projection: Projection,
): Promise<void> {
  const info = await exceptionInfoOf(session, stop.threadId);
  assertExceptionIs(info, CAUGHT_TYPE, 'library-internal', 'external first-chance exception');
  assert.equal(info.breakMode, 'always', 'the external exception has a real library handler');
  const frame = await topFrame(session, stop.threadId);
  if (projection === 'user-boundary')
    assertStoppedAt(
      frame,
      harness.fixture,
      'before-library',
      harness.fixture.languageId === 'fsharp' ? 'main' : 'Main',
      'the user call that entered the library',
    );
  else {
    assert.match(frame.name, /ThrowDeep/);
    assert.ok(
      samePath(
        frame.sourcePath,
        joinPath(directoryOf(harness.fixture.dir), 'ExternalExceptions', 'Library.cs'),
      ),
      'the original throw source is shown',
    );
    assert.ok(frame.line > 0, 'the original source has a mapped sequence point');
  }
  assert.deepEqual(
    await exceptionInfoOf(session, stop.threadId),
    info,
    'reading projected stack preserves exception details',
  );
}

/** Continue the actual session, and prove the existing handlers still run. */
async function finish(
  harness: Debuggee,
  session: vscode.DebugSession,
  stop: StopRecord,
  stops: number,
): Promise<void> {
  await dap(session, 'continue', { threadId: stop.threadId });
  await harness.recorder.waitForEvents('terminated', 1);
  const exits = harness.recorder.events('exited');
  assert.equal(exits.length, 1, 'the program exits exactly once');
  assert.equal(exits[0]?.body['exitCode'], 0, 'continuing executes the catch rather than crashing');
  assert.equal(harness.recorder.stops().length, stops, 'no extra exception or entry stops');
  assert.deepEqual(harness.stubs.log.errorMessages, [], 'the workbench reports no debug errors');
}

for (const language of ['fsharp', 'csharp'] as const) {
  suite(`VSIX exception policy permutations — ${language}`, () => {
    const debuggee = useDebuggee(`debug-permutations-${language}-`, language);
    for (const justMyCode of [true, false]) {
      for (const projection of ['throw-site', 'user-boundary'] as const) {
        debugTest(
          `break all: Just My Code ${String(justMyCode)}, ${projection}`,
          debuggee,
          async (harness) => {
            await buildWithLibrarySymbols(harness);
            armBreakpoints(harness.fixture, 'after-library');
            const session = await startDebuggee(harness, {
              mode: MODE.libraryCaught,
              justMyCode,
              extra: {
                exceptionPolicy: {
                  break_on: 'all',
                  just_my_code: justMyCode,
                  external_code: projection,
                },
              },
            });
            let count = 1;
            if (!justMyCode) {
              const external = await stopped(harness, count++, 'exception');
              await inspectExternal(harness, session, external, projection);
              await dap(session, 'continue', { threadId: external.threadId });
            }
            const returned = await stopped(harness, count++, 'breakpoint');
            assertStoppedAt(
              await topFrame(session, returned.threadId),
              harness.fixture,
              'after-library',
              language === 'fsharp' ? 'main' : 'Main',
              'the library handled its exception and returned',
            );
            assert.ok(returned.hitBreakpointIds.length > 0, 'the user breakpoint actually bound');
            await dap(session, 'continue', { threadId: returned.threadId });
            const user = await stopped(harness, count++, 'exception');
            const info = await exceptionInfoOf(session, user.threadId);
            assertExceptionIs(
              info,
              CAUGHT_TYPE,
              CAUGHT_MESSAGE,
              'user throws still break under every policy',
            );
            assert.equal(info.breakMode, 'always', 'this user exception is handled');
            assertStoppedAt(
              await topFrame(session, user.threadId),
              harness.fixture,
              'throw-caught',
              language === 'fsharp' ? 'throwCaught' : 'ThrowCaught',
              'the original user throw source',
            );
            await finish(harness, session, user, count - 1);
          },
        );
        debugTest(
          `unhandled only: Just My Code ${String(justMyCode)}, ${projection}`,
          debuggee,
          async (harness) => {
            armBreakpoints(harness.fixture, 'after-library');
            const session = await startDebuggee(harness, {
              mode: MODE.libraryCaught,
              justMyCode,
              extra: {
                exceptionPolicy: {
                  break_on: 'unhandled',
                  just_my_code: justMyCode,
                  external_code: projection,
                },
              },
            });
            const returned = await stopped(harness, 1, 'breakpoint');
            assertStoppedAt(
              await topFrame(session, returned.threadId),
              harness.fixture,
              'after-library',
              language === 'fsharp' ? 'main' : 'Main',
              'handled external throw is not surfaced',
            );
            assert.ok(
              returned.hitBreakpointIds.length > 0,
              'the control case still reaches a real breakpoint',
            );
            await finish(harness, session, returned, 1);
          },
        );
      }
    }
  });
}
