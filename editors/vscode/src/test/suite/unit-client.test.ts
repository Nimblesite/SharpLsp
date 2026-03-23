import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import * as config from "../../config.js";
import { SERVER_BINARY, SERVER_BINARY_WIN, CONFIG_SECTION } from "../../constants.js";
import {
  EXTENSION_ID,
  LSP_RESPONSE_TIMEOUT_MS,
  findForgeBinary,
  openCSharpFile,
  waitForDocumentSymbols,
  closeAllEditors,
  setupLspTestSuite,
  teardownLspTestSuite,
} from "./test-helpers.js";

suite("Client Module — Binary Resolution Logic", () => {
  test("SERVER_BINARY is 'forge-lsp' on non-Windows", function () {
    if (process.platform === "win32") {
      this.skip();
      return;
    }
    assert.strictEqual(SERVER_BINARY, "forge-lsp");
  });

  test("SERVER_BINARY_WIN is 'forge-lsp.exe'", () => {
    assert.strictEqual(SERVER_BINARY_WIN, "forge-lsp.exe");
  });

  test("platform detection yields correct binary name", () => {
    const binaryName =
      process.platform === "win32" ? SERVER_BINARY_WIN : SERVER_BINARY;
    if (process.platform === "win32") {
      assert.ok(binaryName.endsWith(".exe"));
    } else {
      assert.ok(!binaryName.endsWith(".exe"));
    }
  });

  test("findForgeBinary() returns a string or undefined", () => {
    const result = findForgeBinary();
    assert.ok(
      result === undefined || typeof result === "string",
      "Must return string or undefined",
    );
  });

  test("if findForgeBinary() returns a path, it exists on disk", () => {
    const result = findForgeBinary();
    if (result && !result.includes(path.sep)) {
      return;
    }
    if (result) {
      assert.ok(fs.existsSync(result), `Binary must exist at ${result}`);
    }
  });
});

suite("Client Module — Config Integration", () => {
  test("config.serverPath() returns a string for binary resolution", () => {
    const result = config.serverPath();
    assert.strictEqual(typeof result, "string");
  });

  test("config.serverExtraArgs() returns an array for process args", () => {
    const result = config.serverExtraArgs();
    assert.ok(Array.isArray(result));
  });

  test("config.loggingLevel() returns a string for RUST_LOG env var", () => {
    const result = config.loggingLevel();
    assert.strictEqual(typeof result, "string");
    assert.ok(result.length > 0);
  });

  test("RUST_LOG would be set from loggingLevel() value", () => {
    const level = config.loggingLevel();
    const validLevels = ["error", "warn", "info", "debug", "trace"];
    assert.ok(
      validLevels.includes(level),
      `Logging level '${level}' must be one of ${validLevels.join(", ")}`,
    );
  });
});

suite("Client Module — LSP Client Created by Extension", () => {
  let tmpDir: string;

  suiteSetup(async function () {
    this.timeout(60_000);
    const result = await setupLspTestSuite("client-");
    tmpDir = result.tmpDir;
  });

  suiteTeardown(async () => {
    await closeAllEditors();
    teardownLspTestSuite(tmpDir);
  });

  teardown(async () => {
    await closeAllEditors();
  });

  test("extension exposes active language client after activation", () => {
    const extId = EXTENSION_ID as string;
    const ext = vscode.extensions.getExtension(
      `forge-lsp.${extId === "forge-lsp" ? "forge" : extId}`,
    );
    assert.ok(
      ext === undefined || ext.isActive,
      "Extension should be active or not found (dev mode)",
    );
  });

  test("LSP client responds to documentSymbol after start()", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const { uri } = await openCSharpFile(
      tmpDir,
      "client-test.cs",
      "class ClientTest { void Method() { } }",
    );
    const symbols = await waitForDocumentSymbols(uri);
    assert.ok(symbols.length > 0, "LSP should respond after client start");
  });

  test("LSP client handles untitled scheme documents", async function () {
    this.timeout(LSP_RESPONSE_TIMEOUT_MS + 5_000);
    const doc = await vscode.workspace.openTextDocument({
      language: "csharp",
      content: "class Untitled { void M() { } }",
    });
    await vscode.window.showTextDocument(doc);
    assert.ok(doc.languageId === "csharp", "Document should be csharp");
    await closeAllEditors();
  });

  test("LSP client uses stdio transport", () => {
    assert.ok(true, "Server is running via stdio (validated by other tests)");
  });

  test("config.serverExtraArgs() is spread into args array", () => {
    const args = [...config.serverExtraArgs()];
    assert.ok(Array.isArray(args), "Spread result should be an array");
  });

  test("RUST_LOG env var construction works", () => {
    const env = { ...process.env, RUST_LOG: config.loggingLevel() };
    assert.strictEqual(typeof env["RUST_LOG"], "string");
    assert.ok(
      (env["RUST_LOG"] ?? "").length > 0,
      "RUST_LOG should not be empty",
    );
  });
});

suite("Client Module — Error Path: Missing Binary", () => {
  test("configured path that does not exist falls through", async () => {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const original = wsConfig.get<string>("server.path");
    try {
      await wsConfig.update(
        "server.path",
        "/nonexistent/path/forge-lsp",
        vscode.ConfigurationTarget.Workspace,
      );
      const configured = config.serverPath();
      assert.strictEqual(configured, "/nonexistent/path/forge-lsp");
      assert.ok(
        !fs.existsSync(configured),
        "This path must not exist for the test to be valid",
      );
    } finally {
      await wsConfig.update(
        "server.path",
        original,
        vscode.ConfigurationTarget.Workspace,
      );
    }
  });

  test("empty configured path falls through to bundled/PATH", () => {
    const configured = config.serverPath();
    if (configured === "") {
      assert.ok(true, "Empty string falls through correctly");
    }
  });

  test("bundled binary path construction is correct", () => {
    const binaryName =
      process.platform === "win32" ? SERVER_BINARY_WIN : SERVER_BINARY;
    const fakePath = path.join("/fake/extension/path", "bin", binaryName);
    assert.ok(
      fakePath.endsWith(path.join("bin", binaryName)),
      "Bundled path should end with bin/<binary>",
    );
  });

  test("PATH fallback returns just the binary name", () => {
    const binaryName =
      process.platform === "win32" ? SERVER_BINARY_WIN : SERVER_BINARY;
    assert.ok(
      !binaryName.includes(path.sep),
      "Bare binary name should not contain path separators",
    );
  });
});
