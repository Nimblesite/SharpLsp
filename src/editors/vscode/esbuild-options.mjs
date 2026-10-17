// Implements [PROFILER-SHARED-LIBRARY-VSCODE]. Shared by the build and its regression.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/** @returns {import('esbuild').BuildOptions} */
export const extensionBuildOptions = (production) => ({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: 'info',
  // Tests share the external dependencies with the extension. Production
  // packages them into the VSIX's self-contained bundle.
  // ESM and CommonJS must share one effect stack in production, and the
  // extension and its tests must share Node's external module in development.
  ...(production
    ? { alias: { '@preact/signals-core': require.resolve('@preact/signals-core') } }
    : { packages: 'external' }),
});
