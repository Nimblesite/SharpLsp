// The one pinned-download path: the netcoredbg fork ([DIST-DEBUGGER-BUNDLE]) and
// lspkit's release assets ([PROFILER-SHARED-LIBRARY]) both arrive through it.
// Bytes are hashed as received and unpacked only when the digest matches.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Archive member name used for the staged download, see unpack(). */
const DOWNLOAD_NAME = 'pinned-download';

/** The bytes at `url`, or an error unless they hash to `sha256`. */
export async function fetchPinned(label, url, sha256) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${label}: download failed with HTTP ${response.status} for ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest === sha256) return bytes;
    throw new Error(
        `${label}: SHA-256 MISMATCH\n  expected ${sha256}\n  received ${digest}\n  from     ${url}\n` +
            'Refusing to unpack. Either the pin is stale or the artifact was tampered with.',
    );
}

// bsdtar reads every archive and detects the format itself; it is `tar` on macOS
// and System32's tar.exe on Windows, where Git Bash's GNU tar would otherwise win
// on PATH. A bare relative filename with `cwd` set keeps every argument
// colon-free: GNU tar reads `C:\...` as host:path.
function tarCommand() {
    return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

/** Replaces `destination` with the archive `bytes`, passing `tarArgs` after the file. */
export function unpack(label, bytes, destination, tarArgs) {
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, DOWNLOAD_NAME), bytes);
    const result = spawnSync(tarCommand(), ['-xf', DOWNLOAD_NAME, ...tarArgs], { stdio: 'inherit', cwd: destination });
    rmSync(join(destination, DOWNLOAD_NAME), { force: true });
    if (result.error) throw new Error(`${label}: tar: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${label}: tar exited ${result.status}`);
}
