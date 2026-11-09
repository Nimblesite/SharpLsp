// A throwaway git repository for the CI gate tests that run their real CLI over one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A git repository named after `prefix` holding `files` (path → text), removed when test `t` ends. */
export function repository(t, prefix, files) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text, "utf8");
    }
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(git("init", "--quiet").status, 0);
    assert.equal(git("add", "--all").status, 0);
    return root;
}
