# pi model comparison: Kimi k3.1-pro and GLM 5.3

Work: the explicit, never-silent import quick fixes ([REFACTOR-IMPORT], [REFACTOR-NEVER-SILENT]), October 2026. The lead (Claude) monitored every session with a watcher that flagged git commands, process kills, edits outside a session's files and writes by read-only tasks. The lead verified each claim by re-running the tests itself. DeepSeek v4-pro could not be tried, because its account had no balance.

## Verdict

**Kimi k3.1-pro is the better engineer, and GLM 5.3 is the better finisher.** Kimi wrote cleaner, better-structured code and was more thorough. It caught its own misreading of the spec without being told. But it ran out of its 5-hour quota mid-change, and it reads files by guessing their paths. GLM was cheap and exact on a well-scoped task. On a large task that crossed every tier, it was the slowest and most expensive session. It invented APIs, let a file grow past the size limit, left one silent path and a broken test helper behind a "green" claim, and ran tests outside its brief.

Use Kimi for design-heavy feature work and audits, and budget for its quota with frequent checkpoints. Use GLM to continue, verify and run tests on work that is already well defined. With either model, the lead must check every "green" claim.

## Head to head: the same read-only audit

Both models got the same prompt: list every path by which a chosen code action fails silently, in every tier. The lead had already verified nine such paths.

| | Kimi k3.1-pro | GLM 5.3 |
|---|---|---|
| Verified paths found | **9 of 9** | 8 of 9: missed the provider exceptions logged at `Debug`, and half-found the dropped added document with no path |
| Additional real findings | 7: resolve URI ignored after a restart, `{applied:false}` from `applyEdit` is silent, untitled documents, partial conversion on cancel, connection loss, F# and Razor listings that fail silently | 2: more precise call chains (`CompilerRefusal` turned into `Ok(None)`; a unit test that codified the dropped edit; a map insert that overwrites) |
| Method | 137 reads, 0 searches | 69 searches, 23 reads |
| Failed tool calls | **42 (31%)**, every one a guessed path that doesn't exist, such as `WorkspaceManager.CodeActions.cs` | 2 |
| Turns, time, cost | 22, 12.3 min, $1.10 | 70, 15.0 min, $0.99 |

## Implementation sessions

| Session | Model | Task | Outcome | Turns | Time | Cost |
|---|---|---|---|---|---|---|
| pi-import-fsharp | Kimi | F# half: titles, fully qualified row, `open type`, reference rows, F# never-silent | It delivered most of the F# half and its sidecar tests passed 14 of 14. It found and fixed its own misreading of the spec, that project rows and solution-package rows must coexist. **It stopped on a 429 (5-hour usage limit) partway through its last change**, and it never ran the VS Code suite. | 125 | 44.7 min | $4.07 |
| pi-import-fsharp-2 | GLM | Finish Kimi's work | **Flawless.** It showed the half-done change red and then green by mutating it, extended the test, and ran both VS Code F# suites (2 and 20 passing). The lead re-ran the sidecar tests: 98 of 98 pass. | 53 | 26.3 min | $0.81 |
| pi-import-silent | GLM | Never-silent in the C# sidecar, the host and VS Code | It delivered failing resolves with plain-words reasons, a path for added documents, `Warning` logs, LSP errors in place of `null`, the VS Code middleware and 5 tests, and 5 existing tests updated to the spec's exact reasons. Problems: **it invented Roslyn APIs** (`SolutionChanges.AddedProjects`), which broke the shared build for the other agents several times. `CodeActionResolver.cs` grew to 848 lines before it split the file. It left an `executeCommand` middleware that can never run, although it had been told the client strips that feature. It **left one silent path**: a connection that closes under a resolve. Its `Show Log` stub recursed into itself (2803 calls) and was never restored. It ran the whole C# test project against its brief. After its wrapper shell died (exit 144) it kept running as an orphan until the lead stopped it. The lead finished the last parts, each shown red and then green. | 277 | 104 min | $10.84 |

## What both did well

- **They kept to the rules.** No git commands, no process kills, the build lock taken and released, locks in Too Many Cooks, failing tests written before fixes. Every exact title and message the spec gives was asserted exactly.
- **They kept to their files.** The only flagged edit was GLM creating a partial class to split a file it owned.

## Cost of the delivered work

- **F# half:** $4.88 in total, $4.07 from Kimi and $0.81 from GLM.
- **Never-silent chain:** $10.84 from GLM, plus the lead's fixes.
- **Audits:** about $1 each.
