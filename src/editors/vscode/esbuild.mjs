// @ts-check
import * as esbuild from "esbuild";
import * as fs from "node:fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * The dev build's sourcemap, which the production build does not overwrite.
 *
 * `pretest` runs the DEV build (sourcemap: true), then `vsce package` runs the
 * production one. esbuild rewrites `extension.js` but has no reason to touch a
 * `.map` it is no longer emitting, so the stale dev map survives into `dist/` —
 * and package.json's `files` allow-list ships the whole directory. The payload
 * verifier rejects it as a dev artefact, which failed every VS Code job.
 * Deleting it is the build's own responsibility: nothing else knows it is stale.
 */
const STALE_SOURCEMAP = "dist/extension.js.map";

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: "info",
  // Production ships a single self-contained bundle (vsce packages with
  // --no-dependencies). The dev build instead leaves node_modules external so
  // the bundle contains ONLY first-party src/*.ts: the test host loads this
  // build, and code-coverage remaps its execution cleanly onto src without the
  // dependency sources an inlined bundle would drag into the report. Deps are
  // resolved at runtime from node_modules, which is present during dev/test.
  ...(production ? {} : { packages: "external" }),
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes…");
} else {
  await esbuild.build(buildOptions);
  if (production) fs.rmSync(STALE_SOURCEMAP, { force: true });
}
