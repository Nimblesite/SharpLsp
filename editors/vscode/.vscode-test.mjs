// @ts-check
import { defineConfig } from "@vscode/test-cli";

export default defineConfig([
  {
    files: "out/test/suite/**/*.test.js",
    workspaceFolder: "test-fixtures/workspace",
    mocha: {
      ui: "tdd",
      timeout: 60_000,
    },
    launchArgs: ["--disable-extensions"],
    coverage: {
      includeAll: true,
      include: ["out/*.js"],
      exclude: ["out/test/**"],
      reporter: ["text", "text-summary", "html", "lcov"],
      lines: 100,
      functions: 100,
      branches: 100,
      statements: 100,
    },
  },
]);
