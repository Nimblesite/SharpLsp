// @ts-check
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  tests: [
    {
      files: "out/test/suite/**/*.test.js",
      workspaceFolder: "test-fixtures/workspace",
      mocha: {
        ui: "tdd",
        timeout: 60_000,
        bail: true,
      },
      launchArgs: [
        "--disable-extensions",
        `--remote-debugging-port=${process.env.FORGE_SCREENSHOT_CDP_PORT ?? "9229"}`,
        "--disable-workspace-trust",
        `--user-data-dir=${process.env.FORGE_TEST_USER_DATA_DIR ?? `${process.env.TMPDIR ?? "/tmp"}forge-test-userdata`}`,
      ],
    },
  ],
  coverage: {
    exclude: ["out/test/**"],
    reporter: ["text", "text-summary", "json-summary", "html", "lcov"],
  },
});
