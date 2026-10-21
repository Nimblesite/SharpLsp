// Tests [PROFILER-SHARED-LIBRARY-VSCODE] and [TUTORIAL-MODEL] with their actual tools.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const generator of [
    "sync-profiler-contributions.mjs",
    "tutorial-model.mjs",
]) {
    test(`${generator} checks the committed model on this platform`, () => {
        const run = spawnSync(
            process.execPath,
            [fileURLToPath(new URL(generator, import.meta.url)), "--check"],
            { encoding: "utf8" },
        );
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stderr, "");
        assert.equal(run.signal, null);
    });
}
