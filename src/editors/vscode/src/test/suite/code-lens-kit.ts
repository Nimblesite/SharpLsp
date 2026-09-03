// Driving the CodeLens surface from an end-to-end test.
//
// `vscode.executeCodeLensProvider` is a FAN-OUT, not a call to one provider:
// VS Code asks EVERY provider registered for the document and resolves only
// once the SLOWEST of them has answered. On a `csharp`/`fsharp` file that is
// two providers, not one:
//
//   • `TestStatusLensProvider` (`src/test-lens.ts`) — pure, in-process, sub-ms;
//   • the LSP client's server-backed provider — `textDocument/codeLens` to the
//     Rust host, which forwards it to the Roslyn or FCS sidecar.
//
// So a test that asserts ONLY on this extension's own lenses still pays the
// sidecar's latency, and the FIRST such call for a language pays that sidecar's
// COLD START. Measured on a warm dev box: 96ms for C# (Roslyn already loaded by
// an earlier suite) against 1967ms for the first F# call in the process — a
// twentyfold gap, and a CI agent cracking FCS for the first time is slower
// again.
//
// Charging that cold start to a test body is what failed three tests at once in
// the Windows `testexplorer` chunk: the first F# lens call blew its ceiling,
// and because the Rust host serves LSP requests one at a time on a single
// dispatch loop, the two C# lens tests queued behind it burned their whole
// ceilings too, without ever being served.
//
// Hence this module: request lenses through `codeLensesFor`, and pay the cold
// start ONCE in `suiteSetup` via `warmCodeLensPath` — the same discipline
// `warmSemanticEngine` applies to code actions ([DIST-CI-VSIX-SHARDS-TIMEOUTS]).

import * as vscode from 'vscode';

/**
 * Every CodeLens contributed for `uri`, from every registered provider.
 *
 * Resolves only when the slowest provider has answered, so a caller belongs on
 * a tier that accounts for a SIDECAR reply (`LSP_RESPONSE_MS` or above), never
 * on `COMMAND_MS` — that tier is defined as an editor round trip which never
 * reaches a sidecar.
 */
export async function codeLensesFor(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    'vscode.executeCodeLensProvider',
    uri,
  );
  return lenses ?? [];
}

/**
 * Pay the code-lens cold start for each `uri` up front. Call from `suiteSetup`
 * on a tier that admits a cold sidecar (`SIDECAR_COLD_MS`), passing ONE file
 * per language the suite goes on to exercise.
 *
 * Sequential on purpose. The host dispatches one request at a time, so issuing
 * them together buys nothing and only makes a hook failure ambiguous about
 * which language never warmed.
 *
 * The result is discarded and nothing is polled for. A loose fixture outside
 * any project may legitimately carry no server-side lenses at all, and a
 * warm-up that can fail on a healthy file is worse than no warm-up — the same
 * trap documented on `warmSemanticEngine`.
 */
export async function warmCodeLensPath(...uris: readonly vscode.Uri[]): Promise<void> {
  for (const uri of uris) {
    await codeLensesFor(uri);
  }
}
