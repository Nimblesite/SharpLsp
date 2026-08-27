// Remove the tsc test-build output directory (`out/`) so a stale compiled test
// from a deleted or renamed source can never run again. `tsc` never prunes
// orphaned emit, and the mocha glob (`out/**/*.test.js`) would otherwise execute
// leftover `.js` against current source — a confusing phantom failure that CI
// (which builds `out/` from a clean checkout) never reproduces. Run before every
// `compile-tests` to keep the VSIX test build deterministic. See issue #132.
import { rmSync } from 'node:fs';

rmSync('out', { recursive: true, force: true });
