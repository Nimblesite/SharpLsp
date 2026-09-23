// Implements [DIST-CI-CLASSIFICATION]: execute the actual workflow classifier.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(new URL("../../src/editors/vscode/package.json", import.meta.url));
const workflow = require("js-yaml").load(readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8",
));
const { jobs } = workflow;
const classifier = jobs["detect-changes"].steps.find((step) => step.id === "classify");

function classify(t, files, status) {
    const scratch = mkdtempSync(join(tmpdir(), "sharplsp-ci-classification-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const output = join(scratch, "output");
    const result = spawnSync("bash", ["-c", [
        'gh() { printf \'%s\' "$TEST_FILES"; return "$TEST_API_STATUS"; }',
        classifier.run,
    ].join("\n")], { encoding: "utf8", env: {
        ...process.env, TEST_FILES: files, TEST_API_STATUS: String(status),
        GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "Nimblesite/SharpLsp", PR_NUMBER: "288",
    } });
    assert.equal(result.error, undefined);
    return { ...result, output: existsSync(output) ? readFileSync(output, "utf8") : "" };
}

for (const [name, files, apiStatus, expectedStatus] of [
    ["API failure cannot classify no results as docs-only", "", 7, 7],
    ["API failure cannot classify partial results as docs-only", "docs/review.md\n", 7, 7],
    ["an empty successful API response cannot skip all product checks", "", 0, 1],
]) {
    test(name, (t) => {
        const result = classify(t, files, apiStatus);
        assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
        assert.equal(result.output, "", "unusable lookup must publish no classification");
    });
}

for (const [files, code, manifest] of [
    ["docs/review.md\nREADME.md\n", false, false],
    ["docs/review.md\nsrc/host.rs\n", true, false],
    ["src/editors/vscode/shipwright.json\n", true, true],
]) {
    test(`successful classification preserves code=${code}, manifest=${manifest}`, (t) => {
        const result = classify(t, files, 0);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.output, `code_changed=${code}\nmanifest_changed=${manifest}\n`);
    });
}

test("the terminal CI gate depends on every declared upstream job", () => {
    assert.equal(jobs.ci.if, "${{ always() }}");
    assert.deepEqual([...jobs.ci.needs].sort(), Object.keys(jobs).filter((id) => id !== "ci").sort());
    assert.ok(Object.values(jobs).every((job) => job["continue-on-error"] !== true));
});

test("product CI runs only on pull requests, never after merge", () => {
    assert.deepEqual(Object.keys(workflow.on), ["pull_request"]);
    assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
});
