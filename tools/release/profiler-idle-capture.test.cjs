// #530 published VSIX regression. Implements [PROF-MEMORY-STOP].
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const {
    buildFixture,
    requireExtensionManifest,
    skipUnlessEnabled,
} = require("./release-host.cjs");
const { files } = require("./fixtures/profiler-idle-capture.cjs");
const { requiredPath: required } = require("./fixtures/release-editor.cjs");
function settings(root) {
    fs.mkdirSync(join(root, ".vscode"));
    fs.writeFileSync(
        join(root, ".vscode/settings.json"),
        JSON.stringify({
            "dotnetAcquisitionExtension.existingDotnetPath": [
                {
                    extensionId: "nimblesite.sharplsp",
                    path: join(required("DOTNET_ROOT"), "dotnet"),
                },
            ],
            "security.workspace.trust.enabled": false,
            "extensions.autoUpdate": false,
            "telemetry.telemetryLevel": "off",
            "workbench.startupEditor": "none",
        }),
    );
}
function editorArguments(root, profile) {
    return [
        "--user-data-dir",
        profile,
        "--extensions-dir",
        required("SHARPLSP_RELEASE_EXTENSIONS_DIR"),
        "--extensionDevelopmentPath",
        required("SHARPLSP_RELEASE_VSIX"),
        "--extensionTestsPath",
        join(__dirname, "fixtures/profiler-idle-capture.cjs"),
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-workspace-trust",
        "--disable-updates",
        root,
    ];
}
function editor(root, profile) {
    return spawn(
        required("SHARPLSP_TEST_CODE"),
        editorArguments(root, profile),
        { env: { ...process.env, DOTNET_PROCESSOR_COUNT: "2" } },
    );
}
function readEvidence(root) {
    const file = join(root, "release-result.json");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}";
}
async function editorResult(root, profile) {
    const child = editor(root, profile);
    let output = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
        output = (output + chunk).slice(-4000);
    });
    const [code, signal] = await once(child, "close");
    return { code, signal, profile, evidence: readEvidence(root), output };
}
function assertResult(context, result) {
    context.diagnostic(JSON.stringify(result));
    assert.equal(result.code, 0, result.evidence || result.output);
    assert.equal(
        JSON.parse(result.evidence).rows.at(-1)?.passed,
        true,
        "real editor journey completed",
    );
}
async function run(context) {
    requireExtensionManifest();
    const root = buildFixture("slsp-idle-heap-", files, "Input.fsproj");
    const profile = fs.mkdtempSync(join(tmpdir(), "slsp-idle-heap-editor-"));
    try {
        settings(root);
        assertResult(context, await editorResult(root, profile));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
test(
    "#530 published idle session captures twice within40s after a frozen capture is stopped",
    {
        skip:
            process.platform === "win32" ||
            skipUnlessEnabled(
                "#530 v0.33.0 idle restart exceeds40s; POSIX actual published editor required",
            ),
        timeout: 240000,
    },
    run,
);
