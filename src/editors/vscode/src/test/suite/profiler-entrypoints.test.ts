// Tests for [PROF-UI-PROCESSES]. See
// docs/specs/LSP-PROFILER-SPEC.md
//
// Issue #82: the PYTHON PROCESSES title-bar entry point must state WHAT it
// profiles (CPU vs memory) and let the user choose either metric, with icons
// and labels consistent with the per-row inline actions ("Profile CPU" 🔥 /
// "Track Memory" 🗄️). These tests assert the declarative VSIX surface in
// package.json — the same panel must speak one language at the row level and
// the title level.

import * as assert from 'assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { shouldProfileOnLaunch } from '@nimblesite/lsp-profiler-ui/out/src/profiler';
import { ProcessesProvider } from '@nimblesite/lsp-profiler-ui/out/src/process-explorer';
import { createProfilerStore } from '@nimblesite/lsp-profiler-ui/out/src/store';
import { captureWarnings, seedSignal, fakeHost, launchConfigOf } from './profiler-ui-helpers';
import { asRecord } from '@nimblesite/lsp-profiler-ui/out/src/unknown-shape';

import { EXTENSION_ID } from './profiler-ui-helpers';
import { requireWorkspaceRoot } from './test-helpers';
import {
  type CommandContribution,
  type WelcomeContribution,
  manifestCommands,
  manifestMenu,
  manifestViewsWelcome,
} from './profiler-ui-manifest';

/** The metric-explicit run-and-profile entry points (#82). */
const CPU_LAUNCH_COMMAND = 'sharplsp.profiler.profileCurrentFileCpu';
const MEMORY_LAUNCH_COMMAND = 'sharplsp.profiler.trackMemoryCurrentFile';
/** The ambiguous, metric-less command issue #82 retires. */
const AMBIGUOUS_LAUNCH_COMMAND = 'sharplsp.profiler.profileCurrentFile';
const DEBUG_VARIABLE_COMMANDS = [
  'sharplsp.profiler.inspectVariableType',
  'sharplsp.profiler.watchVariable',
] as const;

/** The view/title entries scoped to the Processes panel. */
function pythonProcessesTitleCommands(): string[] {
  return manifestMenu('view/title')
    .filter((entry) => entry.when.includes('sharplsp.profiler.processes'))
    .map((entry) => entry.command);
}

/** Look up a command's declaration, asserting it exists. */
function commandEntry(commandId: string): CommandContribution {
  const entry = manifestCommands().find((cmd) => cmd.command === commandId);
  assert.ok(entry, `command "${commandId}" must be declared in package.json`);
  return entry;
}

suite('Processes — title-bar entry points state their metric (#82)', () => {
  test('the title bar offers a CPU launch and a memory launch, not one ambiguous button', () => {
    const titleCommands = pythonProcessesTitleCommands();
    assert.ok(
      titleCommands.includes(CPU_LAUNCH_COMMAND),
      `the title bar must offer a CPU-explicit launch (#82); got: ${titleCommands.join(', ')}`,
    );
    assert.ok(
      titleCommands.includes(MEMORY_LAUNCH_COMMAND),
      `the title bar must offer a memory-explicit launch (#82); got: ${titleCommands.join(', ')}`,
    );
    assert.ok(
      !titleCommands.includes(AMBIGUOUS_LAUNCH_COMMAND),
      "the metric-less 'Run & Profile Current File' button must be gone (#82)",
    );
  });

  test('the CPU launch is labelled CPU and wears the flame icon, matching the row action', () => {
    const cpu = commandEntry(CPU_LAUNCH_COMMAND);
    assert.ok(
      cpu.title.includes('CPU'),
      `the CPU launch title must say CPU (#82); got: ${cpu.title}`,
    );
    assert.strictEqual(cpu.icon, '$(flame)', 'the CPU launch must reuse the Profile CPU row icon');
  });

  test('the memory launch is labelled Memory and wears the database icon, matching the row action', () => {
    const memory = commandEntry(MEMORY_LAUNCH_COMMAND);
    assert.ok(
      memory.title.includes('Memory'),
      `the memory launch title must say Memory (#82); got: ${memory.title}`,
    );
    assert.strictEqual(
      memory.icon,
      '$(database)',
      'the memory launch must reuse the Track Memory row icon',
    );
  });

  test('the empty-state welcome offers both metric-explicit launches', () => {
    // [PROF-UI-STATE] split the welcome into connecting/stopped/running
    // states; the launch buttons live on the server-running empty state.
    const welcome = manifestViewsWelcome().find(
      (entry) =>
        entry.view === 'sharplsp.profiler.processes' &&
        entry.contents.includes('No processes running'),
    );
    assert.ok(welcome, 'the Processes panel must declare a server-running empty state');
    assert.ok(
      welcome.contents.includes(`command:${CPU_LAUNCH_COMMAND}`),
      `the welcome view must link the CPU launch (#82); got: ${welcome.contents}`,
    );
    assert.ok(
      welcome.contents.includes(`command:${MEMORY_LAUNCH_COMMAND}`),
      `the welcome view must link the memory launch (#82); got: ${welcome.contents}`,
    );
    // Anchored with the markdown link's closing paren — `…CurrentFileCpu`
    // legitimately contains `…CurrentFile` as a prefix.
    assert.ok(
      !welcome.contents.includes(`command:${AMBIGUOUS_LAUNCH_COMMAND})`),
      'the welcome view must not link the retired ambiguous command (#82)',
    );
  });

  // The profiling UI ships enabled — the [PROF-UI-CAPABILITIES] availability switch
  // was removed. The regression this pins: a `when` clause referencing a context
  // key nobody sets evaluates falsy and silently hides the entry point from
  // every shipped user, which is indistinguishable from the feature not existing.
  test('both launches are palette-reachable in production — never hidden behind a gate', () => {
    const palette = manifestMenu('commandPalette');
    for (const command of [CPU_LAUNCH_COMMAND, MEMORY_LAUNCH_COMMAND]) {
      const entry = palette.find((item) => item.command === command);
      assert.ok(
        entry === undefined,
        `${command} must have no commandPalette suppression entry (ships ungated); ` +
          `found when: ${entry?.when}`,
      );
    }
  });

  test('debugger variable commands are contributed to the command palette', () => {
    const commands = new Set(manifestCommands().map((entry) => entry.command));
    assert.deepStrictEqual(
      DEBUG_VARIABLE_COMMANDS.filter((command) => !commands.has(command)),
      [],
      'registered profiler debugger commands must be discoverable from the command palette',
    );
  });

  // Whole-manifest sweep for the same regression class: any surface (palette,
  // toolbar, view, keybinding) still referencing the removed gate key would be
  // invisible in every session, since nothing sets the key any more.
  test('no manifest surface references the removed profiling UI gate key', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'extension must be found');
    const manifest = JSON.stringify(extension.packageJSON);
    assert.ok(
      !manifest.includes('sharplsp.profiler.profilingEnabled'),
      'package.json must not reference the removed profilingEnabled context key',
    );
  });
});

// Tests for [PROF-UI-PROCESSES]. See docs/specs/LSP-PROFILER-SPEC.md
//
// Issue #147 (scoped to empty-state honesty; the Signals refactor is #148): the
// Processes empty state must not float a redundant Refresh button, and
// "No processes running" must appear ONLY after a fetch has actually
// succeeded — loading / couldn't-load states must say so honestly instead of
// asserting the definitive negative.
const REFRESH_COMMAND = 'sharplsp.profiler.refreshProcesses';

/** The Processes panel's welcome entries. */
function processWelcomes(): WelcomeContribution[] {
  return manifestViewsWelcome().filter((entry) => entry.view === 'sharplsp.profiler.processes');
}

suite('Processes — empty state honesty (#147)', () => {
  test('no standalone Refresh button floats in the empty/welcome state', () => {
    // The panel auto-refreshes and a view-title Refresh already exists; a Refresh
    // button in the welcome copy is redundant and self-contradictory (#147).
    for (const welcome of processWelcomes()) {
      assert.ok(
        !welcome.contents.includes(`command:${REFRESH_COMMAND}`),
        `the empty state must not carry a standalone Refresh button (#147); got: ${welcome.contents}`,
      );
    }
  });

  test('"No processes running" appears only after a fetch has succeeded', () => {
    // The definitive negative must be gated on a SUCCEEDED fetch
    // (processesState == loaded), not merely a running server — else a loading /
    // errored / disconnected panel lies that there are no processes (#147).
    const genuinelyEmpty = processWelcomes().find((entry) =>
      entry.contents.includes('No processes running'),
    );
    assert.ok(genuinelyEmpty, 'a genuinely-empty welcome must exist');
    assert.ok(
      genuinelyEmpty.when?.includes('sharplsp.profiler.processesState == loaded') === true,
      `"No processes running" must be gated on a successful fetch (processesState == loaded), not just a running server (#147); got: ${String(genuinelyEmpty.when)}`,
    );
  });

  test("loading and couldn't-load states are declared, so the panel never lies", () => {
    const whens = processWelcomes().map((entry) => entry.when ?? '');
    assert.ok(
      whens.some((when) => when.includes('sharplsp.profiler.processesState == loading')),
      `a loading state must be declared so the panel never asserts "no processes" mid-load (#147); got: ${whens.join(' | ')}`,
    );
    assert.ok(
      whens.some((when) => when.includes('sharplsp.profiler.processesState == error')),
      `a couldn't-load state must be declared so a fetch error doesn't masquerade as "no processes" (#147); got: ${whens.join(' | ')}`,
    );
  });
});

/**
 * Build a provider over a REAL store whose LSP client behaves as given (#147
 * seam). The provider is a pure projection of the store's `processes` Signal
 * (#148), so the harness must go through the genuine store, not a stub bag.
 */
function providerWithClient(client: unknown): ProcessesProvider {
  const store = createProfilerStore(fakeHost());
  if (client !== undefined) {
    const fake = {
      onDidChangeState: (): vscode.Disposable => ({ dispose: (): undefined => undefined }),
      ...asRecord(client),
    };

    seedSignal(store.client, fake as never);
  }
  return new ProcessesProvider(store);
}

suite('Processes — fetch-state drives the welcome (#147)', () => {
  // The empty welcome only tells the truth if the provider publishes the right
  // processesState. A still-loading or errored fetch must NEVER read as "loaded"
  // (the genuinely-empty state), or "No processes running" lies again.
  test("a freshly created panel is 'loading', never 'no processes'", () => {
    const provider = providerWithClient({ isRunning: () => false });
    assert.strictEqual(provider.processesState, 'loading');
    provider.dispose();
  });

  test("a successful fetch settles to 'loaded' — only then is empty genuine", async () => {
    const provider = providerWithClient({
      isRunning: () => true,
      sendRequest: async () => ({ processes: [] }),
    });
    await provider.refreshNow();
    assert.strictEqual(provider.processesState, 'loaded');
    provider.dispose();
  });

  test("a failed fetch settles to 'error', not masquerading as 'no processes'", async () => {
    const provider = providerWithClient({
      isRunning: () => true,
      sendRequest: async () => {
        throw new Error('disconnected');
      },
    });
    await provider.refreshNow();
    assert.strictEqual(provider.processesState, 'error');
    provider.dispose();
  });

  test("no running client stays 'loading' (the serverState welcome owns the copy)", async () => {
    const provider = providerWithClient(undefined);
    await provider.refreshNow();
    assert.strictEqual(provider.processesState, 'loading');
    provider.dispose();
  });
});

suite('Run & Profile registered commands (#82)', () => {
  test('both registered launches refuse to start a session without an F# or C# file open', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // Driving the REAL registered commands end-to-end: each must exist (or
    // executeCommand rejects) and must decline to launch with no active
    // F# or C# editor instead of starting a broken session.
    const warnings = await captureWarnings(async () => {
      await vscode.commands.executeCommand('sharplsp.profiler.profileCurrentFileCpu');
      await vscode.commands.executeCommand('sharplsp.profiler.trackMemoryCurrentFile');
    });
    assert.strictEqual(
      vscode.debug.activeDebugSession,
      undefined,
      'no debug session may start when no F# or C# file is open',
    );
    // Each says what to open, in the languages' own names, never their editor
    // ids ("Open a csharp/fsharp file"). lspkit [PROF-UI-HOST]
    const open = 'SharpLsp: Open a file in F# or C# to run and profile.';
    assert.deepStrictEqual(warnings, [open, open], 'both launches say which file to open');
  });
});

/** A program inside the opened workspace folder. */
const WORKSPACE_PROGRAM = (): string => path.join(requireWorkspaceRoot(), 'App', 'Program.cs');

suite('Run & Profile launch configurations (#82)', () => {
  test('the CPU launch asks for profiling on launch and names its metric', () => {
    const config = launchConfigOf('cpu', WORKSPACE_PROGRAM());
    assert.strictEqual(config.type, 'sharplsp-coreclr');
    assert.strictEqual(config.request, 'launch');
    // The adapter resolves the project that owns the file from its folder.
    assert.strictEqual(
      config.cwd,
      requireWorkspaceRoot(),
      'the launch runs in the workspace folder of the file',
    );
    assert.strictEqual(
      config.profileOnLaunch,
      true,
      'the CPU launch must actually start the profiler, not just run the file',
    );
    assert.ok(
      config.name.includes('CPU'),
      `the session name must state the metric: ${config.name}`,
    );
  });

  test('the memory launch tracks from launch, with no stop on entry (direct capture)', () => {
    const config = launchConfigOf('memory', WORKSPACE_PROGRAM());
    assert.strictEqual(
      config.cwd,
      requireWorkspaceRoot(),
      'the launch runs in the workspace folder of the file',
    );
    assert.strictEqual(
      config.stopAtEntry,
      undefined,
      '.NET memory is read directly, so the program never has to pause first',
    );
    assert.strictEqual(
      config.memoryTrackOnLaunch,
      true,
      'memory-profiler.ts keys its auto-start flow off this flag',
    );
    assert.ok(
      config.name.includes('Memory'),
      `the session name must state the metric: ${config.name}`,
    );
  });

  test('a launch config requesting profileOnLaunch is honoured even with the global setting off', async () => {
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update('profiler.profileOnLaunch', undefined, vscode.ConfigurationTarget.Global);

    const fromEntryPoint = {
      type: 'sharplsp-coreclr',
      configuration: launchConfigOf('cpu', WORKSPACE_PROGRAM()),
    };
    assert.strictEqual(
      shouldProfileOnLaunch(fromEntryPoint),
      true,
      "the 'Run & Profile CPU' launch must auto-profile without requiring the global setting (#82)",
    );

    const plainLaunch = {
      type: 'sharplsp-coreclr',
      configuration: { type: 'sharplsp-coreclr', request: 'launch', name: 'plain' },
    };
    assert.strictEqual(
      shouldProfileOnLaunch(plainLaunch),
      false,
      'a plain debug session must not be auto-profiled by default',
    );

    const foreignSession = {
      type: 'node',
      configuration: launchConfigOf('cpu', WORKSPACE_PROGRAM()),
    };
    assert.strictEqual(
      shouldProfileOnLaunch(foreignSession),
      false,
      'non-SharpLsp sessions are never auto-profiled',
    );
  });

  // dap-1: the global setting is read directly by shouldProfileOnLaunch, so the
  // stamp carve-out in applyDebugConfigDefaults is not enough on its own — the
  // CPU auto-start must itself refuse a memory-tracking session.
  test('a memory-tracking launch is never CPU-auto-profiled, even with the global setting on (dap-1)', async () => {
    const cfg = vscode.workspace.getConfiguration('sharplsp');
    await cfg.update('profiler.profileOnLaunch', true, vscode.ConfigurationTarget.Global);
    try {
      const memorySession = {
        type: 'sharplsp-coreclr',
        configuration: launchConfigOf('memory', WORKSPACE_PROGRAM()),
      };
      assert.strictEqual(
        shouldProfileOnLaunch(memorySession),
        false,
        'a memory launch must not auto-start the CPU sampler — it would collide with tracemalloc at the entry pause (dap-1)',
      );
    } finally {
      await cfg.update('profiler.profileOnLaunch', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
