#!/usr/bin/env node
// [DIST-DEBUGGER-BUNDLE] Prints one field of netcoredbg.lock.json, so the shell
// build script can read the pinned commits without keeping its own copy of them
// and without grepping JSON.
//
// `buildId` is synthesised rather than stored: it is the identity written into
// the on-disk marker file, and deriving it in one place keeps the marker, the
// pins and the source build describing the same artifact.
import { buildId, readLock } from './provide.mjs';

const field = process.argv[2];
const lock = readLock();
const value = field === 'buildId' ? buildId(lock) : lock[field];

if (typeof value !== 'string') {
    console.error(`netcoredbg: no string field '${field}' in netcoredbg.lock.json`);
    process.exit(1);
}
process.stdout.write(value);
