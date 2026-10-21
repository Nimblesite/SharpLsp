// Blazor WebAssembly launch RESOLUTION — every part of a `sharplsp-blazorwasm`
// launch that decides an answer without starting a real process.
// Spec: [DEBUG-FEATURES-LAUNCH-BLAZOR-WASM].
//
// Nothing here mocks the extension's own surface: the pure functions, the real
// `launchSettings.json` of the repository fixture and the shipped provider are
// driven directly. Only the two things a headless host cannot own — a `dotnet
// run` child and a browser debug session — are replaced, through the shipped
// `useBlazorWasmHost` seam.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import {
  BLAZOR_WASM_DEBUG_TYPE,
  DEFAULT_INSPECT_URI,
  blazorWasmConfigurations,
  browserConfiguration,
  browserDebugType,
  browserOf,
  expandInspectUri,
  inspectUriFor,
  isBlazorWasmProject,
  isBlazorWasmProjectFile,
  launchProfileOf,
  listeningUrlOf,
  listeningUrlsOf,
  projectAt,
  resolveProject,
  runArguments,
  startupFailure,
  takeLines,
} from '../../blazor-wasm-debug';
import {
  BlazorWasmDebugProvider,
  runningBlazorWasmLaunch,
  launchBlazorWasm,
  useBlazorWasmHost,
  type BlazorWasmProcess,
} from '../../blazor-wasm-launch';
import { err, ok, type Result } from '../../result';
import { fakeFolder } from './run-debug-kit';

/** The Blazor WebAssembly fixture in the repository. */
const FIXTURE = path.resolve(__dirname, '../../../../../sharplsp/tests/fixtures/blazor-wasm');
/** The one project it declares, and the one the launch is pointed at. */
const PROJECT = path.join(FIXTURE, 'BlazorWasmApp.csproj');
/** A real project of the same repository that is NOT a Blazor WebAssembly app. */
const OTHER_PROJECT = path.resolve(
  __dirname,
  '../../../../../sharplsp/tests/fixtures/razor/BlazorApp/BlazorApp.csproj',
);
/** The template's own `inspectUri`, as written into launchSettings.json. */
const TEMPLATE_INSPECT_URI =
  '{wsProtocol}://{url.hostname}:{url.port}/_framework/debug/ws-proxy?browser={browserInspectUri}';
/** What the DevServer prints on a loopback HTTP bind, in its real shape. */
const HTTP_ADDRESS = 'http://127.0.0.1:58480';
/** A profile that binds HTTPS: the socket must be `wss`, not `ws`. */
const HTTPS_ADDRESS = 'https://localhost:7297';
/** The expanded forms the two addresses must produce. */
const HTTP_INSPECT = `ws://127.0.0.1:58480/_framework/debug/ws-proxy?browser={browserInspectUri}`;
const HTTPS_INSPECT = `wss://localhost:7297/_framework/debug/ws-proxy?browser={browserInspectUri}`;

/**
 * `dotnet run` output, captured from a real run of the repository fixture:
 * build chatter first, then the host's announcement, then lifecycle noise.
 */
const REAL_OUTPUT = [
  'Using launch settings from Properties/launchSettings.json...',
  'info: Microsoft.Hosting.Lifetime[14]',
  `      Now listening on: ${HTTPS_ADDRESS}`,
  'info: Microsoft.Hosting.Lifetime[14]',
  `      Now listening on: ${HTTP_ADDRESS}`,
  'info: Microsoft.Hosting.Lifetime[0]',
  '      Application started. Press Ctrl+C to shut down.',
  `      Content root path: ${FIXTURE}`,
].join('\n');

/** A `dotnet run` child the test drives by hand. */
interface FakeRun {
  readonly process: BlazorWasmProcess;
  /** The argv the launch built, in full. */
  readonly args: readonly string[];
  /** The directory the launch ran it in. */
  readonly cwd: string;
  /** How many times the launch asked for it to stop. */
  readonly stops: () => number;
  /** Emit child output exactly as a pipe would. */
  readonly announce: (lines: readonly string[]) => void;
  /** End the child on its own terms, before it announces anything. */
  readonly crash: (reason: string) => void;
}

/** A fake `dotnet run` that records everything the launch does to it. */
function fakeRun(args: readonly string[], cwd: string, onOutput: (chunk: string) => void): FakeRun {
  let settle: (value: Result<void>) => void = () => undefined;
  let stops = 0;
  const ended = new Promise<Result<void>>((resolve) => {
    settle = resolve;
  });
  return {
    process: {
      ended,
      stop: () => {
        stops += 1;
        settle(ok(undefined));
      },
    },
    args,
    cwd,
    stops: () => stops,
    announce: (lines) => {
      onOutput(`${lines.join('\n')}\n`);
    },
    crash: (reason) => {
      settle(err(reason));
    },
  };
}

/** A launch configuration pointing at the fixture project. */
function launchConfig(overrides: Record<string, unknown> = {}): vscode.DebugConfiguration {
  return {
    type: BLAZOR_WASM_DEBUG_TYPE,
    request: 'launch',
    name: 'Launch Blazor WebAssembly',
    project: PROJECT,
    ...overrides,
  };
}

suite('Blazor WebAssembly launch resolution', () => {
  test('expands the inspectUri onto the address the DevServer announced', () => {
    // 1. The loopback HTTP address the fixture's own profile binds.
    assert.strictEqual(expandInspectUri(DEFAULT_INSPECT_URI, HTTP_ADDRESS), HTTP_INSPECT);
    assert.strictEqual(inspectUriFor(undefined, HTTP_ADDRESS), HTTP_INSPECT);

    // 2. An HTTPS profile must produce a SECURE socket: `ws` refuses to speak
    //    to a TLS listener, and js-debug then never reaches .NET.
    assert.strictEqual(expandInspectUri(DEFAULT_INSPECT_URI, HTTPS_ADDRESS), HTTPS_INSPECT);
    assert.strictEqual(expandInspectUri(TEMPLATE_INSPECT_URI, HTTPS_ADDRESS), HTTPS_INSPECT);

    // 3. A profile that states no pattern at all falls back to the template's,
    //    and `{browserInspectUri}` is left for js-debug to substitute.
    assert.strictEqual(
      inspectUriFor(undefined, 'http://localhost:5297'),
      'ws://localhost:5297/_framework/debug/ws-proxy?browser={browserInspectUri}',
    );
    assert.strictEqual(inspectUriFor('   ', HTTP_ADDRESS), HTTP_INSPECT);
    assert.ok(inspectUriFor(undefined, HTTP_ADDRESS).endsWith('?browser={browserInspectUri}'));

    // 4. An address that is not a URL leaves the pattern whole rather than
    //    producing a half-expanded proxy the browser would refuse.
    assert.strictEqual(
      expandInspectUri(DEFAULT_INSPECT_URI, 'not an address'),
      DEFAULT_INSPECT_URI,
    );
  });

  test('reads the bound address out of real dotnet run output', () => {
    // 1. A real capture: two announcements, and only they are URLs.
    assert.deepStrictEqual(listeningUrlsOf(REAL_OUTPUT), [HTTPS_ADDRESS, HTTP_ADDRESS]);
    const twice = `${REAL_OUTPUT}\n      Now listening on: ${HTTP_ADDRESS}`;
    assert.deepStrictEqual(listeningUrlsOf(twice), [HTTPS_ADDRESS, HTTP_ADDRESS, HTTP_ADDRESS]);
    // A bare URL on its own line is output, not an announcement of one.
    assert.deepStrictEqual(listeningUrlsOf(HTTP_ADDRESS), []);

    // 2. Noise that merely CONTAINS a URL is not an announcement.
    assert.strictEqual(listeningUrlOf(`      Content root path: ${FIXTURE}`), undefined);
    assert.strictEqual(
      listeningUrlOf(
        'warn: The ASP.NET Core developer certificate is not trusted: https://aka.ms/aspnet/https-trust-dev-cert',
      ),
      undefined,
    );
    assert.deepStrictEqual(listeningUrlsOf('info: Microsoft.Hosting.Lifetime[14]'), []);

    // 3. A pipe cuts the line wherever it likes; the tail is kept until the
    //    newline arrives, so the announcement is still found whole.
    const first = takeLines('', `      Now lis`);
    assert.strictEqual(first.pending, '      Now lis');
    assert.deepStrictEqual(first.lines, []);
    const second = takeLines(first.pending, `tening on: ${HTTP_ADDRESS}\n`);
    assert.strictEqual(second.pending, '');
    assert.strictEqual(second.lines.length, 1);
    assert.deepStrictEqual(listeningUrlsOf(second.lines.join('\n')), [HTTP_ADDRESS]);
  });

  test('maps a browser onto the debug type VS Code ships for it', () => {
    // 1. Both browsers js-debug ships a type for.
    assert.strictEqual(browserDebugType('chrome'), 'pwa-chrome');
    assert.strictEqual(browserDebugType('edge'), 'pwa-msedge');

    // 2. A browser name is hand-written in launch.json, so it arrives in any
    //    case and can be absent; neither may refuse a launch.
    assert.strictEqual(browserDebugType(browserOf('EDGE')), 'pwa-msedge');
    assert.strictEqual(browserDebugType(browserOf('Chrome')), 'pwa-chrome');
    assert.strictEqual(browserDebugType(browserOf(undefined)), 'pwa-chrome');
    assert.strictEqual(browserDebugType(browserOf(42)), 'pwa-chrome');

    // 3. The configuration js-debug receives names the browser type, and the
    //    proxy URL is the expanded one.
    const configuration = browserConfiguration({
      name: 'Launch Blazor WebAssembly',
      url: HTTP_ADDRESS,
      inspectUri: HTTP_INSPECT,
      browser: 'edge',
      webRoot: path.join(FIXTURE, 'wwwroot'),
      timeout: 30_000,
    });
    assert.strictEqual(configuration.type, 'pwa-msedge');
    assert.strictEqual(configuration.request, 'launch');
    assert.strictEqual(configuration.url, HTTP_ADDRESS);
    assert.strictEqual(configuration.inspectUri, HTTP_INSPECT);
    assert.strictEqual(configuration.name, 'Launch Blazor WebAssembly');
  });

  test('generates one configuration per Blazor WebAssembly project, without prompting', async () => {
    // 1. Discovery is the shipped XML reader against the real fixture files.
    assert.strictEqual(isBlazorWasmProject(fs.readFileSync(PROJECT, 'utf-8')), true);
    assert.strictEqual(isBlazorWasmProject(fs.readFileSync(OTHER_PROJECT, 'utf-8')), false);
    assert.strictEqual(
      isBlazorWasmProject(
        '<Project Sdk="Microsoft.NET.Sdk.Web"><!-- BlazorWebAssembly --></Project>',
      ),
      false,
    );
    assert.strictEqual(isBlazorWasmProject('not xml at all'), false);

    // 2. The provider answers from the project list it is given, checking the
    //    Sdk attribute of each — the non-WebAssembly project is dropped.
    const provider = new BlazorWasmDebugProvider();
    const restore = useBlazorWasmHost({
      listProjects: () => Promise.resolve([PROJECT, OTHER_PROJECT]),
    });
    try {
      const generated = await provider.provideDebugConfigurations(fakeFolder(FIXTURE));
      assert.deepStrictEqual(generated, [
        {
          type: BLAZOR_WASM_DEBUG_TYPE,
          request: 'launch',
          name: 'Blazor WebAssembly: BlazorWasmApp',
          project: PROJECT,
          browser: 'chrome',
        },
      ]);
      const fromFiles = blazorWasmConfigurations([OTHER_PROJECT, PROJECT]);
      assert.strictEqual(fromFiles.length, 1);
      assert.strictEqual(fromFiles[0]?.project, PROJECT);

      // 3. With no folder there is nothing to enumerate, and nothing is offered.
      assert.deepStrictEqual(await provider.provideDebugConfigurations(undefined), []);
    } finally {
      restore();
    }

    // 4. The shipped listing finds the folder's project files itself, build
    //    output excluded, and offers the WebAssembly one.
    const listed = await provider.provideDebugConfigurations(fakeFolder(FIXTURE));
    assert.deepStrictEqual(
      listed.map((configuration) => configuration.project),
      [PROJECT],
      'the fixture folder holds one Blazor WebAssembly project',
    );
  });

  test('reads the profile, its inspectUri and the run arguments from the project', () => {
    // 1. The fixture's sole `Project` profile applies without being named.
    const profile = launchProfileOf(PROJECT, undefined);
    assert.strictEqual(profile?.name, 'http');
    assert.strictEqual(profile?.inspectUri, TEMPLATE_INSPECT_URI);

    // 2. A named profile that the project does not declare is NOT invented.
    assert.strictEqual(launchProfileOf(PROJECT, 'nope'), undefined);
    assert.strictEqual(launchProfileOf(PROJECT, 'http')?.name, 'http');

    // 3. The argv is a real argument vector — no shell, so no quoting.
    assert.deepStrictEqual(runArguments(PROJECT, 'http'), [
      'run',
      '--project',
      PROJECT,
      '--launch-profile',
      'http',
    ]);
    assert.deepStrictEqual(runArguments(PROJECT, undefined), ['run', '--project', PROJECT]);
    assert.deepStrictEqual(runArguments(PROJECT, '  '), ['run', '--project', PROJECT]);
  });

  test('kills the dotnet run process when the browser session ends', async () => {
    const runs: FakeRun[] = [];
    const handed: vscode.DebugConfiguration[] = [];
    let endBrowser: () => void = () => undefined;
    const restore = useBlazorWasmHost({
      startProcess: (args, cwd, onOutput) => {
        const run = fakeRun(args, cwd, onOutput);
        runs.push(run);
        run.announce([`      Now listening on: ${HTTP_ADDRESS}`]);
        return run.process;
      },
      startBrowserSession: (_folder, configuration) => {
        handed.push(configuration);
        return Promise.resolve({
          ended: new Promise<void>((resolve) => {
            endBrowser = resolve;
          }),
        });
      },
    });
    try {
      // 1. The launch runs the project's own profile and hands js-debug the
      //    expanded proxy — and touches no process while the session is live.
      const first = await launchBlazorWasm(fakeFolder(FIXTURE), launchConfig());
      assert.ok(first.ok, `the fake app served an address; ${JSON.stringify(first)}`);
      const firstRun = runs[0];
      const firstHanded = handed[0];
      assert.ok(firstRun !== undefined && firstHanded !== undefined);
      assert.deepStrictEqual(firstRun.args, [
        'run',
        '--project',
        PROJECT,
        '--launch-profile',
        'http',
      ]);
      assert.strictEqual(firstRun.cwd, path.dirname(PROJECT));
      assert.strictEqual(firstHanded.type, 'pwa-chrome');
      assert.strictEqual(firstHanded.url, HTTP_ADDRESS);
      assert.strictEqual(firstHanded.inspectUri, HTTP_INSPECT);
      assert.strictEqual(firstHanded.webRoot, path.join(FIXTURE, 'wwwroot'));
      assert.strictEqual(first.value.url, HTTP_ADDRESS);
      assert.strictEqual(firstRun.stops(), 0);
      assert.strictEqual(runningBlazorWasmLaunch(PROJECT), first.value);

      // 2. A second launch of the SAME project replaces the first: the old app
      //    is stopped once, so two DevServers never race for one port.
      const second = await launchBlazorWasm(fakeFolder(FIXTURE), launchConfig());
      assert.ok(second.ok);
      const secondRun = runs[1];
      assert.ok(secondRun !== undefined);
      assert.strictEqual(firstRun.stops(), 1);
      assert.strictEqual(handed.length, 2);
      assert.strictEqual(runningBlazorWasmLaunch(PROJECT), second.value);

      // 3. The browser session ends, and with it the app it was attached to —
      //    and only that app, and only once.
      endBrowser();
      await second.value.ended;
      assert.strictEqual(secondRun.stops(), 1);
      assert.strictEqual(firstRun.stops(), 1);
      assert.strictEqual(runningBlazorWasmLaunch(PROJECT), undefined);
    } finally {
      restore();
    }
  });

  test('stops the served app when the browser never starts, or the app dies during the handoff', async () => {
    const runs: FakeRun[] = [];
    let browser: () => Promise<{ readonly ended: Promise<void> } | undefined> = () =>
      Promise.resolve(undefined);
    const restore = useBlazorWasmHost({
      startProcess: (args, cwd, onOutput) => {
        const run = fakeRun(args, cwd, onOutput);
        runs.push(run);
        run.announce([`      Now listening on: ${HTTP_ADDRESS}`]);
        return run.process;
      },
      startBrowserSession: () => browser(),
    });
    try {
      // 1. The app served its address, but js-debug never started: the app is
      //    stopped, and the refusal names the browser and the address.
      const refused = await launchBlazorWasm(fakeFolder(FIXTURE), launchConfig());
      assert.strictEqual(refused.ok, false);
      assert.strictEqual(
        refused.ok ? '' : refused.error,
        `Could not start pwa-chrome for ${HTTP_ADDRESS}.`,
      );
      assert.strictEqual(runs[0]?.stops(), 1, 'the served app is stopped once');
      assert.strictEqual(runningBlazorWasmLaunch(PROJECT), undefined);

      // 2. The browser started, but the app had died meanwhile: its reason is
      //    carried into the refusal, and nothing is left running.
      browser = async () => {
        runs[1]?.crash('the DevServer crashed');
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { ended: new Promise<void>(() => undefined) };
      };
      const died = await launchBlazorWasm(fakeFolder(FIXTURE), launchConfig());
      assert.strictEqual(died.ok, false);
      assert.strictEqual(
        died.ok ? '' : died.error,
        'dotnet run for BlazorWasmApp.csproj stopped before it served anything: the DevServer crashed',
      );
      assert.strictEqual(runs.length, 2);
      assert.strictEqual(runningBlazorWasmLaunch(PROJECT), undefined);
    } finally {
      restore();
    }
  });

  test('names why a launch has no project, or why its startup failed', async () => {
    // 1. With no folder, a relative project cannot be resolved, and a missing
    //    project is never assumed.
    assert.deepStrictEqual(
      projectAt(undefined, 'App.csproj'),
      err("Cannot resolve 'App.csproj' without a workspace folder."),
    );
    assert.deepStrictEqual(
      await resolveProject(undefined, undefined),
      err('Blazor WebAssembly launch found no runnable project for this workspace.'),
    );

    // 2. Without a stated project, the folder's only project is the one launched;
    //    a folder holding none is refused, never guessed at.
    assert.deepStrictEqual(await resolveProject(fakeFolder(FIXTURE), '  '), ok(PROJECT));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sharplsp-wasm-empty-'));
    try {
      const none = await resolveProject(fakeFolder(empty), undefined);
      assert.strictEqual(none.ok, false, 'an empty folder has no project to launch');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }

    // 3. A project file that cannot be read is not a Blazor WebAssembly app, and
    //    an address that is not a URL is not announced.
    assert.strictEqual(isBlazorWasmProjectFile(path.join(FIXTURE, 'Missing.csproj')), false);
    assert.strictEqual(isBlazorWasmProjectFile(PROJECT), true);
    assert.strictEqual(listeningUrlOf('      Now listening on: http://[::1'), undefined);

    // 4. A startup that timed out or exited says which, by project name.
    assert.match(
      startupFailure({ kind: 'timeout' }, PROJECT),
      /^dotnet run for BlazorWasmApp\.csproj announced no listening URL within 180s\./u,
    );
    assert.strictEqual(
      startupFailure({ kind: 'exited', outcome: ok(undefined) }, PROJECT),
      'dotnet run for BlazorWasmApp.csproj exited before it announced a listening URL.',
    );
  });

  test('refuses a project that stops before it serves anything', async () => {
    const restore = useBlazorWasmHost({
      startProcess: (args, cwd, onOutput) => {
        const run = fakeRun(args, cwd, onOutput);
        run.crash('MSB1009: Project file does not exist.');
        return run.process;
      },
      startBrowserSession: () => Promise.resolve(undefined),
    });
    try {
      // 1. dotnet's own reason is carried into the refusal, named by project.
      const failed = await launchBlazorWasm(fakeFolder(FIXTURE), launchConfig());
      assert.strictEqual(failed.ok, false);
      assert.match(
        failed.ok ? '' : failed.error,
        /dotnet run for BlazorWasmApp\.csproj stopped before it served anything: MSB1009/u,
      );
      assert.strictEqual(runningBlazorWasmLaunch(PROJECT), undefined);

      // 2. A project path that does not exist is refused before a process runs.
      const missing = await launchBlazorWasm(
        fakeFolder(FIXTURE),
        launchConfig({ project: path.join(FIXTURE, 'Nope.csproj') }),
      );
      assert.strictEqual(missing.ok, false);
      assert.match(missing.ok ? '' : missing.error, /project not found/iu);

      // 3. A profile the project does not declare is refused, not ignored.
      const unknownProfile = await launchBlazorWasm(
        fakeFolder(FIXTURE),
        launchConfig({ launchProfile: 'nope' }),
      );
      assert.strictEqual(unknownProfile.ok, false);
      assert.match(unknownProfile.ok ? '' : unknownProfile.error, /'nope' is not declared/iu);
    } finally {
      restore();
    }
  });
});
