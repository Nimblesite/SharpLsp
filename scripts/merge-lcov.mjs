#!/usr/bin/env node
// Implements [DIST-CI-RUST-SHARDS].
//
// Union-merges lcov tracefiles produced by sharded `cargo llvm-cov nextest`
// runs and prints the merged line-coverage percentage to stdout.
//
// Every shard instruments the same binaries, so each tracefile carries the
// full set of instrumented lines (unexecuted ones as `DA:<line>,0`). Summing
// hit counts per (file, line) across shards therefore reproduces exactly the
// line set — and percentage — of a single unsharded run; the result feeds the
// same check-coverage.sh ratchet gate.
//
// Usage: node scripts/merge-lcov.mjs <output.lcov> <shard.lcov> [...]
// stdout: merged line percentage only (for command substitution);
// diagnostics go to stderr.
import { readFileSync, writeFileSync } from "node:fs";

function mergeTracefile(text, filesToLines) {
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const sourcePath = line.slice(3);
      current = filesToLines.get(sourcePath) ?? new Map();
      filesToLines.set(sourcePath, current);
    } else if (line.startsWith("DA:") && current !== null) {
      const [lineNo, hits] = line.slice(3).split(",").map(Number);
      if (Number.isFinite(lineNo) && Number.isFinite(hits)) {
        current.set(lineNo, (current.get(lineNo) ?? 0) + hits);
      }
    } else if (line === "end_of_record") {
      current = null;
    }
  }
}

function renderRecord(sourcePath, lines) {
  const sorted = [...lines.entries()].sort(([a], [b]) => a - b);
  const hit = sorted.filter(([, hits]) => hits > 0).length;
  const dataLines = sorted.map(([lineNo, hits]) => `DA:${lineNo},${hits}`);
  return [`SF:${sourcePath}`, ...dataLines, `LF:${sorted.length}`, `LH:${hit}`, "end_of_record"].join("\n");
}

function totals(filesToLines) {
  let tracked = 0;
  let hit = 0;
  for (const lines of filesToLines.values()) {
    tracked += lines.size;
    hit += [...lines.values()].filter((hits) => hits > 0).length;
  }
  return { tracked, hit };
}

function main(argv) {
  const [output, ...inputs] = argv;
  if (output === undefined || inputs.length === 0) {
    process.stderr.write("usage: merge-lcov.mjs <output.lcov> <input.lcov>...\n");
    return 2;
  }
  const filesToLines = new Map();
  for (const input of inputs) {
    mergeTracefile(readFileSync(input, "utf8"), filesToLines);
  }
  const { tracked, hit } = totals(filesToLines);
  if (tracked === 0) {
    process.stderr.write(`ERROR: no DA records found in: ${inputs.join(", ")}\n`);
    return 1;
  }
  const records = [...filesToLines.keys()].sort().map((sourcePath) => renderRecord(sourcePath, filesToLines.get(sourcePath)));
  writeFileSync(output, `${records.join("\n")}\n`);
  process.stderr.write(`merged ${inputs.length} tracefiles: ${hit}/${tracked} lines covered\n`);
  process.stdout.write(`${((hit / tracked) * 100).toFixed(4)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
