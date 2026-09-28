#!/usr/bin/env node
// [DIST-DEBUGGER-BUNDLE] Prints one field of netcoredbg.lock.json, so the shell
// staging script can read the pinned release without keeping its own copy of it
// and without grepping JSON.
//
// `buildId <platform>` is the identity written into the on-disk marker file;
// deriving it in one place keeps the marker and the pins describing the same
// bytes.
import { buildId, readLock } from './provide.mjs';

const [field, platform] = process.argv.slice(2);

function read() {
    const lock = readLock();
    const value = field === 'buildId' ? buildId(lock, platform) : lock[field];
    if (typeof value !== 'string') throw new Error(`netcoredbg: no string field '${field}' in netcoredbg.lock.json`);
    return value;
}

try {
    process.stdout.write(read());
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
