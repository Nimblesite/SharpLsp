#!/usr/bin/env node
// Implements [DIST-CI-WIN-VSIX].
//
// Single reader for editors/vscode/test-chunks.json — the one place the
// Windows VS Code feature chunks are declared. The Makefile (`_test-vsix-win`),
// the CI job matrix, and the completeness guard all go through this script, so
// adding a chunk or a suite is a one-file edit.
//
// Usage:
//   node scripts/vsix-test-chunks.mjs files <chunk>  -> comma-separated globs for MOCHA_FILES
//   node scripts/vsix-test-chunks.mjs matrix         -> JSON array of chunk names (GitHub matrix)
//   node scripts/vsix-test-chunks.mjs check          -> fail if any suite is in no chunk / two chunks
//
// stdout carries the answer only (safe for command substitution); diagnostics
// and failures go to stderr with a non-zero exit.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO_ROOT, "editors", "vscode", "test-chunks.json");
const SUITE_DIR = join(REPO_ROOT, "editors", "vscode", "src", "test", "suite");

function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

/** Compiled suite names (`*.test.js`) derived from the TypeScript sources. */
function declaredSuites() {
  return readdirSync(SUITE_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => name.replace(/\.ts$/, ".js"))
    .sort();
}

function chunkGlobs(manifest, chunk) {
  const entry = manifest.chunks[chunk];
  if (!entry) {
    const known = Object.keys(manifest.chunks).join(", ");
    throw new Error(`unknown chunk '${chunk}'. Known chunks: ${known}`);
  }
  return [...manifest.shared.files, ...entry.files];
}

/** A glob with no `*` is a literal filename; otherwise match it as a prefix/suffix pattern. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchSuites(globs, suites) {
  return suites.filter((suite) => globs.some((glob) => globToRegExp(glob).test(suite)));
}

function check(manifest) {
  const suites = declaredSuites();
  const owners = new Map(suites.map((suite) => [suite, []]));

  for (const [chunk, entry] of Object.entries(manifest.chunks)) {
    for (const suite of matchSuites(entry.files, suites)) {
      owners.get(suite).push(chunk);
    }
  }
  for (const suite of matchSuites(manifest.shared.files, suites)) {
    owners.get(suite).push("shared");
  }
  for (const suite of matchSuites(manifest.excluded.files, suites)) {
    owners.get(suite).push("excluded");
  }

  const orphans = [...owners].filter(([, chunks]) => chunks.length === 0).map(([suite]) => suite);
  const duplicates = [...owners].filter(([, chunks]) => chunks.length > 1);
  const problems = [
    ...orphans.map(
      (suite) =>
        `${suite} belongs to no chunk — add it to a chunk in editors/vscode/test-chunks.json ` +
        `(or to "excluded" with a reason) so it cannot silently skip Windows CI.`,
    ),
    ...duplicates.map(
      ([suite, chunks]) => `${suite} is claimed by more than one chunk: ${chunks.join(", ")}.`,
    ),
  ];

  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `${suites.length} VS Code suites: ${Object.keys(manifest.chunks).length} Windows chunks, ` +
      `${matchSuites(manifest.excluded.files, suites).length} excluded.\n`,
  );
}

function main() {
  const [command, argument] = process.argv.slice(2);
  const manifest = loadManifest();

  if (command === "files") {
    process.stdout.write(chunkGlobs(manifest, argument).join(","));
  } else if (command === "matrix") {
    process.stdout.write(JSON.stringify(Object.keys(manifest.chunks)));
  } else if (command === "check") {
    check(manifest);
  } else {
    throw new Error(`usage: vsix-test-chunks.mjs <files <chunk>|matrix|check>, got '${command}'`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
