// Skipped regression for #388: String.Trim XML docs missing in published v0.33.0.
// Run with: RUN_RELEASE_REGRESSIONS=1 SHARPLSP_RELEASE_BUNDLE=/abs/path node tools/release/fsharp-hover-docs.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const { createMessageConnection } = require('../../src/editors/vscode/node_modules/vscode-jsonrpc/lib/node/main.js');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, isAbsolute } = require('node:path');
const { pathToFileURL } = require('node:url');

const source = `module Probe
let trimmed = " hello ".Trim()
`;

test('#388 F# hover on String.Trim includes XML docs in released v0.33.0 bundle', { skip: process.env.RUN_RELEASE_REGRESSIONS === '1' ? false : '#388 String.Trim XML docs missing in published v0.33.0' }, async () => {
  const bundle = process.env.SHARPLSP_RELEASE_BUNDLE;
  assert.ok(bundle && isAbsolute(bundle), 'SHARPLSP_RELEASE_BUNDLE must be an absolute directory');
  const bundleDir = resolve(bundle);
  const host = join(bundleDir, 'sharplsp');
  const csharpEngine = join(bundleDir, 'sidecar-csharp/SharpLsp.Sidecar.CSharp');
  const fsharpEngine = join(bundleDir, 'sidecar-fsharp/SharpLsp.Sidecar.FSharp');
  const version = execFileSync(host, ['--version'], { encoding: 'utf8', timeout: 30000 });
  assert.ok(version.includes('0.33.0'), `host --version must be 0.33.0, got: ${version.trim()}`);

  const root = mkdtempSync(join(tmpdir(), 'sharplsp-388-'));
  writeFileSync(join(root, 'Directory.Build.props'), '<Project />');
  writeFileSync(join(root, 'Directory.Build.targets'), '<Project />');
  writeFileSync(join(root, 'Probe.fsproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include="Probe.fs" /></ItemGroup></Project>');
  writeFileSync(join(root, 'Probe.fs'), source);
  execFileSync('dotnet', ['restore', join(root, 'Probe.fsproj'), '--disable-parallel'], { env: { ...process.env, DOTNET_PROCESSOR_COUNT: '2' }, stdio: 'pipe', timeout: 60000 });

  const child = spawn(host, [], { cwd: root, env: { ...process.env, DOTNET_PROCESSOR_COUNT: '2', SHARPLSP_CSHARP_SIDECAR_PATH: csharpEngine, SHARPLSP_FSHARP_SIDECAR_PATH: fsharpEngine }, stdio: ['pipe', 'pipe', 'pipe'] });
  const connection = createMessageConnection(child.stdout, child.stdin);
  child.stderr.resume();
  let timeout;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('LSP request exceeded 90s')), 90000); });
  const request = (method, params) => Promise.race([connection.sendRequest(method, params), deadline]);
  try {
    connection.onRequest('workspace/configuration', params => params.items.map(() => null));
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.listen();
    await request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {} });
    await connection.sendNotification('initialized', {});
    const document = { uri: pathToFileURL(join(root, 'Probe.fs')).href };
    await connection.sendNotification('textDocument/didOpen', { textDocument: { ...document, languageId: 'fsharp', version: 1, text: source } });
    const line = source.split('\n')[1];
    const character = line.indexOf('Trim') + 2;
    const hover = await request('textDocument/hover', { textDocument: document, position: { line: 1, character } });
    assert.ok(hover, 'hover on Trim must be nonnull');
    const contents = JSON.stringify(hover.contents);
    assert.ok(contents.includes('Trim'), `hover must contain signature Trim: ${contents}`);
    assert.ok(contents.includes('Removes all leading and trailing white-space characters'), `hover must contain Trim XML doc: ${contents}`);
  } finally {
    try { await request('shutdown', null); await connection.sendNotification('exit'); } catch { /* host may already be gone */ }
    clearTimeout(timeout);
    connection.dispose();
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
