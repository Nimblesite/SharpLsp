// Implements [DIST-CI-ARTIFACT-TESTS]. test-cli's c8 excludes run BEFORE source
// map remapping, so bundled node_modules leak into the report. Filter the real
// remapped map before generating any report consumed by the coverage ratchet.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../src/editors/vscode/package.json", import.meta.url));
const { createCoverageMap } = require("istanbul-lib-coverage");
const { createContext } = require("istanbul-lib-report");
const reports = require("istanbul-reports");

export function firstPartyCoverage(data) {
    const map = createCoverageMap(data);
    map.filter((file) => !file.replaceAll("\\", "/").split("/")
        .some((part) => part === "node_modules" || part === ".vscode-test"));
    if (map.getCoverageSummary().lines.total === 0) throw new Error("No first-party coverage records");
    return map;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const coverageMap = firstPartyCoverage(JSON.parse(readFileSync("coverage/coverage-final.json", "utf8")));
    const context = createContext({ dir: "coverage", coverageMap });
    for (const name of ["json", "json-summary", "lcov", "html", "text-summary"])
        reports.create(name).execute(context);
}
