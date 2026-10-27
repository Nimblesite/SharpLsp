// Implements [DIST-CI-ARTIFACT-TESTS]. Consumers execute the producer's exact builder.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dryRun } from '../make/make-test-kit.mjs';

test('artifact-only tooling tests execute source preparation without compiling the builder or product', () => {
    const recipe = dryRun('_test-tooling', ['TOOLING_TESTS_PREBUILT=1']);
    assert.ok(recipe.includes('tools/fsharp-lint-source/source-build.test.mjs'), 'run the genuine builder CLI contracts');
    assert.ok(recipe.includes('tools/fsharp-lint-source/source-artifact.test.mjs'), 'guard this handoff on every tooling run');
    assert.ok(!recipe.includes(' publish '), 'the consumer cannot publish or rebuild the builder');
    assert.ok(!recipe.includes(' build '), 'the consumer cannot compile the builder, tests or shipping artifacts');
    assert.ok(!recipe.includes('dotnet-tests.tar.gz'), 'the consumer does not prepare a second product test artifact');
});

test('the build phase stages the compiled builder and genuine pinned archive together', () => {
    const recipe = dryRun('_build-lint-source-tests', ['DOTNET_TESTS_PREBUILT=1']);
    assert.ok(recipe.includes('publish tools/fsharp-lint-source/LintSourceBuild.fsproj'));
    assert.ok(recipe.includes('--no-build --no-restore'), 'stage the builder already compiled with the sidecars');
    assert.ok(recipe.includes('-o target/lint-source-builder'));
    assert.ok(recipe.includes('third_party/FSharpLint.Core/obj/pinned-source/upstream.tar.gz'));
    assert.ok(!recipe.includes(' build '), 'do not compile the same source twice in phase 2');
    assert.ok(!recipe.includes('source-build.test.mjs'), 'the producer does not execute consumer tests');
});
