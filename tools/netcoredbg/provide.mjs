#!/usr/bin/env node
// [DIST-DEBUGGER-BUNDLE] Guarantees that target/netcoredbg/<platform>/netcoredbg
// holds the Nimblesite/netcoredbg fork release SharpLsp ships (upstream plus the
// SharpLsp patches, built by the fork's own workflow), and returns without doing
// any work when it already does.
//
// DOWNLOAD ONLY. SharpLsp never compiles the debugger. The lock file pins a URL
// and SHA-256 per platform; this downloads it, hashes the bytes it actually
// received, and unpacks it only if the digest matches. A mismatch, or a
// supported platform with no pin, is FATAL. Local builds, CI and releases all
// come through here, so every one of them ships the same bytes.
import { chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPinned, unpack } from '../download/pinned.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
// The override exists so the end-to-end test can drive a real download against
// a real digest without editing the committed pins.
const LOCK_PATH = process.env.SHARPLSP_NETCOREDBG_LOCK || join(HERE, 'netcoredbg.lock.json');
const MARKER_NAME = '.sharplsp-netcoredbg-release';

/** Platforms the fork release publishes no build for ([DIST-DEBUGGER-BUNDLE]). */
const UNSUPPORTED = new Set(['win32-arm64', 'darwin-x64']);
const SUPPORTED = new Set(['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64']);

/** The lock file is the ONLY place the release and its digests are written down. */
export function readLock() {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
}

/**
 * Identifies exactly which bytes an on-disk adapter came from, for the marker
 * file: the release AND the platform's pinned digest. The fork re-publishes
 * its archives under an existing tag when `Build release` is re-run, so the
 * tag alone cannot tell old bytes from new. A supported platform with no pin
 * is the hard error [DIST-DEBUGGER-BUNDLE] demands.
 */
export function buildId(lock, platform) {
    const pin = lock.platforms?.[platform];
    if (!pin) throw new Error(`netcoredbg: no pinned download for '${platform}' in netcoredbg.lock.json`);
    return `${lock.release}:${pin.sha256}`;
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

async function downloadPinned(platform, pin, id) {
    console.log(`netcoredbg: fetching ${platform} adapter\n  ${pin.url}`);
    const bytes = await fetchPinned(`netcoredbg ${platform}`, pin.url, pin.sha256);
    const destination = outputDir(platform);
    // Only the `netcoredbg/` member is extracted.
    unpack('netcoredbg', bytes, destination, ['--strip-components=1', 'netcoredbg']);
    if (!existsSync(executable(platform))) {
        throw new Error(`netcoredbg: archive for ${platform} contained no ${executable(platform)}`);
    }
    chmodSync(executable(platform), 0o755);
    writeFileSync(join(destination, MARKER_NAME), `${id}\n`);
    console.log(`netcoredbg: verified ${pin.sha256} and unpacked to ${destination}`);
}

export async function provide(platform) {
    if (UNSUPPORTED.has(platform)) {
        console.warn(`netcoredbg: no upstream build for '${platform}' - using configured/PATH fallback`);
        return false;
    }
    if (!SUPPORTED.has(platform)) throw new Error(`netcoredbg: unknown platform '${platform}'`);

    const lock = readLock();
    const id = buildId(lock, platform);
    if (alreadyProvided(platform, id)) {
        console.log(`netcoredbg: release ${id} already available at ${executable(platform)}`);
        return true;
    }
    await downloadPinned(platform, lock.platforms[platform], id);
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
