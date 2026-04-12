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
      launchArgs: ["--disable-extensions"],
    },
  ],
  coverage: {
    exclude: ["out/test/**"],
    reporter: ["text", "text-summary", "json-summary", "html", "lcov"],
  },
});
