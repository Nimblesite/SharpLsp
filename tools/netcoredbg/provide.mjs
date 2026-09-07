#!/usr/bin/env node
// [DIST-DEBUGGER-BUNDLE] Guarantees that target/netcoredbg/<platform>/netcoredbg
// holds the patched debug adapter SharpLsp ships, and returns without doing any
// work when it already does.
//
// PREFER THE PINNED ARTIFACT. When netcoredbg.lock.json pins a URL and SHA-256
// for the platform, this downloads it, hashes the bytes it actually received,
// and unpacks it only if the digest matches. A mismatch is FATAL: it never
// falls back to a source build, because falling back would turn a supply-chain
// alarm into a silent recompile and defeat the pin entirely.
//
// SOURCE BUILD IS THE BOOTSTRAP PATH. A platform with no pin is compiled from
// the commits in the lock file by build-netcoredbg.sh. That is how the pinned
// archives are produced in the first place (publish-netcoredbg.yml), and how a
// developer works on the patch. It is reported loudly, because a release built
// that way has no attested provenance.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
// The override exists so the end-to-end test can drive a real download against
// a real digest without editing the committed pins.
const LOCK_PATH = process.env.SHARPLSP_NETCOREDBG_LOCK || join(HERE, 'netcoredbg.lock.json');
const MARKER_NAME = '.sharplsp-dap-hot-reload';

/** Platforms with no configured native build ([DIST-DEBUGGER-BUNDLE]). */
const UNSUPPORTED = new Set(['win32-arm64', 'darwin-x64']);
const SUPPORTED = new Set(['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64']);

/** The lock file is the ONLY place these commits are written down. */
export function readLock() {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
}

/** Identifies exactly which build an on-disk adapter is, for the marker file. */
export function buildId(lock) {
    return `${lock.netcoredbgCommit}:${lock.patchVersion}`;
}

function outputDir(platform) {
    return join(ROOT, 'target', 'netcoredbg', platform, 'netcoredbg');
}

function executable(platform) {
    return join(outputDir(platform), platform === 'win32-x64' ? 'netcoredbg.exe' : 'netcoredbg');
}

/** True when the adapter already on disk is the one the lock file describes. */
function alreadyProvided(platform, id) {
    const marker = join(outputDir(platform), MARKER_NAME);
    if (!existsSync(executable(platform)) || !existsSync(marker)) return false;
    return readFileSync(marker, 'utf8').trim() === id;
}

function run(command, args, label, cwd = ROOT) {
    const result = spawnSync(command, args, { stdio: 'inherit', cwd, shell: false });
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${label}: exited ${result.status}`);
}

/** Archive member name used for the staged download, see extract(). */
const DOWNLOAD_NAME = 'netcoredbg-download.tar.gz';

// GNU tar reads an argument containing a colon as `host:path` and tries to reach
// a remote machine, so a Windows absolute path like C:\... fails with "Cannot
// connect to C: resolve failed". bsdtar - which is what ships in System32 -
// accepts those paths but rejects GNU's `--force-local`, so neither an absolute
// path nor that flag is portable across the two tars a Windows runner may
// resolve. Extracting with `cwd` set and a bare relative filename keeps every
// argument colon-free and works on both.
function extract(destination) {
    run('tar', ['-xzf', DOWNLOAD_NAME, '--strip-components=1'], 'tar', destination);
}

async function downloadPinned(platform, pin, id) {
    console.log(`netcoredbg: fetching pinned ${platform} adapter\n  ${pin.url}`);
    const response = await fetch(pin.url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`netcoredbg: download failed with HTTP ${response.status} for ${pin.url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== pin.sha256) {
        // Deliberately fatal. See the header: never recompile past a bad digest.
        throw new Error(
            `netcoredbg: SHA-256 MISMATCH for ${platform}\n` +
                `  expected ${pin.sha256}\n` +
                `  received ${digest}\n` +
                `  from     ${pin.url}\n` +
                'Refusing to unpack. Either the pin is stale or the artifact was tampered with.',
        );
    }

    const destination = outputDir(platform);
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    const archive = join(destination, DOWNLOAD_NAME);
    writeFileSync(archive, bytes);
    extract(destination);
    rmSync(archive, { force: true });

    if (!existsSync(executable(platform))) {
        throw new Error(`netcoredbg: archive for ${platform} contained no ${executable(platform)}`);
    }
    writeFileSync(join(destination, MARKER_NAME), `${id}\n`);
    console.log(`netcoredbg: verified ${digest} and unpacked to ${destination}`);
}

function buildFromSource(platform) {
    console.warn(
        `netcoredbg: no pinned artifact for '${platform}' in netcoredbg.lock.json - ` +
            'building from source. A release built this way has NO attested provenance; ' +
            'run the "Publish netcoredbg" workflow and pin the result.',
    );
    run('bash', [join('tools', 'vsix', 'build-netcoredbg.sh'), platform], 'build-netcoredbg.sh');
}

export async function provide(platform) {
    if (UNSUPPORTED.has(platform)) {
        console.warn(`netcoredbg: no patched build for '${platform}' - using configured/PATH fallback`);
        return false;
    }
    if (!SUPPORTED.has(platform)) throw new Error(`netcoredbg: unknown platform '${platform}'`);

    const lock = readLock();
    const id = buildId(lock);
    if (alreadyProvided(platform, id)) {
        console.log(`netcoredbg: patched build already available at ${executable(platform)}`);
        return true;
    }

    const pin = lock.platforms?.[platform];
    if (pin) await downloadPinned(platform, pin, id);
    else buildFromSource(platform);
    return true;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
    const platform = process.argv[2] ?? `${process.platform}-${process.arch}`;
    provide(platform).catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
