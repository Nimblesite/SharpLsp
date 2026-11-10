// Real installed VSIX probe for [DIST-VERSION-MATCH], #45.
const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(action, accepts) {
    const deadline = Date.now() + 60000;
    let result;
    do {
        result = await action();
        if (accepts(result)) return result;
        await pause(100);
    } while (Date.now() < deadline);
    throw new Error(`Activation did not settle: ${JSON.stringify(result)}`);
}

function createSource(root) {
    fs.writeFileSync(
        path.join(root, "Startup.cs"),
        "namespace ReleaseProbe; public class Startup {}\n",
    );
    fs.writeFileSync(
        path.join(root, "Input.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    );
    fs.writeFileSync(path.join(root, "Directory.Build.props"), "<Project />");
    fs.writeFileSync(path.join(root, "Directory.Build.targets"), "<Project />");
    fs.writeFileSync(path.join(root, ".editorconfig"), "root = true\n");
    return vscode.Uri.file(path.join(root, "Startup.cs"));
}

function settings() {
    return Object.fromEntries(
        ["lspPath", "csharpSidecarPath", "fsharpSidecarPath"].map((key) => [
            key,
            vscode.workspace.getConfiguration("sharplsp").get(key),
        ]),
    );
}

async function assertMatching(api, document, result) {
    const client = await poll(() => api.getLspClient(), Boolean);
    const params = {
        textDocument: { uri: document.toString() },
        position: { line: 0, character: 38 },
    };
    result.hover = await poll(
        () => client.sendRequest("textDocument/hover", params),
        (hover) => !!hover?.contents,
    );
    assert.deepEqual(result.errors, []);
}

function clientState(api) {
    const client = api.getLspClient();
    return { clientCreated: !!client, running: client?.isRunning() ?? false };
}

async function assertMismatch(api, result) {
    result.state = await poll(
        () => clientState(api),
        (state) => result.errors.length > 0 || state.running,
    );
    assert.equal(
        result.state.clientCreated,
        false,
        "explicit version mismatch must block startup",
    );
    assert.ok(
        result.errors.some(
            (message) =>
                message.includes("0.32.1") && message.includes("0.33.0"),
        ),
    );
}

async function activate(extension, result) {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    result.settings = settings();
    const document = createSource(root);
    await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument(document),
    );
    const api = await extension.activate();
    if (result.name === "positive") await assertMatching(api, document, result);
    else await assertMismatch(api, result);
    result.passed = true;
}

function publishedExtension() {
    const extension = vscode.extensions.getExtension("nimblesite.sharplsp");
    assert.equal(extension.packageJSON.version, "0.33.0");
    assert.equal(
        fs.realpathSync(extension.extensionPath),
        fs.realpathSync(process.env.SHARPLSP_RELEASE_VSIX),
    );
    return extension;
}

function captureErrors(extension, result) {
    const api = createRequire(
        path.join(extension.extensionPath, extension.packageJSON.main),
    )("vscode");
    const original = api.window.showErrorMessage;
    api.window.showErrorMessage = async (message) => {
        result.errors.push(message);
    };
    return () => {
        api.window.showErrorMessage = original;
    };
}

function saveResult(result) {
    fs.writeFileSync(
        process.env.SHARPLSP_VERSION_RESULT,
        JSON.stringify(result),
    );
}

exports.run = async () => {
    const result = { name: process.env.SHARPLSP_VERSION_CASE, errors: [] };
    const extension = publishedExtension();
    const restore = captureErrors(extension, result);
    try {
        await activate(extension, result);
    } catch (error) {
        result.failed = String(error);
        throw error;
    } finally {
        restore();
        saveResult(result);
    }
};
