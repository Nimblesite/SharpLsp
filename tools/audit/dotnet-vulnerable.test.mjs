// [DIST-CI-AUDIT] Tests for the .NET half of `make audit`. Run by
// `make _test-tooling`.
//
// `dotnet list package --vulnerable` exits 0 whatever it finds, so this checker
// is the only thing standing between a vulnerable sidecar dependency and a green
// gate. The fixtures are REAL `dotnet list ... --format json` output: one from a
// project referencing packages with published GitHub advisories (direct AND
// transitive), one from this repo's own sidecar solution. No vulnerable project
// file is committed - GitHub's dependency graph would raise alerts against it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'dotnet-vulnerable.mjs');
const VULNERABLE = join(HERE, 'fixtures', 'dotnet-vulnerable.json');
const CLEAN = join(HERE, 'fixtures', 'dotnet-clean.json');

function check(...args) {
  return spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });
}

test('vulnerable direct and transitive packages fail the default moderate gate', () => {
  const run = check(VULNERABLE);
  assert.equal(run.status, 1, 'moderate+ findings must fail the gate');
  assert.match(run.stdout, /HIGH {5}Newtonsoft\.Json 12\.0\.1 \(direct\)/);
  assert.match(run.stdout, /GHSA-5crp-9r3c-p9vr/, 'every finding names its advisory');
  assert.match(run.stdout, /MODERATE System\.IdentityModel\.Tokens\.Jwt 6\.24\.0 \(transitive\)/);
  assert.match(run.stdout, /7 vulnerable NuGet package\(s\), 7 at or above 'moderate'\./);
});

test('every finding says what to upgrade, direct and transitive alike', () => {
  const run = check(VULNERABLE, 'low');
  const hints = run.stdout.split('\n').filter((line) => line.includes('upgrade:'));
  assert.equal(hints.length, 7, 'one upgrade line per finding');
  assert.equal(hints.filter((line) => line.includes('raise its PackageReference')).length, 2);
  assert.equal(hints.filter((line) => line.includes('direct PackageReference')).length, 5);
  assert.equal(run.status, 1, 'low is the strictest level and still fails');
});

test('findings below the fail level are reported but do not fail', () => {
  const run = check(VULNERABLE, 'critical');
  assert.equal(run.status, 0, 'no critical advisory in the fixture');
  assert.match(run.stdout, /Azure\.Identity 1\.7\.0 \(transitive\)/, 'still reported');
  assert.match(run.stdout, /7 vulnerable NuGet package\(s\), 0 at or above 'critical'\./);
});

test("the sidecar solution's real report passes clean", () => {
  const run = check(CLEAN);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "0 vulnerable NuGet package(s), 0 at or above 'moderate'.\n");
  assert.equal(run.stderr, '');
});

test('an unusable report is an error, never a pass', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sharplsp-audit-'));
  try {
    const problems = join(scratch, 'problems.json');
    writeFileSync(problems, JSON.stringify({ version: 1, problems: [{ level: 'error', text: 'No assets file was found' }], projects: [] }));
    const unrestored = check(problems);
    assert.equal(unrestored.status, 2, 'an unrestored solution must not read as clean');
    assert.match(unrestored.stderr, /No assets file was found/);
    const missing = check(join(scratch, 'absent.json'));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /ENOENT/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('usage errors exit 2 without reading anything', () => {
  assert.equal(check().status, 2, 'report path is required');
  const badLevel = check(CLEAN, 'severe');
  assert.equal(badLevel.status, 2, 'unknown fail level is rejected');
  assert.match(badLevel.stderr, /low\|moderate\|high\|critical/);
});
