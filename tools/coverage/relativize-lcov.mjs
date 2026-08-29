#!/usr/bin/env node
// Implements [DIST-CI-VSIX-SHARDS].
//
// Rewrites the `SF:` paths of one lcov tracefile to REPO-RELATIVE POSIX form.
//
// c8 records absolute source paths. Every shard therefore describes the same
// file under a different spelling — `C:\Code\SharpLsp\src\...` on the Windows
// runner, `/home/runner/work/SharpLsp/SharpLsp/src/...` on Ubuntu — and
// merge-lcov.mjs keys its union on `SF:`. Merging raw tracefiles across
// platforms would enter every file twice, doubling the denominator and roughly
// halving the reported percentage: a coverage gate that fails for a reason that
// has nothing to do with coverage.
//
// Normalising here, in the shard that still knows its own repo root, is what
// makes the cross-platform union possible at all. The merger cannot do it: by
// then the foreign roots are gone.
//
// Usage: node tools/coverage/relativize-lcov.mjs <in.lcov> <out.lcov> [repoRoot]
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";

/** `SF:` payload -> repo-relative POSIX path (unchanged if already relative). */
function relativizePath(sourcePath, repoRoot) {
  const posix = sourcePath.split("\\").join("/");
  const absolute = isAbsolute(posix) || /^[A-Za-z]:\//.test(posix);
  return absolute ? relative(repoRoot, resolve(posix)).split("\\").join("/") : posix;
}

function relativize(text, repoRoot) {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line.startsWith("SF:") ? `SF:${relativizePath(line.slice(3), repoRoot)}` : line,
    )
    .join("\n");
}

function main(argv) {
  const [input, output, root] = argv;
  if (input === undefined || output === undefined) {
    process.stderr.write("usage: relativize-lcov.mjs <in.lcov> <out.lcov> [repoRoot]\n");
    return 2;
  }
  const repoRoot = resolve(root ?? process.cwd());
  const text = readFileSync(input, "utf8");
  if (!text.includes("SF:")) {
    process.stderr.write(`ERROR: no SF records in ${input} — the shard produced no coverage\n`);
    return 1;
  }
  writeFileSync(output, relativize(text, repoRoot));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
