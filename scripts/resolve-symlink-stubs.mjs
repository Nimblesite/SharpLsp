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
// file is a real symlink. We open every candidate with O_NOFOLLOW, so a real
// symlink fails the open and is left untouched; this script is then a no-op.
// We only rewrite plain files whose contents look like a relative POSIX path
// pointing at an existing target file.
//
// NOTE: resolving a stub modifies the working tree. Do NOT commit resolved
// files — Git would record the binary content as the symlink's target text.
// Restore with `git restore <dir>` if you need the pristine checkout back.
//
// Usage: node scripts/resolve-symlink-stubs.mjs <dir> [<dir> ...]

import fs from 'node:fs';
import path from 'node:path';

const MAX_STUB_BYTES = 1024;
// O_NOFOLLOW is defined on POSIX (open fails with ELOOP on a symlink) and
// absent on Windows, where the coalesce makes it a no-op — Windows stubs are
// plain files, so following is not a concern there.
const READ_NOFOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

// Read a candidate stub through a single descriptor so the type/size checks
// and the content read apply to the same inode — closing the
// time-of-check/time-of-use gap (js/file-system-race). Returns the trimmed
// relative-path text, or null when the entry is a symlink, a non-file,
// oversized, or not a single-line relative path.
function readStubText(stubPath) {
  let fd;
  try {
    fd = fs.openSync(stubPath, READ_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EMLINK') return null; // real symlink
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_STUB_BYTES) return null;
    const buf = Buffer.alloc(stat.size);
    const read = fs.readSync(fd, buf, 0, stat.size, 0);
    const text = buf.toString('utf8', 0, read).trim();
    if (text.includes('\n') || text.includes('\0')) return null;
    return /^\.{1,2}\//.test(text) ? text : null;
  } finally {
    fs.closeSync(fd);
  }
}

function resolveDir(dir) {
  let resolved = 0;
  for (const name of fs.readdirSync(dir)) {
    const stubPath = path.join(dir, name);
    const text = readStubText(stubPath);
    if (text === null) continue;
    const target = path.resolve(path.dirname(stubPath), text);
    try {
      // Attempt the copy directly rather than stat-then-copy: copyFileSync
      // throws (ENOENT/EISDIR) when the target is missing or not a file, which
      // we treat as "not a resolvable stub" — no separate existence check to
      // race against.
      fs.copyFileSync(target, stubPath);
    } catch {
      continue;
    }
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
