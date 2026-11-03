// Implements [DIST-CI-VSIX-HOST-CACHE]. Run the real config, parse the real workflows.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionDir = fileURLToPath(new URL("../../src/editors/vscode/", import.meta.url));
const require = createRequire(join(extensionDir, "package.json"));
const { load } = require("js-yaml");
const yaml = (path) => load(readFileSync(new URL(`../../.github/${path}`, import.meta.url), "utf8"));
const HOST_PATH = "src/editors/vscode/.vscode-test";
const KEY_ACTION = "./.github/actions/vscode-test-host-key";
const CACHE = "actions/cache";
const usesAction = (step, name) => step.uses?.split("@")[0] === name;
const cachesHost = (step) => step.with?.path === HOST_PATH;

/** What Node would use for one connection attempt after the test CLI loads the config. */
function attemptTimeoutAfterLoadingConfig() {
    const userData = mkdtempSync(join(tmpdir(), "slsp-host-"));
    const script = `const net = await import("node:net");
        await import(${JSON.stringify(new URL("../../src/editors/vscode/.vscode-test.mjs", import.meta.url).href)});
        process.stdout.write(String(net.getDefaultAutoSelectFamilyAttemptTimeout()));`;
    try {
        return Number(
            execFileSync(process.execPath, ["--input-type=module", "-e", script], {
                cwd: extensionDir,
                encoding: "utf8",
                env: { ...process.env, MOCHA_FILES: "x", VSCODE_TEST_USER_DATA_DIR: userData },
            }),
        );
    } finally {
        rmSync(userData, { recursive: true, force: true });
    }
}

test("a slow first address cannot fail the host download at Node's 250ms default", () => {
    assert.ok(attemptTimeoutAfterLoadingConfig() >= 5000);
});

test("a shard restores the host but never saves one per pull request", () => {
    const steps = yaml("actions/vsix-shard/action.yml").runs.steps;
    const resolve = steps.findIndex((step) => step.uses === KEY_ACTION);
    const restore = steps.findIndex(cachesHost);
    assert.ok(resolve >= 0 && resolve < restore, "resolve the key before restoring");
    assert.ok(usesAction(steps[restore], `${CACHE}/restore`), "shards must not save");
    assert.equal(steps.filter(cachesHost).length, 1);
    assert.equal(steps[restore].with.key, `\${{ steps.${steps[resolve].id}.outputs.key }}`);
    assert.equal(steps[restore].with["restore-keys"], `\${{ steps.${steps[resolve].id}.outputs.prefix }}`);
});

test("only the default branch seeds the host, once per platform and release", () => {
    const workflow = yaml("workflows/seed-vscode-test-host.yml");
    assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
    const job = workflow.jobs.seed;
    assert.equal(job.if, "github.ref == 'refs/heads/main'");
    assert.equal(job.strategy.matrix.include.length, 2);
    assert.deepEqual(workflow.permissions, { contents: "read" });
    const steps = job.steps;
    const resolve = steps.find((step) => step.uses === KEY_ACTION);
    const key = `\${{ steps.${resolve.id}.outputs.key }}`;
    const lookup = steps.find((step) => usesAction(step, `${CACHE}/restore`));
    const save = steps.find((step) => usesAction(step, `${CACHE}/save`));
    assert.equal(lookup.with["lookup-only"], true);
    assert.equal(lookup.with.key, key);
    assert.equal(save.with.key, key);
    assert.equal(lookup.with.path, HOST_PATH);
    assert.equal(save.with.path, HOST_PATH);
    const miss = `steps.${lookup.id}.outputs.cache-hit != 'true'`;
    assert.ok(save.if.includes(miss), "a cached release downloads nothing");
    assert.ok(save.if.includes(`steps.${resolve.id}.outputs.version != 'unresolved'`));
    const seed = steps.find((step) => step.run?.includes("seed-test-host.mjs"));
    assert.equal(seed.if, miss);
    assert.ok(steps.indexOf(lookup) < steps.indexOf(seed) && steps.indexOf(seed) < steps.indexOf(save));
});

/** Run the key action's real script with `curl` answering `body`, or failing when it is null. */
function resolvedRelease(body) {
    const dir = mkdtempSync(join(tmpdir(), "slsp-key-"));
    const output = join(dir, "output");
    const answer = body === null ? "exit 7" : `printf '%s' '${body}'`;
    writeFileSync(join(dir, "curl"), `#!/bin/sh\n${answer}\n`, { mode: 0o755 });
    const { steps } = yaml("actions/vscode-test-host-key/action.yml").runs;
    try {
        execFileSync("bash", ["-c", steps[0].run], {
            env: { ...process.env, GITHUB_OUTPUT: output, PATH: `${dir}:${process.env.PATH}`, RUNNER_OS: "Linux" },
            stdio: "pipe",
        });
        return readFileSync(output, "utf8").trim().split("\n");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("the key names the VS Code release and survives an unreachable release feed", () => {
    const prefix = "prefix=vscode-test-Linux-";
    assert.deepEqual(resolvedRelease('["1.200.0","1.199.0"]'), [
        "version=1.200.0",
        "key=vscode-test-Linux-1.200.0",
        prefix,
    ]);
    const unresolved = ["version=unresolved", "key=vscode-test-Linux-unresolved", prefix];
    assert.deepEqual(resolvedRelease(null), unresolved);
    assert.deepEqual(resolvedRelease(""), unresolved);
    assert.deepEqual(resolvedRelease("[]"), unresolved);
});
