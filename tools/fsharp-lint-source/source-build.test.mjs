// Public CLI proofs over the pinned upstream source, never a replacement implementation.
// Implements [DIAG-CATEGORIES-ANALYZER] and [DIST-CI-ARTIFACT-TESTS].
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
    archive, archiveSha, builder, revision, childPath, scratch, invoke, hash,
    preparedPaths, assertPrepared, settledSnapshot, snapshot,
} from './source-test-kit.mjs';

function success(destination, expected = 'ok') {
    const run = invoke([archive, destination]);
    assert.equal(run.status, 0, JSON.stringify(run.result));
    assert.equal(run.result.status, expected);
    assert.equal(run.result.archiveSha256, archiveSha);
    assert.equal(run.result.destination, destination);
    return run.result;
}

test('invalid arguments and unpinned archives fail before creating or modifying a destination', (t) => {
    const root = scratch(t);
    const destination = childPath(root, 'never-created');
    const invalid = childPath(root, 'wrong.tar.gz');
    writeFileSync(invalid, 'untrusted archive bytes');
    for (const [args, code] of [
        [[], 'usage'], [[archive], 'usage'], [[archive, destination, 'extra'], 'usage'],
        [['', destination], 'empty-path'], [['relative.tar.gz', destination], 'relative-path'],
        [[childPath(root, 'missing.tar.gz'), destination], 'missing-path'],
        [[archive, ''], 'empty-path'], [[archive, 'relative'], 'relative-path'],
        [[invalid, destination], 'hash-mismatch'],
    ]) {
        const run = invoke(args);
        assert.equal(run.status, 1, `${code}: process must reject the input`);
        assert.equal(run.result.status, 'error');
        assert.equal(run.result.code, code);
        assert.ok(run.result.error.length > 0, 'failure explains its cause');
        assert.equal(existsSync(destination), false, 'validation must precede extraction');
    }
    mkdirSync(destination);
    const marker = childPath(destination, 'keep.bin');
    writeFileSync(marker, Buffer.from([17, 29, 43]));
    const before = snapshot({ marker });
    assert.equal(invoke([invalid, destination]).result.code, 'hash-mismatch');
    assert.deepEqual(snapshot({ marker }), before, 'a bad archive cannot modify existing output');
});

test('the real pinned archive prepares compiler-compatible source and a verified no-op preserves output', (t) => {
    const destination = childPath(scratch(t), 'prepared');
    assert.equal(hash(archive), archiveSha, 'the immutable build artifact contains the genuine upstream archive');
    const builderBefore = snapshot({ builder });
    const prepared = success(destination);
    assert.equal(prepared.revision, revision);
    assert.ok(prepared.filesExtracted > 100);
    assert.equal(prepared.wrappedPatterns, 2, 'the real AST rewrite verifies both compatibility patterns');
    assert.equal(prepared.resetRuleState, 1, 'the upstream rule cannot retain a previous run threshold');
    const fingerprint = assertPrepared(destination);
    assert.equal(prepared.rewrittenFile, fingerprint.targetRelative);
    const files = preparedPaths(destination);
    const before = settledSnapshot(files);
    success(destination, 'noop');
    assert.deepEqual(snapshot(files), before, 'verified no-op preserves every tracked byte and timestamp');
    assert.deepEqual(assertPrepared(destination), fingerprint);
    assert.deepEqual(snapshot({ builder }), builderBefore, 'tests execute the precompiled builder without rebuilding it');
});

test('source or fingerprint corruption forces preparation and cannot authorize stale compiler input', (t) => {
    const destination = childPath(scratch(t), 'prepared');
    success(destination);
    const expected = assertPrepared(destination);
    const files = preparedPaths(destination);
    for (const file of [files.target, files.state]) {
        writeFileSync(file, Buffer.from([0, 1, 2]));
        const repaired = success(destination);
        assert.ok(repaired.filesExtracted > 100);
        assert.deepEqual(assertPrepared(destination), expected, 're-extract and re-verify the real AST and rule state');
        const before = settledSnapshot(files);
        success(destination, 'noop');
        assert.deepEqual(snapshot(files), before);
    }
    for (const name of Object.keys(expected)) {
        writeFileSync(files.fingerprint, JSON.stringify({ ...expected, [name]: 'corrupted' }));
        success(destination);
        assert.deepEqual(assertPrepared(destination), expected, `${name} participates in freshness`);
    }
    for (const corrupt of ['{invalid-json', 'null', '{}']) {
        writeFileSync(files.fingerprint, corrupt);
        success(destination);
        assert.deepEqual(assertPrepared(destination), expected, 'invalid metadata fails closed and recovers');
    }
});

test('a matching output fingerprint cannot bypass checking the current archive bytes', (t) => {
    const root = scratch(t);
    const destination = childPath(root, 'prepared');
    success(destination);
    const fingerprint = assertPrepared(destination);
    const corrupt = childPath(root, 'corrupt.tar.gz');
    copyFileSync(archive, corrupt);
    const bytes = readFileSync(corrupt);
    bytes[0] ^= 1;
    writeFileSync(corrupt, bytes);
    const before = settledSnapshot(preparedPaths(destination));
    const rejected = invoke([corrupt, destination]);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.result.status, 'error');
    assert.equal(rejected.result.code, 'hash-mismatch');
    assert.deepEqual(snapshot(preparedPaths(destination)), before, 'refusal preserves all prepared outputs');
    assert.deepEqual(assertPrepared(destination), fingerprint);
    success(destination, 'noop');
    assert.deepEqual(snapshot(preparedPaths(destination)), before);
});
