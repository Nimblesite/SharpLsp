// [DIST-CI-ARTIFACT-TESTS] Production-bundle remapping must not count vendor code.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { dryRun } from "../make/make-test-kit.mjs";

const require = createRequire(new URL("../../src/editors/vscode/package.json", import.meta.url));
const { createCoverageMap, createFileCoverage } = require("istanbul-lib-coverage");

test("the VSIX runner filters remapped dependency coverage before publishing", () => {
    const recipe = dryRun("_run-vsix-suite", ["VSIX_PREBUILT=1", "VSIX_SUITE_PREBUILT=1"]);
    assert.ok(recipe.includes("report-vsix-coverage.mjs"), "post-remap filtering is mandatory");
});

test("coverage filtering retains uncovered first-party lines and excludes vendor paths on both OSes", async () => {
    const { firstPartyCoverage } = await import("../coverage/report-vsix-coverage.mjs");
    const paths = ["/repo/src/client.ts", "/repo/node_modules/vendor/a.js", "C:\\repo\\node_modules\\vendor\\a.js", "/repo/.vscode-test/host.js"];
    const coverage = createCoverageMap({});
    for (const path of paths) {
        const file = createFileCoverage(path);
        file.statementMap["0"] = { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } };
        file.s["0"] = path === paths[0] ? 0 : 1;
        coverage.addFileCoverage(file);
    }
    const filtered = firstPartyCoverage(coverage.toJSON());
    assert.deepEqual(filtered.files(), [paths[0]]);
    assert.equal(filtered.getCoverageSummary().lines.total, 1);
    assert.equal(filtered.getCoverageSummary().lines.covered, 0);
});
