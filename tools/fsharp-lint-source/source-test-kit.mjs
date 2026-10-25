// Real source-preparation CLI fixtures. [DIAG-CATEGORIES-ANALYZER]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const revision = 'd2607f5c68fe0e8c0366e815692cb8d314e254a3';
export const archiveSha = '054e41159b63e3da77dd6f079d40b386d399075f214c9687654215da38f01ff8';
const artifact = resolve(process.env.SHARPLSP_LINT_SOURCE_ARTIFACT ??
    fileURLToPath(new URL('../../target/lint-source-builder', import.meta.url)));
export const archive = join(artifact, 'upstream.tar.gz');
export const builder = join(artifact, 'lint-source-build.dll');
export const childPath = join;

export function scratch(t) {
    const parent = resolve(tmpdir());
    const root = mkdtempSync(join(parent, 'sharplsp-lint-source-'));
    assert.equal(dirname(root), parent, 'cleanup is restricted to this owned temporary directory');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

export function invoke(args) {
    const run = spawnSync(process.env.DOTNET_HOST_PATH ?? 'dotnet', [builder, ...args], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' },
    });
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(run.signal, null, run.stderr);
    assert.equal(run.stderr, '', 'the CLI reports failures through its structured result');
    return { status: run.status, result: JSON.parse(run.stdout) };
}

export function hash(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function preparedPaths(destination) {
    const root = join(destination, `FSharpLint-${revision}`);
    return {
        target: join(root, 'src/FSharpLint.Core/Rules/NamingHelper.fs'),
        state: join(root, 'src/FSharpLint.Core/Rules/Conventions/CyclomaticComplexity.fs'),
        fingerprint: join(destination, '.lint-source-build.fingerprint.json'),
        provenance: join(destination, 'PROVENANCE.md'),
        license: join(root, 'LICENSE'),
    };
}

export function assertPrepared(destination) {
    const files = preparedPaths(destination);
    const fingerprint = JSON.parse(readFileSync(files.fingerprint, 'utf8'));
    assert.equal(fingerprint.toolVersion, '2.0.0');
    assert.match(fingerprint.toolIdentity, /^[0-9a-f-]{36}$/u);
    assert.equal(fingerprint.archiveSha256, archiveSha);
    assert.equal(fingerprint.revision, revision);
    assert.equal(fingerprint.targetRelative, `FSharpLint-${revision}/src/FSharpLint.Core/Rules/NamingHelper.fs`);
    assert.equal(fingerprint.targetSha256, hash(files.target));
    assert.equal(fingerprint.ruleStateSha256, hash(files.state));
    assert.ok(statSync(files.license).size > 100, 'the genuine upstream license survives preparation');
    assert.ok(readFileSync(files.provenance, 'utf8').includes(archiveSha), 'provenance records verified bytes');
    return fingerprint;
}

export function settledSnapshot(files) {
    const stamp = new Date('2000-01-01T00:00:00Z');
    for (const file of Object.values(files)) utimesSync(file, stamp, stamp);
    return snapshot(files);
}

export function snapshot(files) {
    return Object.fromEntries(Object.entries(files).map(([name, file]) =>
        [name, { sha: hash(file), modified: statSync(file).mtimeMs }]));
}
