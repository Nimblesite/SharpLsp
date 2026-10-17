// Implements [DIST-CI-ARTIFACT-TESTS]: inspect the actual expanded shard plan.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const reader = fileURLToPath(new URL("./vsix-test-chunks.mjs", import.meta.url));
const query = (...args) => execFileSync(process.execPath, [reader, ...args], { encoding: "utf8" });

for (const platform of ["linux", "win"]) {
    test(`${platform}: no suite is scheduled again in another shard`, () => {
        const chunks = JSON.parse(query("matrix", platform));
        const owners = new Map();
        for (const chunk of chunks) {
            for (const file of query("files", chunk).split(",")) {
                const previous = owners.get(file);
                assert.equal(previous, undefined, `${file} runs in both ${previous} and ${chunk}`);
                owners.set(file, chunk);
            }
        }
        assert.ok(owners.has("00-vsix-dev-binary-staging.test.js"), "keep the staging assertions");
        assert.ok(owners.has("debug-test-mtp-fsharp-e2e.test.js"), "keep F# MTP coverage");
    });
}
