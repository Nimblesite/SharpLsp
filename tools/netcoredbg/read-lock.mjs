#!/usr/bin/env node
// [DIST-DEBUGGER-BUNDLE] Prints one field of netcoredbg.lock.json, so the shell
// staging script can read the pinned release without keeping its own copy of it
// and without grepping JSON.
//
// `buildId` is the identity written into the on-disk marker file; deriving it in
// one place keeps the marker and the pins describing the same artifact.
import { buildId, readLock } from './provide.mjs';

const field = process.argv[2];
const lock = readLock();
const value = field === 'buildId' ? buildId(lock) : lock[field];

if (typeof value !== 'string') {
    console.error(`netcoredbg: no string field '${field}' in netcoredbg.lock.json`);
    process.exit(1);
}
process.stdout.write(value);
