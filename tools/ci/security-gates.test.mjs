// Implements [DIST-CI-AUDIT]. Parse the actual workflows, not their comments.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../src/editors/vscode/package.json', import.meta.url));
const { load } = require('js-yaml');
const workflow = (name) => load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const ci = workflow('ci');
const release = workflow('release');

test('a dependency audit failure reaches the final CI result', () => {
  assert.ok(ci.jobs.ci.needs.includes('audit'), 'CI must depend on the vulnerability audit');
  assert.equal(ci.jobs.ci.if, '${{ always() }}');
  const failure = ci.jobs.ci.steps.find((step) => step.if?.includes("contains(needs.*.result, 'failure')"));
  assert.ok(failure, 'a failed dependency must fail the final gate');
  assert.ok(failure.run.includes('exit 1'));
  assert.notEqual(ci.jobs.audit['continue-on-error'], true);
});

test('CI and release run the same non-optional vulnerability scanner', () => {
  for (const caller of [ci, release]) {
    assert.equal(caller.jobs.audit.uses, './.github/workflows/ci-audit.yml');
    assert.notEqual(caller.jobs.audit['continue-on-error'], true);
  }
  const audit = workflow('ci-audit');
  assert.ok(Object.hasOwn(audit.on, 'workflow_call'));
  const scanner = audit.jobs.audit.steps.find((step) => step.run === 'make audit');
  assert.ok(scanner, 'the shared audit must execute the real local scanner');
  assert.equal(scanner.if, undefined, 'the scanner cannot be conditional');
  assert.notEqual(scanner['continue-on-error'], true);
});

test('vulnerability findings block the release and both VSIX marketplaces', () => {
  assert.ok(release.jobs.release.needs.includes('audit'));
  assert.equal(release.jobs.release.if, undefined, 'release must use success-only dependency gating');
  assert.equal(release.jobs.audit.if, undefined, 'every tagged release must be audited');
  for (const name of ['publish-marketplace', 'publish-openvsx']) {
    assert.ok(release.jobs[name].needs.includes('release'), `${name} must wait for the audited release`);
    assert.equal(release.jobs[name].if, undefined, `${name} cannot bypass dependency success`);
  }
});
