// Shared provenance checks for actual published-editor release regressions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { isAbsolute } = require("node:path");

function requiredPath(name) {
    const value = process.env[name];
    assert.ok(
        value && isAbsolute(value) && fs.existsSync(value),
        `${name} must name an existing absolute path`,
    );
    return value;
}

function publishedExtension() {
    const extension = require("vscode").extensions.getExtension(
        "nimblesite.sharplsp",
    );
    assert.equal(extension.packageJSON.version, "0.33.0");
    assert.equal(
        fs.realpathSync(extension.extensionPath),
        fs.realpathSync(process.env.SHARPLSP_RELEASE_VSIX),
    );
    return extension;
}

module.exports = { requiredPath, publishedExtension };
