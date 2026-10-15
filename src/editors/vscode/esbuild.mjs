// @ts-check
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import { extensionBuildOptions } from './esbuild-options.mjs';

const production = process.argv.includes('--production');

const watch = process.argv.includes('--watch');

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
const STALE_SOURCEMAP = 'dist/extension.js.map';

for (const options of [extensionBuildOptions(production)]) {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}
const graphLicenses = [
  'node_modules/d3-force/LICENSE',
  'node_modules/d3-dispatch/LICENSE',
  'node_modules/d3-quadtree/LICENSE',
  'node_modules/d3-timer/LICENSE',
].map((file) => fs.readFileSync(file, 'utf8'));
fs.writeFileSync(
  'dist/profiler-graph-licenses.txt',
  'Bundled graph dependencies: d3-force, d3-dispatch, d3-quadtree, d3-timer.\n\n' +
    [...new Set(graphLicenses)].join('\n\n'),
);
if (!watch) {
  if (production) fs.rmSync(STALE_SOURCEMAP, { force: true });
}
