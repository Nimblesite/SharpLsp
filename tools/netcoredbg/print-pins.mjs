#!/usr/bin/env node
// [DIST-DEBUGGER-BUNDLE] Prints the `platforms` block for netcoredbg.lock.json
// from the archives publish-netcoredbg.yml just uploaded.
//
// Hand-copying three URLs and three 64-character digests is exactly the kind of
// transcription a supply-chain pin cannot survive, so the digests are computed
// from the same files that were published and emitted ready to paste.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory, tag] = process.argv.slice(2);
if (!directory || !tag) {
    console.error('usage: print-pins.mjs <archive-dir> <release-tag>');
    process.exit(1);
}

const repository = process.env.GITHUB_REPOSITORY ?? 'Nimblesite/SharpLsp';
const platforms = {};

for (const file of readdirSync(directory).sort()) {
    if (!file.endsWith('.tar.gz')) continue;
    const platform = file.replace(/^netcoredbg-/, '').replace(/\.tar\.gz$/, '');
    platforms[platform] = {
        url: `https://github.com/${repository}/releases/download/${tag}/${file}`,
        sha256: createHash('sha256').update(readFileSync(join(directory, file))).digest('hex'),
    };
}

console.log('\nPaste this as the "platforms" value in tools/netcoredbg/netcoredbg.lock.json:\n');
console.log(JSON.stringify(platforms, null, 2));
