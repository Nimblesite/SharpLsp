#!/usr/bin/env node
// Implements [DIST-VSIX-ASSET-INTEGRITY].
//
// Resolves "text-symlink stubs" produced by Git on checkouts that don't have
// core.symlinks=true (the default on most Windows machines). On those
// checkouts Git materializes a symlink as a small text file containing the
// relative target path. vsce then packages the stub instead of the real
// asset, and the extension-development host renders broken icons.
//
// On macOS/Linux — and Windows checkouts with core.symlinks=true — the same
// file is a real symlink (lstat reports it as one), so we leave it alone and
// this script is a no-op. We only rewrite plain files whose contents look
// like a relative POSIX path pointing at an existing target file.
//
// NOTE: resolving a stub modifies the working tree. Do NOT commit resolved
// files — Git would record the binary content as the symlink's target text.
// Restore with `git restore <dir>` if you need the pristine checkout back.
//
// Usage: node scripts/resolve-symlink-stubs.mjs <dir> [<dir> ...]

import fs from 'node:fs';
import path from 'node:path';

const MAX_STUB_BYTES = 1024;

function resolveDir(dir) {
  let resolved = 0;
  for (const name of fs.readdirSync(dir)) {
    const stubPath = path.join(dir, name);
    const stat = fs.lstatSync(stubPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STUB_BYTES) {
      continue;
    }
    const text = fs.readFileSync(stubPath, 'utf8').trim();
    if (text.includes('\n') || text.includes('\0')) continue;
    if (!/^\.{1,2}\//.test(text)) continue;
    const target = path.resolve(path.dirname(stubPath), text);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
    fs.copyFileSync(target, stubPath);
    resolved += 1;
    console.log(`resolved symlink stub: ${path.relative(process.cwd(), stubPath)} -> ${text}`);
  }
  return resolved;
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: resolve-symlink-stubs.mjs <dir> [<dir> ...]');
  process.exit(2);
}
const total = dirs.reduce((count, dir) => count + resolveDir(dir), 0);
if (total > 0) {
  console.log(
    `resolved ${total} stub(s) in place — working tree modified; do not commit these files ` +
      '(restore with `git restore <dir>`)',
  );
}
