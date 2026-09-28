# Draft issue for Samsung/netcoredbg — NOT SUBMITTED YET

Also relevant, already open upstream: #220 (`feat: DAP command for Edit & Continue (EnC)`)
covers the other patch on our fork branch. Comment there rather than filing a
duplicate; offer the fork's `applyDeltas` commit as the promised PR.

Fix branch for both: https://github.com/Nimblesite/netcoredbg/tree/sharplsp/dap-hot-reload

---

**Title:** A step from a first-chance exception stop in a module without symbols fails with 0x80004005 and loses the step

**Body:**

**Version:** netcoredbg 3.2.0-1092 (9744e1f), Windows x64, Linux x64/arm64, macOS arm64; .NET 8, 9 and 10.

**Repro:** debug over DAP with `justMyCode: false` and `setExceptionBreakpoints` set to break on all thrown CLR exceptions. Run code that calls into a library whose internals throw and catch — a release-built dependency without PDBs is enough. When the debugger stops on the first-chance throw inside the library frame, send `next` (or `stepIn`/`stepOut`).

**Observed:** the step request fails:

```
Failed command 'next' : 0x80004005
```

The user's step is gone. The only way forward is `continue`, which runs past the user code the step was aimed at. Stepping works again only if the stop happens to be in a frame with sequence points.

**Expected:** the step degrades instead of failing. `Steppers::SetupStep` gives up when `GetFrameILAndSequencePoint` cannot resolve the stop frame (no PDB, so no IL offset and no sequence point), but nothing about the frame stops the CLR from stepping: falling back to the simple stepper steps through the library handler and lands on the next line of user code, which is what a user pressing F10 at an exception popup wants.

We hit this in SharpLsp, which bundles stock netcoredbg release binaries as its debug adapter: any user who enables first-chance exception breaks and steps at the stop loses their step. Our fork carries a small fix (fall back to `m_simpleStepper` when the frame has no sequence point) with tests, on the branch linked above — happy to open a PR.

Found by SharpLsp's debug end-to-end suite, which runs this scenario for C# and F# on every PR.
