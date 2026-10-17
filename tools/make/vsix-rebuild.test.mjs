// [DIST-VSIX-REBUILD] A VSIX entry point never trusts native output it did not
// build, UNLESS it was handed output built by the same CI run ([DIST-CI-VSIX-SHARDS]).
// Both halves are asserted here: the default path must clean-rebuild everything,
// and the VSIX_PREBUILT path must skip the rebuild yet still stage - a flag that
// silently rebuilt would multiply Rust and both sidecars by the matrix width and
// add hours to every PR. netcoredbg is an external binary: every path downloads
// the pinned upstream release and none ever compiles it ([DIST-DEBUGGER-BUNDLE]).
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dryRun, stepAt } from "./make-test-kit.mjs";

test("npm packaging preparation honors the staged boundary vsce re-enters", () => {
    const run = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
        ["run", "prepare:vsix-binaries", "--", "--dry-run"], {
            cwd: fileURLToPath(new URL("../../src/editors/vscode", import.meta.url)),
            env: { ...process.env, SHARPLSP_VSIX_STAGED: "1" }, encoding: "utf8",
            shell: process.platform === "win32",
        });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes("cargo build"), "vsce's nested npm hook must not rebuild the host");
    assert.ok(!run.stdout.includes(" publish src/sidecars/"), "nor republish either sidecar");
    assert.ok(!run.stdout.includes("--rebuild"), "nor rebuild netcoredbg");
    assert.ok(run.stdout.includes("Staging required VSIX binaries"), "still stage the complete payload");
});

const targets = [
    "_build-vsix",
    "_test-vsix",
    "_test-vsix-shard",
    "_run-vsix-suite",
    "_verify-vsix-payload",
    "_package-vsix",
];

test("a complete VSIX test run builds the native host once, then tests that package", () => {
    const recipe = dryRun("_test-vsix");
    assert.equal(recipe.split("cargo build --release").length - 1, 1, "do not rebuild after packaging");
    assert.ok(recipe.includes("VSIX_ARTIFACT=dist/sharplsp.vsix"), "test the package this run created");
});

test("Rider artifact tests forbid both Java and Kotlin compilation", () => {
    const recipe = dryRun("_test-rider", ["RIDER_TESTS_PREBUILT=1", "COVERAGE_TOOLS_PREBUILT=1"]);
    assert.ok(recipe.includes("-PprebuiltTests=true"), "enable the task-graph compiler guard");
    for (const task of ["compileKotlin", "compileJava", "compileTestKotlin", "compileTestJava"])
        assert.ok(recipe.includes(`-x ${task}`), `${task} belongs only in the build phase`);
    assert.ok(!recipe.includes("dotnet\" run --file"), "coverage helpers are precompiled too");
});

for (const target of ["_test-dotnet", "_test-dotnet-win-transport"]) {
    test(`${target} executes precompiled Release tests without build or restore`, () => {
        const recipe = dryRun(target, ["VSIX_PREBUILT=1", "DOTNET_TESTS_PREBUILT=1"]);
        assert.ok(recipe.includes("--no-build --no-restore"), "test must not silently compile");
        assert.ok(recipe.includes("--configuration Release"), "consume Release test assemblies");
        assert.ok(!recipe.includes(" publish src/sidecars/"), "do not republish the product");
    });
}

for (const [target, component] of [["_test-rust-shard", "rust"], ["_test-zed", "zed"]]) {
    test(`${component} CI tests execute an archive instead of compiling`, () => {
        const recipe = dryRun(target, ["VSIX_PREBUILT=1", "CARGO_TESTS_PREBUILT=1", "SHARD=1"]);
        assert.ok(recipe.includes(`cargo-artifacts.sh test ${component}`), "use the archive-only runner");
        assert.ok(!recipe.includes("cargo llvm-cov nextest"), "that command compiles before running");
        assert.ok(!recipe.includes(" build src/sharplsp/tests/fixtures"), "cache static fixtures too");
    });
}
for (const target of targets) {
    test(`${target} always cleans and rebuilds the entire VSIX native payload`, () => {
        const platform = `${process.platform}-${process.arch}`;
        const recipe = dryRun(target, ["CHUNK=lsp", `VSIX_PLAT=${platform}`]);
        const rustClean = stepAt(recipe, "cargo clean --profile release");
        const managedClean = stepAt(recipe, "clean-sidecar-output.mjs");
        const rustBuild = stepAt(recipe, "cargo build --release");
        const managedBuild = stepAt(
            recipe,
            " publish src/sidecars/SharpLsp.Sidecar.CSharp/",
        );
        const debuggerDownload = stepAt(
            recipe,
            `fetch-netcoredbg.sh ${platform}`,
        );
        const fsharpBuild = stepAt(
            recipe,
            " publish src/sidecars/SharpLsp.Sidecar.FSharp/",
        );
        const compatibility = stepAt(
            recipe,
            "--filter FullyQualifiedName~Repo_pinned_sdk_ships_exactly_the_bundled_roslyn",
        );
        assert.ok(
            rustClean < rustBuild,
            "old Rust objects must be removed before compiling",
        );
        assert.ok(
            managedClean < managedBuild,
            "old .NET bin/obj AND publish files must be removed",
        );
        assert.ok(
            managedClean < fsharpBuild,
            "F# must also publish after cleaning",
        );
        for (const built of [
            rustBuild,
            managedBuild,
            fsharpBuild,
            compatibility,
            debuggerDownload,
        ])
            assert.ok(
                built < consumerAt(recipe),
                "every binary must rebuild before packaging/testing",
            );
        for (const compile of ["build-netcoredbg", "cmake"])
            assert.ok(
                !recipe.includes(compile),
                `the debugger is downloaded, never compiled ('${compile}')`,
            );
    });
}

// [DIST-CI-VSIX-SHARDS] The CI shards' half of the contract. Artifacts a shard
// downloads were built by the `build` job of THIS run from THIS commit, so they
// are not the stale incremental output [DIST-VSIX-REBUILD] exists to refuse.
for (const target of ["_build-vsix", "_run-vsix-suite", "_verify-vsix-payload"]) {
    test(`${target} stages without rebuilding when VSIX_PREBUILT is set`, () => {
        const platform = `${process.platform}-${process.arch}`;
        const recipe = dryRun(target, [
            "CHUNK=lsp",
            "VSIX_PREBUILT=1",
            "VSIX_SUITE_PREBUILT=1",
            `VSIX_PLAT=${platform}`,
        ]);
        for (const step of [
            "cargo clean",
            "cargo build",
            "clean-sidecar-output.mjs",
            "--rebuild",
        ])
            assert.ok(
                !recipe.includes(step),
                `VSIX_PREBUILT must skip '${step}', or every shard pays for it again`,
            );
        assert.ok(
            recipe.includes("Staging required VSIX binaries"),
            "skipping the rebuild must not also skip staging the payload",
        );
    });
}

// Release packaging ignores the flag on purpose: it runs once per tag, off the
// PR hot path, and a tag must never ship a binary this run did not compile.
test("release packaging rebuilds even when VSIX_PREBUILT is set", () => {
    const recipe = dryRun("_package-vsix", [
        "VSIX_PREBUILT=1",
        `VSIX_PLAT=${process.platform}-${process.arch}`,
    ]);
    assert.ok(recipe.includes("cargo build"), "a tag must compile its own host");
    assert.ok(
        recipe.includes("clean-sidecar-output.mjs"),
        "a tag must not inherit warm sidecar intermediates",
    );
});

function consumerAt(recipe) {
    if (recipe.includes("vsce package")) return stepAt(recipe, "vsce package");
    if (recipe.includes("npx vscode-test"))
        return stepAt(recipe, "npx vscode-test");
    return stepAt(recipe, "verify-vsix-payload.mjs");
}

const platforms = [
    "linux-x64",
    "linux-arm64",
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "win32-arm64",
];
for (const platform of platforms) {
    test(`release packaging rebuilds and stages the declared ${platform} target`, () => {
        const recipe = dryRun(`_package-vsix-${platform}`, ["VSIX_PREBUILT=1"]);
        assert.ok(
            recipe.includes(`--target ${platform}`),
            "package platform must not retain the internal target underscore",
        );
        assert.ok(
            recipe.includes(`fetch-netcoredbg.sh ${platform}`),
            "debugger download must target the package platform",
        );
        assert.ok(
            recipe.includes("clean-sidecar-output.mjs"),
            "release sidecars must not inherit warm intermediates",
        );
    });
}
