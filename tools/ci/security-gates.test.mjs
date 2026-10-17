// Implements [DIST-CI-AUDIT]. Parse the actual workflows, not their comments.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
    new URL("../../src/editors/vscode/package.json", import.meta.url),
);
const { load } = require("js-yaml");
const workflow = (name) =>
    load(
        readFileSync(
            new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
            "utf8",
        ),
    );
const ci = workflow("ci");
const release = workflow("release");
const action = (name) =>
    load(
        readFileSync(
            new URL(
                `../../.github/actions/${name}/action.yml`,
                import.meta.url,
            ),
            "utf8",
        ),
    );

// [DIST-CI-VSIX-SHARDS]: a cache hit must skip the shared package build too.
test("cached VS Code dependencies skip profiler codegen and compilation", () => {
    const steps = action("vsix-node-deps").runs.steps;
    const cache = steps.findIndex((step) => step.id === "node-modules");
    const build = steps.findIndex((step) => step.run === "make _build-profiler-ui");
    assert.ok(cache >= 0 && cache < build, "restore before deciding whether to build");
    assert.equal(steps[build].if, "steps.node-modules.outputs.cache-hit != 'true'");
    const codegen = steps.find((step) => step.uses === "./.github/actions/typediagram");
    assert.equal(codegen.if, steps[build].if, "cached shards need no code generator install");
});

test("all checks finish before build and every test waits for artifact publication", () => {
    for (const check of ["analyse", "audit", "security", "validate-manifest"])
        assert.ok(ci.jobs.build.needs.includes(check), `build must wait for ${check}`);
    for (const [name, job] of Object.entries(ci.jobs).filter(([name]) => name.startsWith("test-"))) {
        assert.ok(job.needs.includes("build"), `${name} must consume completed build artifacts`);
        assert.ok(job.needs.every((need) => !need.startsWith("test-")), "test legs must remain independent");
    }
});

// [DIST-CI-PROTECTION] #365. GitHub's implicit success() spans the whole
// dependency chain, so one legitimately skipped ancestor (manifest validation
// skips unless shipwright.json changed) silently skipped every test leg while
// `build` itself ran. Each consumer must state its own condition.
const ancestors = (name, seen = new Set()) => {
    for (const need of ci.jobs[name].needs ?? []) if (!seen.has(need)) ancestors(need, seen.add(need));
    return seen;
};
const phaseJobs = Object.keys(ci.jobs).filter((name) => name.startsWith("test-") || name === "coverage");

test("a skipped manifest check cannot skip the test phase", () => {
    assert.ok(phaseJobs.length >= 7, `test legs and coverage: ${phaseJobs}`);
    for (const name of phaseJobs) {
        assert.ok(ancestors(name).has("validate-manifest"), `${name} sits downstream of the skippable check`);
        const condition = ci.jobs[name].if ?? "";
        assert.ok(condition.includes("!cancelled()"), `${name} must not inherit an ancestor's skip: ${condition}`);
        for (const need of ci.jobs[name].needs.filter((need) => need !== "detect-changes"))
            assert.ok(condition.includes(`needs.${need}.result == 'success'`), `${name} must require ${need}: ${condition}`);
    }
});

test("the terminal gate fails when code changed but the build or test phase did not run", () => {
    const gate = ci.jobs.ci.steps.find((step) => step.if?.includes("needs.detect-changes.outputs.code_changed == 'true'"));
    assert.ok(gate, "a skipped test phase must not report green");
    for (const name of ["build", ...phaseJobs]) {
        assert.ok(ci.jobs.ci.needs.includes(name), `CI must wait for ${name}`);
        assert.ok(gate.if.includes(`needs.${name}.result != 'success'`), `${name} skipping must fail CI`);
    }
    assert.match(gate.run, /exit 1/);
});

test("all compiled test consumers opt into their non-building runners", () => {
    for (const job of Object.values(workflow("ci-test-dotnet").jobs)) {
        const run = job.steps.find((step) => step.run?.startsWith("make _test-dotnet"));
        assert.equal(run.env?.DOTNET_TESTS_PREBUILT, "1");
        assert.ok(job.steps.some((step) => step.uses === "./.github/actions/dotnet-tests"));
    }
    const rust = workflow("ci-test-rust").jobs["test-rust"];
    assert.ok(rust.steps.some((step) => step.run?.includes("CARGO_TESTS_PREBUILT=1")));
    const editors = workflow("ci-test-editors").jobs;
    assert.ok(editors["test-zed"].steps.some((step) => step.run === "make _test-zed CARGO_TESTS_PREBUILT=1"));
    assert.equal(editors["test-rider"].env.RIDER_TESTS_PREBUILT, "1");
    assert.equal(editors["test-rider"].env.COVERAGE_TOOLS_PREBUILT, "1");
    assert.ok(!editors["test-rider"].steps.some((step) => step.run?.includes("_build-rider")));
});

test("VSIX shards take the native payload from the packaged Release artifact", () => {
    const build = action("vsix-payload").runs.steps;
    const upload = build.find((step) => step.with?.path === "dist/sharplsp.vsix");
    assert.ok(upload, "the build must cache the actual packaged VSIX");
    assert.ok(upload.uses.startsWith("actions/upload-artifact@"));
    const shard = action("vsix-shard").runs.steps;
    const download = shard.find((step) => step.with?.name === upload.with.name);
    assert.ok(download?.uses.startsWith("actions/download-artifact@"), "consume that same artifact");
    const run = shard.find((step) => step.run?.includes("make _test-vsix-shard"));
    assert.equal(run.env?.VSIX_ARTIFACT, "target/vsix/sharplsp.vsix", "stage the zip bytes");
});

// [DIST-CI-ARTIFACT-TESTS] The profiler suites share @nimblesite/lsp-profiler-ui
// and its signals with the running extension. The self-contained production
// bundle gives the extension its own copy, so its state never reaches them.
test("shards run the development bundle, built after the VSIX is sealed", () => {
    const steps = action("build-platform").runs.steps;
    const packed = steps.findIndex((step) => step.uses === "./.github/actions/vsix-payload");
    const bundled = steps.findIndex((step) => step.run === "npm run build --prefix src/editors/vscode");
    const uploaded = steps.findIndex((step) =>
        step.with?.path?.split("\n").includes("src/editors/vscode/dist/extension.js"));
    assert.ok(packed >= 0, "the VSIX is packed in the build");
    assert.ok(packed < bundled, "the test bundle must not be what the VSIX packs");
    assert.ok(bundled < uploaded, "the shards receive the test bundle");
});

// [DIST-VSIX-REBUILD] + [DIST-CI-VSIX-SHARDS]. A CI consumer may skip the
// rebuild ONLY by declaring the binaries came from this run, and a shard that
// declares it must also have downloaded them - a shard claiming prebuilt
// binaries it never fetched would run the suite against whatever bin/ held.
// Release declares nothing, so a tag compiles its own.
test("CI stages same-run binaries and release compiles its own", () => {
    const payload = action("vsix-payload").runs.steps;
    assert.ok(
        payload.some((step) => step.run === "env VSIX_PREBUILT=1 make _build-vsix"),
        "packaging the payload must stage what this run built, not rebuild it",
    );
    const shard = action("vsix-shard").runs.steps;
    const run = shard.find((step) =>
        step.run?.includes("make _test-vsix-shard"),
    );
    assert.ok(run, "the shard action must invoke the shard target");
    assert.equal(
        run.env?.VSIX_PREBUILT,
        "1",
        "a shard must not rebuild Rust, both sidecars and netcoredbg per chunk",
    );
    assert.equal(
        run.env?.VSIX_SUITE_PREBUILT,
        "1",
        "nor recompile the shard-independent suite per chunk",
    );
    const downloads = shard.filter((step) =>
        step.uses?.startsWith("actions/download-artifact@"),
    );
    assert.ok(
        downloads.some((step) => step.with?.name === "${{ inputs.suite-artifact }}"),
        "declaring a precompiled suite obliges the shard to download it",
    );
    assert.ok(downloads.some((step) => step.with?.name === "${{ inputs.suite-artifact }}-release"),
        "the packaged artifact supplies the host, both sidecars and debugger together");
    assert.equal(run["continue-on-error"], undefined, "a shard may not be advisory");
    const pkg = release.jobs["build-vsix"].steps.find((step) =>
        step.run?.includes("make _package-vsix-${{ matrix.platform }}"),
    );
    assert.ok(pkg, "release must package through the per-platform target");
    assert.equal(
        pkg.env?.VSIX_PREBUILT,
        undefined,
        "a tag must never declare prebuilt: it compiles its own binaries",
    );
});

// Implements [DIST-CI-SMOKE] and [DIST-DEBUGGER-BUNDLE]. The release rebuilds
// the macOS debugger from source, so a Linux/Windows-only PR build cannot
// detect a macOS compiler or linker failure before a tag is published.
test("the macOS debugger source build is a required PR gate", () => {
    const releaseMac = release.jobs["build-vsix"].strategy.matrix.include.find(
        (entry) => entry.platform === "darwin-arm64",
    );
    assert.ok(releaseMac, "the release must declare an Apple Silicon VSIX");

    const build = workflow("ci-build");
    const mac = build.jobs["build-macos"];
    assert.ok(mac, "PR CI must check the macOS debugger before release");
    assert.equal(mac["runs-on"], releaseMac.os);
    assert.ok(
        mac.steps.some((step) =>
            step.run?.includes("node tools/netcoredbg/provide.mjs darwin-arm64"),
        ),
        "PR CI must download the same pinned macOS debugger as release",
    );
    assert.ok(
        mac.steps.some((step) => step.run?.includes("netcoredbg --version")),
        "the macOS check must run the binary it downloaded",
    );
    assert.notEqual(mac["continue-on-error"], true);
    assert.ok(ci.jobs.ci.needs.includes("build"));
});

test("a dependency audit failure reaches the final CI result", () => {
    assert.ok(
        ci.jobs.ci.needs.includes("audit"),
        "CI must depend on the vulnerability audit",
    );
    assert.equal(ci.jobs.ci.if, "${{ always() }}");
    const failure = ci.jobs.ci.steps.find((step) =>
        step.if?.includes("contains(needs.*.result, 'failure')"),
    );
    assert.ok(failure, "a failed dependency must fail the final gate");
    assert.ok(failure.run.includes("exit 1"));
    assert.notEqual(ci.jobs.audit["continue-on-error"], true);
});

test("CI and release run the same non-optional vulnerability scanner", () => {
    for (const caller of [ci, release]) {
        assert.equal(
            caller.jobs.audit.uses,
            "./.github/workflows/ci-audit.yml",
        );
        assert.notEqual(caller.jobs.audit["continue-on-error"], true);
    }
    const audit = workflow("ci-audit");
    assert.ok(Object.hasOwn(audit.on, "workflow_call"));
    const scanner = audit.jobs.audit.steps.find(
        (step) => step.run === "make audit",
    );
    assert.ok(scanner, "the shared audit must execute the real local scanner");
    assert.equal(scanner.if, undefined, "the scanner cannot be conditional");
    assert.notEqual(scanner["continue-on-error"], true);
});

test("vulnerability findings block the release and both VSIX marketplaces", () => {
    assert.ok(release.jobs.release.needs.includes("audit"));
    assert.equal(
        release.jobs.release.if,
        undefined,
        "release must use success-only dependency gating",
    );
    assert.equal(
        release.jobs.audit.if,
        undefined,
        "every tagged release must be audited",
    );
    for (const name of ["publish-marketplace", "publish-openvsx"]) {
        assert.ok(
            release.jobs[name].needs.includes("release"),
            `${name} must wait for the audited release`,
        );
        assert.equal(
            release.jobs[name].if,
            undefined,
            `${name} cannot bypass dependency success`,
        );
    }
});

// [DIST-RELEASE] deploy-pages: production must serve the tagged homepage. The
// verify step's expected strings are the site's own copy, never a second one
// that drifts when the homepage changes (#360).
test("the Pages verify step expects the homepage the site actually builds", () => {
    const deploy = workflow("deploy-pages").jobs.deploy;
    const verify = deploy.steps.find((step) => step.name === "Verify production website");
    assert.ok(verify, "the deploy job must verify production");
    assert.equal(
        verify.env?.EXPECTED_HEADLINE,
        require("../../website/src/_data/i18n.json").en.home.title,
        "the expected headline is the English hero title",
    );
    const { publisher, name } = require("./package.json");
    assert.equal(
        verify.env?.EXPECTED_INSTALL,
        `href="vscode:extension/${publisher}.${name}"`,
        "the expected install link opens this extension",
    );
    for (const variable of ["$EXPECTED_HEADLINE", "$EXPECTED_INSTALL"]) {
        assert.ok(verify.run.includes(`"${variable}"`), `the probe must look for ${variable}`);
    }
});
