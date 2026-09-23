import assert from "node:assert/strict";
import test from "node:test";
import { selectedWorkspaceShapes } from "../../src/editors/vscode/test-shapes.mjs";

// Implements [DIST-CI-VSIX-SHARDS].
test("a multiroot-only shard starts no empty folder editor", () => {
    assert.deepEqual(
        selectedWorkspaceShapes(
            "multiroot/test-explorer-mixed-runners.test.js",
        ),
        ["multiroot"],
    );
});

test("a folder-only shard starts no multiroot editor", () => {
    assert.deepEqual(selectedWorkspaceShapes("sdk-runtime-floor.test.js"), [
        "folder",
    ]);
});

test("an unfiltered run starts both workspace shapes", () => {
    assert.deepEqual(selectedWorkspaceShapes(undefined), [
        "folder",
        "multiroot",
    ]);
});

test("mixed and recursive shard globs start both workspace shapes", () => {
    assert.deepEqual(
        selectedWorkspaceShapes(
            "sdk-runtime-floor.test.js,multiroot/*.test.js",
        ),
        ["folder", "multiroot"],
    );
    assert.deepEqual(selectedWorkspaceShapes("**/*.test.js"), [
        "folder",
        "multiroot",
    ]);
});
