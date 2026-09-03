// [DIST-DEBUGGER-BUNDLE] End-to-end tests for how SharpLsp obtains the patched
// netcoredbg debug adapter. Run by `make _test-tooling`.
//
// The adapter is the process users attach to their own code with. It used to be
// compiled inside the release pipeline from two repositories cloned at build
// time, with no digest checked and no provenance recorded - so these tests exist
// to hold the replacement honest. provide.mjs must DOWNLOAD a pinned artifact,
// must verify the bytes it actually received, and must REFUSE rather than fall
// back to a source build when the digest does not match. A silent fallback would
// turn a supply-chain alarm into a slow build and defeat the pin entirely.
//
// These drive the REAL script over a REAL HTTP server and a REAL tar archive.
// Nothing about the download path is stubbed, because the bug this guards
// against lives in exactly that plumbing.
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PROVIDE = join(HERE, 'provide.mjs');
const LOCK = join(HERE, 'netcoredbg.lock.json');

// linux-arm64 is a supported platform that no CI leg builds, so driving the real
// code path here cannot collide with a genuine adapter on the runner.
const PLATFORM = 'linux-arm64';
const OUTPUT = join(ROOT, 'target', 'netcoredbg', PLATFORM, 'netcoredbg');

let scratch = '';
let server;
let baseUrl = '';

/**
 * Builds a tar.gz shaped exactly like a published adapter archive.
 *
 * Every tar argument is relative and the working directory carries the path,
 * because GNU tar reads an argument containing a colon as `host:path` and would
 * try to reach a remote machine called `C`. provide.mjs extracts under the same
 * constraint.
 */
function buildArchive(body) {
    const stage = join(scratch, `stage-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(stage, 'netcoredbg'), { recursive: true });
    writeFileSync(join(stage, 'netcoredbg', 'netcoredbg'), body);
    const packed = spawnSync('tar', ['-czf', 'adapter.tar.gz', 'netcoredbg'], { cwd: stage });
    assert.equal(packed.status, 0, `tar failed: ${packed.stderr?.toString()}`);
    return readFileSync(join(stage, 'adapter.tar.gz'));
}

/**
 * Runs provide.mjs against a lock file pinning the served archive to `sha256`.
 *
 * Deliberately async: the archive is served from THIS process, and spawnSync
 * blocks the event loop, so a synchronous child could never be answered and the
 * test would hang instead of failing.
 */
function provide(sha256) {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    lock.platforms = { [PLATFORM]: { url: baseUrl, sha256 } };
    const lockPath = join(scratch, 'netcoredbg.lock.json');
    writeFileSync(lockPath, JSON.stringify(lock));

    return new Promise((done, fail) => {
        const child = spawn(process.execPath, [PROVIDE, PLATFORM], {
            cwd: ROOT,
            env: { ...process.env, SHARPLSP_NETCOREDBG_LOCK: lockPath },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', fail);
        child.on('close', (status) => done({ status, stdout, stderr }));
    });
}

/** Serves whatever `served` currently holds, so each test can swap the bytes. */
let served = Buffer.alloc(0);

before(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'sharplsp-netcoredbg-'));
    server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/gzip' });
        response.end(served);
    });
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
    baseUrl = `http://127.0.0.1:${server.address().port}/netcoredbg-${PLATFORM}.tar.gz`;
});

beforeEach(() => {
    rmSync(OUTPUT, { recursive: true, force: true });
});

after(() => {
    server?.close();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(OUTPUT, { recursive: true, force: true });
});

test('a pinned artifact whose digest matches is downloaded and unpacked', async () => {
    served = buildArchive('patched-adapter');
    const digest = createHash('sha256').update(served).digest('hex');

    const result = await provide(digest);

    assert.equal(result.status, 0, `provide.mjs failed: ${result.stderr}`);
    assert.ok(existsSync(join(OUTPUT, 'netcoredbg')), 'verified archive should be unpacked');
    assert.equal(
        readFileSync(join(OUTPUT, 'netcoredbg'), 'utf8'),
        'patched-adapter',
        'the unpacked adapter should be the bytes that were served',
    );
    // The marker is what lets a later run - and the CI cache - recognise this as
    // the build the lock file describes.
    assert.ok(
        existsSync(join(OUTPUT, '.sharplsp-dap-hot-reload')),
        'the build-id marker should be written after a verified unpack',
    );
    assert.ok(
        !existsSync(join(OUTPUT, 'netcoredbg-download.tar.gz')),
        'the staged download should be cleaned up',
    );
});

test('an adapter already on disk is not downloaded again', async () => {
    served = buildArchive('patched-adapter');
    const digest = createHash('sha256').update(served).digest('hex');
    await provide(digest);

    const second = await provide(digest);

    assert.equal(second.status, 0);
    assert.match(
        second.stdout,
        /already available/,
        'a second call should short-circuit on the marker, not re-download',
    );
});

test('a digest mismatch REFUSES, and does not fall back to a source build', async () => {
    served = buildArchive('tampered-adapter');
    const wrong = createHash('sha256').update('something else entirely').digest('hex');

    const result = await provide(wrong);

    assert.notEqual(result.status, 0, 'a digest mismatch must fail the build');
    assert.match(result.stderr, /SHA-256 MISMATCH/, `expected a mismatch diagnostic: ${result.stderr}`);
    assert.ok(
        !existsSync(join(OUTPUT, 'netcoredbg')),
        'nothing may be unpacked from an archive that failed verification',
    );
    // The whole point of the pin: a bad digest is an alarm, not a reason to
    // quietly compile the adapter from source instead.
    assert.doesNotMatch(
        `${result.stdout}${result.stderr}`,
        /building from source/,
        'a mismatch must not fall back to a source build',
    );
});

test('the lock file is the only place the pinned commits are written down', () => {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    for (const field of ['netcoredbgCommit', 'coreclrCommit', 'patchVersion']) {
        assert.ok(lock[field], `netcoredbg.lock.json must declare ${field}`);
    }
    // A second copy of a commit in the build script is how a pin and the
    // artifact it is supposed to describe drift apart.
    const script = readFileSync(join(ROOT, 'tools', 'vsix', 'build-netcoredbg.sh'), 'utf8');
    assert.ok(
        !script.includes(lock.netcoredbgCommit),
        'build-netcoredbg.sh must read the commit from the lock file, not hardcode it',
    );
});

test('an unsupported platform skips cleanly instead of failing the build', () => {
    // darwin-x64 and win32-arm64 have no patched build; the extension falls back
    // to PATH / sharplsp.debug.netcoredbgPath, so this must not be an error.
    const result = spawnSync(process.execPath, [PROVIDE, 'darwin-x64'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, 'an unsupported platform must not fail the build');
    assert.match(result.stderr, /no patched build/);
});

test('an unknown platform is a hard error', () => {
    const result = spawnSync(process.execPath, [PROVIDE, 'bogus-arch'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, 'a typo in a platform triple must not pass silently');
    assert.match(result.stderr, /unknown platform/);
});
