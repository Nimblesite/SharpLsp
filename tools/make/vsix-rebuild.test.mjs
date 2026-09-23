// [DIST-VSIX-REBUILD] Warm outputs and prebuilt flags cannot bypass rebuilding.
import assert from "node:assert/strict";
import test from "node:test";
import { dryRun, stepAt } from "./make-test-kit.mjs";

const targets = [
    "_build-vsix",
    "_test-vsix",
    "_test-vsix-shard",
    "_run-vsix-suite",
    "_verify-vsix-payload",
    "_package-vsix",
];
for (const target of targets) {
    test(`${target} always cleans and rebuilds the entire VSIX native payload`, () => {
        const platform = `${process.platform}-${process.arch}`;
        const recipe = dryRun(target, [
            "CHUNK=lsp",
            "VSIX_PREBUILT=1",
            "VSIX_SUITE_PREBUILT=1",
            `VSIX_PLAT=${platform}`,
        ]);
        const rustClean = stepAt(recipe, "cargo clean --profile release");
        const managedClean = stepAt(recipe, "clean-sidecar-output.mjs");
        const rustBuild = stepAt(recipe, "cargo build --release");
        const managedBuild = stepAt(
            recipe,
            " publish src/sidecars/SharpLsp.Sidecar.CSharp/",
        );
        const debuggerBuild = stepAt(
            recipe,
            `build-netcoredbg.sh ${platform} --rebuild`,
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
            debuggerBuild,
        ])
            assert.ok(
                built < consumerAt(recipe),
                "every binary must rebuild before packaging/testing",
            );
    });
}

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
            recipe.includes(`build-netcoredbg.sh ${platform} --rebuild`),
            "debugger rebuild must target the package platform",
        );
        assert.ok(
            recipe.includes("clean-sidecar-output.mjs"),
            "release sidecars must not inherit warm intermediates",
        );
    });
}
