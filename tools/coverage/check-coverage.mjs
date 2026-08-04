#!/usr/bin/env node
// Enforce and ratchet repository coverage thresholds without jq or bc.
//
// Usage:
//   node check-coverage.mjs <project-key> <actual-percent>
//   node check-coverage.mjs <project-key> --json <file> <dotted.path>

import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const THRESHOLDS = '.config/coverage/thresholds.json';
const TEMP_THRESHOLDS = `${THRESHOLDS}.tmp`;
const TOLERANCE = 1;

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`ERROR: unable to read JSON from ${file}: ${error.message}`);
  }
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail(`ERROR: ${label} must be a finite number; received ${String(value)}`);
  }
  return number;
}

function valueAtPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, segment) => current?.[segment], value);
}

function readActual(args) {
  if (args.length === 1) return finiteNumber(args[0], 'actual coverage');
  if (args.length === 3 && args[0] === '--json') {
    const [, file, dottedPath] = args;
    return finiteNumber(valueAtPath(readJson(file), dottedPath), `${file}:${dottedPath}`);
  }
  fail(
    'Usage: check-coverage.mjs <project-key> <actual-percent>\n' +
      '   or: check-coverage.mjs <project-key> --json <file> <dotted.path>',
    2,
  );
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function committedThreshold(project) {
  const mergeBase = git(['merge-base', 'HEAD', 'main']);
  const head = git(['rev-parse', 'HEAD']);
  const baselineRef = mergeBase && head && head !== mergeBase ? mergeBase : 'HEAD';
  const committedJson = git(['show', `${baselineRef}:${THRESHOLDS}`]);
  if (!committedJson) return undefined;

  try {
    const value = JSON.parse(committedJson)?.[project]?.line_percent;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  } catch {
    return undefined;
  }
}

const [project, ...actualArgs] = process.argv.slice(2);
if (!project) fail('Usage: check-coverage.mjs <project-key> <actual-percent>', 2);

const actual = readActual(actualArgs);
const thresholds = readJson(THRESHOLDS);
const threshold = finiteNumber(thresholds?.[project]?.line_percent, `threshold for project '${project}'`);
const committed = committedThreshold(project);

if (committed !== undefined && threshold < committed) {
  fail(
    `FAIL: [${project}] threshold was lowered from ${committed}% to ${threshold}% -- ` +
      'coverage thresholds must NEVER decrease',
  );
}

const effectiveThreshold = threshold - TOLERANCE;
console.log(
  `[${project}] coverage: ${actual}% (threshold: ${threshold}%, ` +
    `effective: ${effectiveThreshold}% with ${TOLERANCE}pp tolerance)`,
);

if (actual < effectiveThreshold) {
  fail(
    `FAIL: [${project}] coverage ${actual}% dropped below effective threshold ` +
      `${effectiveThreshold}% (stored: ${threshold}%)`,
  );
}

if (actual > threshold) {
  const newThreshold = Math.floor((actual - TOLERANCE + 1e-9) * 100) / 100;
  if (newThreshold > threshold) {
    console.log(
      `[${project}] coverage improved! Ratcheting threshold: ${threshold}% -> ${newThreshold}% ` +
        `(actual ${actual}% - ${TOLERANCE}pp)`,
    );
    thresholds[project].line_percent = newThreshold;
    writeFileSync(TEMP_THRESHOLDS, `${JSON.stringify(thresholds, null, 2)}\n`);
    renameSync(TEMP_THRESHOLDS, THRESHOLDS);
  }
}
