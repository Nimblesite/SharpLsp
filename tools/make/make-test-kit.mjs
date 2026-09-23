import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Expand the real Makefile without building, killing or installing anything. */
export function dryRun(target, args = []) {
    const { status, stdout, stderr } = spawnSync(
        "make",
        ["-n", target, ...args],
        {
            cwd: ROOT,
            encoding: "utf8",
        },
    );
    assert.equal(status, 0, `make -n ${target} failed:\n${stderr}`);
    return stdout;
}

export function stepAt(recipe, needle) {
    const at = recipe.indexOf(needle);
    assert.notEqual(at, -1, `step missing from recipe: ${needle}`);
    return at;
}
