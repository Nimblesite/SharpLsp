// [DIST-DEBUGGER-BUNDLE] End-to-end tests for how SharpLsp obtains the upstream
// netcoredbg debug adapter. Run by `make _test-tooling`.
//
// The adapter is the process users attach to their own code with. SharpLsp never
// compiles it: provide.mjs must DOWNLOAD the pinned Samsung/netcoredbg release,
// must verify the bytes it actually received, and must REFUSE when the digest
// does not match or a supported platform has no pin. There is no source build to
// fall back to, and nothing in the repo may reintroduce one.
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
const STAGED = join(ROOT, 'src', 'editors', 'vscode', 'bin', PLATFORM);
const FETCH = join(ROOT, 'tools', 'vsix', 'fetch-netcoredbg.sh');
const MARKER = '.sharplsp-netcoredbg-release';

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
 * Runs `command` against a lock file pinning the served archive to `sha256`.
 *
 * Deliberately async: the archive is served from THIS process, and spawnSync
 * blocks the event loop, so a synchronous child could never be answered and the
 * test would hang instead of failing.
 */
function runPinned(sha256, command, args) {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    lock.platforms = { [PLATFORM]: { url: baseUrl, sha256 } };
    const lockPath = join(scratch, 'netcoredbg.lock.json');
    writeFileSync(lockPath, JSON.stringify(lock));

    return new Promise((done, fail) => {
        const child = spawn(command, args, {
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

/** provide.mjs, the step that guarantees target/ holds the pinned adapter. */
function provide(sha256) {
    return runPinned(sha256, process.execPath, [PROVIDE, PLATFORM]);
}

/** fetch-netcoredbg.sh, the step that stages that adapter into the extension. */
function stage(sha256) {
    return runPinned(sha256, 'bash', [FETCH, PLATFORM]);
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
    rmSync(STAGED, { recursive: true, force: true });
});

after(() => {
    server?.close();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(OUTPUT, { recursive: true, force: true });
    rmSync(STAGED, { recursive: true, force: true });
});

test('a pinned artifact whose digest matches is downloaded and unpacked', async () => {
    served = buildArchive('upstream-adapter');
    const digest = createHash('sha256').update(served).digest('hex');

    const result = await provide(digest);

    assert.equal(result.status, 0, `provide.mjs failed: ${result.stderr}`);
    assert.ok(existsSync(join(OUTPUT, 'netcoredbg')), 'verified archive should be unpacked');
    assert.equal(
        readFileSync(join(OUTPUT, 'netcoredbg'), 'utf8'),
        'upstream-adapter',
        'the unpacked adapter should be the bytes that were served',
    );
    // The marker is what lets a later run - and the CI cache - recognise this as
    // the build the lock file describes.
    assert.ok(
        existsSync(join(OUTPUT, MARKER)),
        'the build-id marker should be written after a verified unpack',
    );
    assert.ok(
        !existsSync(join(OUTPUT, 'netcoredbg-download')),
        'the staged download should be cleaned up',
    );
});

test('an adapter already on disk is not downloaded again', async () => {
    served = buildArchive('upstream-adapter');
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

test('staging never ships an adapter an older lock file described', async () => {
    // A developer's target/ and bin/ still hold the build the PREVIOUS lock
    // pinned - say, from before a release bump. Existence is not freshness:
    // staging that build ships the wrong release.
    for (const directory of [OUTPUT, join(STAGED, 'netcoredbg')]) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'netcoredbg'), 'stale-adapter');
        writeFileSync(join(directory, MARKER), 'older-release\n');
    }
    served = buildArchive('upstream-adapter');
    const digest = createHash('sha256').update(served).digest('hex');
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));

    const result = await stage(digest);

    assert.equal(result.status, 0, `fetch-netcoredbg.sh failed: ${result.stderr}`);
    assert.equal(
        readFileSync(join(OUTPUT, 'netcoredbg'), 'utf8'),
        'upstream-adapter',
        'a build whose marker names an older lock must be provided again',
    );
    assert.equal(
        readFileSync(join(STAGED, 'netcoredbg', 'netcoredbg'), 'utf8'),
        'upstream-adapter',
        'the extension must be staged with the build the lock describes',
    );
    assert.equal(
        readFileSync(join(STAGED, 'netcoredbg', MARKER), 'utf8').trim(),
        lock.release,
        'the staged marker names the current build',
    );

    const again = await stage(digest);

    assert.equal(again.status, 0, `a second staging failed: ${again.stderr}`);
    assert.match(again.stdout, /already staged/, 'a current staged build is left alone');
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

test('the lock file pins every supported platform to the upstream release', () => {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    assert.ok(lock.release, 'netcoredbg.lock.json must name the upstream release');
    for (const field of ['netcoredbgCommit', 'coreclrCommit', 'patchVersion']) {
        assert.equal(lock[field], undefined, `${field} described a source build, which no longer exists`);
    }
    const prefix = `https://github.com/Samsung/netcoredbg/releases/download/${lock.release}/`;
    for (const platform of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64']) {
        const pin = lock.platforms[platform];
        assert.ok(pin, `${platform} must be pinned: a supported platform with no pin cannot be provided`);
        assert.ok(pin.url.startsWith(prefix), `${platform} must download the named upstream release`);
        assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${platform} must pin a SHA-256 digest`);
    }
});

test('nothing in the repo can compile the debugger', () => {
    for (const path of [
        join(ROOT, 'tools', 'vsix', 'build-netcoredbg.sh'),
        join(ROOT, 'tools', 'netcoredbg', 'dap-hot-reload.patch'),
        join(ROOT, 'tools', 'netcoredbg', 'exception-stepping.patch'),
        join(ROOT, '.github', 'workflows', 'publish-netcoredbg.yml'),
    ]) {
        assert.ok(!existsSync(path), `${path} builds or patches netcoredbg; SharpLsp only downloads it`);
    }
    const provider = readFileSync(PROVIDE, 'utf8');
    for (const compile of ['build-netcoredbg', 'cmake', 'buildFromSource']) {
        assert.ok(!provider.includes(compile), `provide.mjs must never compile the debugger ('${compile}')`);
    }
});

test('a supported platform with no pin is a hard error, not a source build', () => {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    lock.platforms = {};
    const lockPath = join(scratch, 'unpinned.lock.json');
    writeFileSync(lockPath, JSON.stringify(lock));

    const result = spawnSync(process.execPath, [PROVIDE, PLATFORM], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, SHARPLSP_NETCOREDBG_LOCK: lockPath },
    });

    assert.notEqual(result.status, 0, 'an unpinned supported platform must fail the build');
    assert.match(result.stderr, /no pinned download/, `expected a missing-pin diagnostic: ${result.stderr}`);
    assert.ok(!existsSync(join(OUTPUT, 'netcoredbg')), 'nothing may be provided without a pin');
});

test('an unsupported platform skips cleanly instead of failing the build', () => {
    // Upstream publishes no darwin-x64 or win32-arm64 build; the extension falls
    // back to PATH / sharplsp.debug.netcoredbgPath, so this must not be an error.
    const result = spawnSync(process.execPath, [PROVIDE, 'darwin-x64'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, 'an unsupported platform must not fail the build');
    assert.match(result.stderr, /no upstream build/);
});

test('an unknown platform is a hard error', () => {
    const result = spawnSync(process.execPath, [PROVIDE, 'bogus-arch'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, 'a typo in a platform triple must not pass silently');
    assert.match(result.stderr, /unknown platform/);
});
