// Tests [PROFILER-SHARED-LIBRARY-VSCODE] against the production bundler configuration.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { extensionBuildOptions } from '../../src/editors/vscode/esbuild-options.mjs';
const require = createRequire(new URL('../../src/editors/vscode/package.json', import.meta.url));
const { build } = require('esbuild');

test('production host signals notify CommonJS profiler effects on every change', async () => {
    const result = await build({
        ...extensionBuildOptions(true), write: false, logLevel: 'silent',
        absWorkingDir: fileURLToPath(new URL('../../src/editors/vscode/', import.meta.url)),
        entryPoints: [fileURLToPath(new URL('./fixtures/signals.mjs', import.meta.url))],
        nodePaths: [fileURLToPath(new URL('../../src/editors/vscode/node_modules/', import.meta.url))],
    });
    const context = { module: { exports: undefined } };
    runInNewContext(result.outputFiles.find((file) => file.path.endsWith('.js')).text, context);
    assert.equal(JSON.stringify(context.module.exports), '[0,1,2]', 'changes notify until disposal');
});
