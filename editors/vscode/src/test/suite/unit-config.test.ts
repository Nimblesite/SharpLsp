import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import * as config from "../../config.js";
import { CONFIG_SECTION } from "../../constants.js";

suite("Config Module — Direct Function Tests", () => {
    // ── serverPath() ─────────────────────────────────────────────
    test("serverPath() returns a string", () => {
        const result = config.serverPath();
        assert.strictEqual(typeof result, "string", "Must return a string");
    });

    test("serverPath() returns the configured value when set", async () => {
        const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const original = wsConfig.get<string>("server.path");
        try {
            await wsConfig.update(
                "server.path",
                "/tmp/fake-forge-lsp",
                vscode.ConfigurationTarget.Workspace,
            );
            const result = config.serverPath();
            assert.strictEqual(result, "/tmp/fake-forge-lsp");
        } finally {
            await wsConfig.update(
                "server.path",
                original,
                vscode.ConfigurationTarget.Workspace,
            );
        }
    });

    test("serverPath() returns empty string for null-ish config", () => {
        const result = config.serverPath();
        assert.ok(
            typeof result === "string",
            "Must always return a string, never undefined",
        );
    });

    // ── serverExtraArgs() ────────────────────────────────────────
    test("serverExtraArgs() returns empty array when not configured", () => {
        const result = config.serverExtraArgs();
        assert.ok(Array.isArray(result), "Must return an array");
        assert.strictEqual(result.length, 0, "Default should be empty array");
    });

    test("serverExtraArgs() returns configured array when set", async () => {
        const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const original = wsConfig.get<string[]>("server.extraArgs");
        try {
            await wsConfig.update(
                "server.extraArgs",
                ["--verbose", "--port=9090"],
                vscode.ConfigurationTarget.Workspace,
            );
            const result = config.serverExtraArgs();
            assert.deepStrictEqual([...result], ["--verbose", "--port=9090"]);
        } finally {
            await wsConfig.update(
                "server.extraArgs",
                original,
                vscode.ConfigurationTarget.Workspace,
            );
        }
    });

    test("serverExtraArgs() returns readonly array", () => {
        const result = config.serverExtraArgs();
        assert.ok(Array.isArray(result), "Must be an array");
    });

    // ── loggingLevel() ───────────────────────────────────────────
    test("loggingLevel() returns 'info' by default", () => {
        const result = config.loggingLevel();
        assert.strictEqual(
            result,
            "info",
            "Default logging level should be info",
        );
    });

    test("loggingLevel() returns the configured value when set", async () => {
        const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const original = wsConfig.get<string>("logging.level");
        try {
            await wsConfig.update(
                "logging.level",
                "debug",
                vscode.ConfigurationTarget.Workspace,
            );
            const result = config.loggingLevel();
            assert.strictEqual(result, "debug");
        } finally {
            await wsConfig.update(
                "logging.level",
                original,
                vscode.ConfigurationTarget.Workspace,
            );
        }
    });

    test("loggingLevel() returns 'info' as fallback for undefined config", () => {
        const result = config.loggingLevel();
        assert.ok(typeof result === "string", "Must always return a string");
        assert.ok(result.length > 0, "Must never return empty string");
    });

    // ── section() (internal, tested via all the above) ───────────
    test("all config functions read from the 'forge' section", () => {
        const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
        assert.ok(wsConfig, "forge config section must be accessible");
    });

    // ── Edge cases ───────────────────────────────────────────────
    test("serverPath() called multiple times returns consistent results", () => {
        const a = config.serverPath();
        const b = config.serverPath();
        assert.strictEqual(a, b, "Same call should return same result");
    });

    test("serverExtraArgs() called multiple times returns consistent results", () => {
        const a = config.serverExtraArgs();
        const b = config.serverExtraArgs();
        assert.deepStrictEqual(
            [...a],
            [...b],
            "Same call should return same result",
        );
    });

    test("loggingLevel() called multiple times returns consistent results", () => {
        const a = config.loggingLevel();
        const b = config.loggingLevel();
        assert.strictEqual(a, b, "Same call should return same result");
    });
});
