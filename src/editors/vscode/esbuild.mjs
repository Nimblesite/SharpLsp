// @ts-check
import * as esbuild from 'esbuild';
import { extensionBuildOptions } from './esbuild-options.mjs';

const production = process.argv.includes('--production');

const watch = process.argv.includes('--watch');

for (const options of [extensionBuildOptions(production)]) {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}
