// Blazor WebAssembly debugging, end to end: a REAL `dotnet run` of a REAL
// Blazor WebAssembly app, handed to js-debug, and stopped with the session.
// Spec: [DEBUG-FEATURES-LAUNCH-BLAZOR-WASM].
//
// The launch is driven exactly as a user drives it — `vscode.debug.startDebugging`
// with a `sharplsp-blazorwasm` configuration, through the provider the extension
// registered at activation. Only the browser session itself is replaced, by the
// shipped `useBlazorWasmHost` seam: a headless host has no js-debug to start, and
// what this suite must prove is the configuration js-debug would have received
// and the app that answers behind it.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  runningBlazorWasmLaunch,
  useBlazorWasmHost,
  type RunningLaunch,
} from '../../blazor-wasm-launch.js';
import { copyPinnedFixture, dotnet } from './dotnet-project-kit';
import { authoredPackageJson } from './run-debug-kit';
import {
  comparablePath,
  pollUntilResult,
  removeDirRecursive,
  requireWorkspaceRoot,
} from './test-helpers';
import { DEBUG_SESSION_MS, FIXTURE_BUILD_MS, POLL_INTERVAL_MS } from './test-timeouts';

/** The Blazor WebAssembly fixture in the repository. */
const SOURCE = path.resolve(__dirname, '../../../../../sharplsp/tests/fixtures/blazor-wasm');

/** The project the launch is pointed at, relative to the fixture root. */
const PROJECT_NAME = 'BlazorWasmApp.csproj';

/**
 * The manifest as AUTHORED, which is not what VS Code core hands back: core
 * injects its own attributes into every debugger it loads
 * ([DEBUG-FEATURES-LAUNCH-OUTPUT] rule 5).
 */
interface AuthoredDebugger {
  readonly type?: string;
  readonly configurationAttributes?: { readonly launch?: { properties?: object } };
  readonly configurationSnippets?: { readonly body?: { readonly type?: string } }[];
}

/** The parts of the authored manifest this suite judges. */
interface AuthoredManifest {
  readonly activationEvents?: string[];
  readonly contributes?: { readonly debuggers?: AuthoredDebugger[] };
}

/** The page the DevServer answers the debug proxy on. */
const DEBUG_PROXY_PATH = '/_framework/debug';

/** Copy the fixture to `root` and build it, so the launch only has to run it. */
async function writeFixture(root: string): Promise<void> {
  copyPinnedFixture(SOURCE, root);
  await dotnet(['build', '--nologo'], root);
}

/** An HTTP status for `url`, or undefined when nothing answers. */
function statusOf(url: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', () => {
      resolve(undefined);
    });
    request.setTimeout(5_000, () => {
      request.destroy();
      resolve(undefined);
    });
  });
}

/**
 * The scratch copy of the fixture this suite works against.
 *
 * Inside the OPENED workspace folder, as every debug suite's scratch tree is: a
 * session started against a temp directory has no `workspaceFolder`, which is a
 * different refusal path from the one under test here.
 */
let root = '';

/** Everything the browser session received, in order. */
const handed: vscode.DebugConfiguration[] = [];

/** How many browser sessions were started. */
let sessions = 0;

/** Ends the browser session the launch is waiting on. */
let endBrowser: () => void = () => undefined;

/** The fixture, built, with the browser session replaced by a recorder. */
suiteSetup(async function () {
  this.timeout(FIXTURE_BUILD_MS);
  root = fs.mkdtempSync(path.join(requireWorkspaceRoot(), 'blazor-wasm-'));
  await writeFixture(root);
  useBlazorWasmHost({
    startBrowserSession: (_folder, configuration) => {
      handed.push(configuration);
      sessions += 1;
      return Promise.resolve({
        ended: new Promise<void>((resolve) => {
          endBrowser = resolve;
        }),
      });
    },
  });
});

suiteTeardown(function () {
  this.timeout(DEBUG_SESSION_MS);
  removeDirRecursive(root);
});

/** The project file of the scratch copy. */
function projectFile(): string {
  return path.join(root, PROJECT_NAME);
}

/** A `sharplsp-blazorwasm` configuration for the scratch project. */
function launchConfiguration(): vscode.DebugConfiguration {
  return {
    type: 'sharplsp-blazorwasm',
    request: 'launch',
    name: 'Launch Blazor WebAssembly',
    project: projectFile(),
    browser: 'chrome',
  };
}

/** Start the launch through the provider the extension registered, and wait for it. */
async function startLaunch(): Promise<RunningLaunch> {
  const folder: vscode.WorkspaceFolder = {
    uri: vscode.Uri.file(requireWorkspaceRoot()),
    name: path.basename(requireWorkspaceRoot()),
    index: 0,
  };
  const wanted = sessions + 1;
  // The provider hands off to js-debug and answers `undefined`, which is how a
  // provider starts NO session of its own — so `false` here is success, and the
  // seam is what says the launch reached the browser.
  await vscode.debug.startDebugging(folder, launchConfiguration());
  const launch = await pollUntilResult(
    () => Promise.resolve(runningBlazorWasmLaunch(projectFile())),
    (found) => found !== undefined && sessions === wanted,
    FIXTURE_BUILD_MS,
    POLL_INTERVAL_MS,
    'the Blazor WebAssembly launch to serve and hand off',
  );
  assert.ok(launch, 'the launch registers itself while it runs');
  return launch;
}

suite('Blazor WebAssembly debugging', () => {
  test('serves the app, hands js-debug the proxy and dies with the session', async function () {
    this.timeout(FIXTURE_BUILD_MS + DEBUG_SESSION_MS);

    // 1. The user presses F5 on a `sharplsp-blazorwasm` launch. `dotnet run`
    //    builds and serves the app, and js-debug receives the expanded proxy.
    const launch = await startLaunch();
    const configuration = handed[0];
    assert.ok(configuration !== undefined, 'js-debug was handed a configuration');
    assert.strictEqual(configuration.type, 'pwa-chrome', 'chrome maps onto pwa-chrome');
    assert.strictEqual(configuration.request, 'launch');
    assert.strictEqual(configuration.name, 'Launch Blazor WebAssembly');
    assert.ok(
      /^http:\/\/127\.0\.0\.1:\d+$/u.test(launch.url),
      `the DevServer's own address is launched: ${launch.url}`,
    );
    assert.strictEqual(configuration.url, launch.url, 'the browser opens the real address');
    const expanded = `ws://${new URL(launch.url).host}${DEBUG_PROXY_PATH}/ws-proxy?browser={browserInspectUri}`;
    assert.strictEqual(configuration.inspectUri, expanded, 'the proxy carries host and port');
    assert.ok(
      !configuration.inspectUri.includes('{wsProtocol}'),
      'every token but {browserInspectUri} is expanded',
    );
    assert.strictEqual(
      comparablePath(configuration.webRoot),
      comparablePath(path.join(root, 'wwwroot')),
      'webRoot defaults to the project wwwroot',
    );

    // 2. The proxy the configuration names is really served: a GET of the
    //    DevServer's `/_framework/debug` answers 200, which only the dev server
    //    package produces. TWICE, so a single lucky answer cannot pass.
    const status = await statusOf(`${launch.url}${DEBUG_PROXY_PATH}`);
    assert.strictEqual(status, 200, `the .NET debug proxy answers on ${launch.url}`);
    const again = await statusOf(`${launch.url}${DEBUG_PROXY_PATH}`);
    assert.strictEqual(again, 200, 'and keeps answering');
    const page = await statusOf(`${launch.url}/`);
    assert.strictEqual(page, 200, 'the app itself is served too');

    // 3. The user stops the browser session: the app it was attached to stops
    //    with it, and the port it held is released. Polled, because the stop is
    //    a signal and the process takes a moment to go.
    endBrowser();
    await launch.ended;
    assert.strictEqual(
      runningBlazorWasmLaunch(projectFile()),
      undefined,
      'a finished launch is not registered',
    );
    const closed = await pollUntilResult(
      () => statusOf(`${launch.url}${DEBUG_PROXY_PATH}`),
      (status) => status !== 200,
      DEBUG_SESSION_MS,
      POLL_INTERVAL_MS,
      'the DevServer to stop answering once the browser session ended',
    );
    assert.notStrictEqual(closed, 200, 'the dotnet run process is gone');
  });

  test('stops the app it replaced when the same project launches twice', async function () {
    this.timeout(FIXTURE_BUILD_MS + DEBUG_SESSION_MS);

    // 1. A launch of the project, serving.
    const first = await startLaunch();
    assert.strictEqual(sessions, 2, 'the recorder saw the session');
    assert.strictEqual(await statusOf(`${first.url}${DEBUG_PROXY_PATH}`), 200);

    // 2. A second launch of the SAME project: one DevServer may hold the port,
    //    so the first is stopped and the second takes over the registry.
    const second = await startLaunch();
    assert.notStrictEqual(second.url, first.url, 'the second app bound its own address');
    assert.strictEqual(runningBlazorWasmLaunch(projectFile()), second);
    await pollUntilResult(
      () => statusOf(`${first.url}${DEBUG_PROXY_PATH}`),
      (status) => status !== 200,
      DEBUG_SESSION_MS,
      POLL_INTERVAL_MS,
      'the replaced DevServer to stop answering',
    );

    // 3. Ending the browser session ends only what it was attached to.
    endBrowser();
    await second.ended;
    assert.notStrictEqual(await statusOf(`${second.url}${DEBUG_PROXY_PATH}`), 200);
    assert.strictEqual(runningBlazorWasmLaunch(projectFile()), undefined);
  });

  test('contributes the debugger, its snippet and its activation events', async function () {
    this.timeout(DEBUG_SESSION_MS);

    // 1. The extension activated, so the providers a launch needs are registered.
    const extension = vscode.extensions.getExtension('nimblesite.sharplsp');
    assert.ok(extension !== undefined, 'the SharpLsp extension is installed in the host');
    await extension.activate();
    assert.strictEqual(extension.isActive, true);

    // 2. Both debuggers are declared: the C#/F# one, and the Blazor WebAssembly
    //    one, whose launch properties are what `launch.json` IntelliSense reads.
    //    Read from the AUTHORED manifest, because the loaded one is merged with
    //    core's injected attributes and would report properties we never wrote.
    const manifest = authoredPackageJson() as AuthoredManifest;
    const debuggers = manifest.contributes?.debuggers ?? [];
    const wasm = debuggers.find((entry) => entry.type === 'sharplsp-blazorwasm');
    assert.ok(
      wasm !== undefined,
      `contributed debuggers: ${debuggers.map((d) => d.type).join(', ')}`,
    );
    const properties = Object.keys(wasm.configurationAttributes?.launch?.properties ?? {}).sort();
    assert.deepStrictEqual(properties, [
      'browser',
      'launchProfile',
      'project',
      'timeout',
      'url',
      'webRoot',
    ]);
    const snippets = wasm.configurationSnippets?.map((snippet) => snippet.body?.type) ?? [];
    assert.deepStrictEqual(snippets, ['sharplsp-blazorwasm'], 'one snippet, of this type');

    // 3. The type makes the extension activate before it is used, and the
    //    manifest the host loaded agrees with the one in the source tree.
    assert.ok(manifest.activationEvents?.includes('onDebugResolve:sharplsp-blazorwasm'));
    assert.ok(
      manifest.activationEvents?.includes('onDebugDynamicConfigurations:sharplsp-blazorwasm'),
    );
  });
});
