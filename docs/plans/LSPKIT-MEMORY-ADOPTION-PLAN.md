# lspkit Memory Fix Adoption Plan

Pull lspkit's memory-leak repairs into SharpLsp once lspkit publishes them, and close the watcher gap behind the
F# sidecar's 3.4 GB growth ([PROFILER-SHARED-LIBRARY], issues #566, #563). lspkit is consumed only as published
packages: crates `lspkit` and `lspkit-server`, and its source pinned by `LSPKIT_VERSION`. It is never a path dependency.

Owners: the lspkit work is `codex-memory-leak-fix` (lspkit `docs/plans/memory-leak-fixes.md`). The SharpLsp
adoption is the SharpLsp agent on the open `fix/*` branch. They coordinate on Too Many Cooks.

## [LSPKIT-MEM-UPSTREAM] lspkit side (release first)

- [x] The five proven leaks are fixed with their red/green heap proofs unchanged:
  - correlator request ownership
  - inbound reader shutdown
  - ingress registration release
  - reference-server `didClose` buffers
  - handler cycle
- [x] `PullStore` (lspkit-server `pull`): `QueryState.documents` keeps a Salsa `DocumentInput` and its `analyze` memo
      for every URI ever pulled, so files deleted, renamed or left by a solution switch stay resident for the host's
      life. Add a release API, for example `PullStore::forget(uri)`, or prune to a caller-supplied live set. Prove it
      with a red/green test that pulls N URIs, forgets them, and asserts no input or memo remains. Shipped in 0.5.0 as
      `PullStore::clear()`, which drops the whole Salsa database because inputs can't be deleted one at a time.
- [ ] `live/watcher.rs`: a lost-event `ChangeEvent::Rescan` carries the affected root paths, not an empty set. SharpLsp
      can then reload only the projects under them instead of re-checking every loaded compiler. File this as an lspkit
      issue if it is out of scope for the leak plan. Not in 0.5.0: still open.
- [x] Release lspkit `0.4.1` (or `0.5.0` if the `Rescan` shape changes) to crates.io, and tag `v<version>` so
      `make _fetch-lspkit` can unpack the source
- [x] Post the release version on TMC to the SharpLsp agent

## [LSPKIT-MEM-ADOPT] SharpLsp side (after the release)

- [x] Bump `lspkit` / `lspkit-server` in `src/sharplsp/Cargo.toml` and `LSPKIT_VERSION` in `Makefile` together, then
      `cargo update -p lspkit -p lspkit-server`
- [x] Bump `@nimblesite/lsp-profiler-ui` if lspkit released it in the same train
- [ ] If `Rescan` carries paths: in `pull_diagnostics/relevance.rs`, scope `rescanned` to the loaded graphs whose
      projects sit under those paths. Keep the `changed_since_open` mtime check as the fallback for a pathless rescan.
      Add the permutation to `a_rescan_reloads_only_a_compiler_whose_inputs_changed_since_its_open`.
- [x] Call `PullStore::clear()` when a document closes (`state::release_closed`) and when a solution load finishes
      (`state::load_finished`). Because `clear()` drops every input, a deleted or renamed file's memo goes on the next
      close or solution switch. The host-side leaks in the push gate, restore lanes and feed cache are already fixed,
      each with a test that failed on the leak (efa9446c)
- [ ] Add a host test that fails if a closed document's memo is still held. This needs lspkit to expose a document
      count or a heap probe on `PullStore`; file it on lspkit.
- [ ] Delete any SharpLsp scaffolding the release makes redundant. Don't keep a copy.
- [ ] `make ci` locally. Open a PR with `gh pr merge --auto --squash`, then own it until it's green.
- [ ] Measure the F# sidecar RSS on this repo for 30 minutes of idle plus editing. It must stay under the #566 soft budget
      (2 GB), with no repeated `workspace/open` in the host log.
- [ ] Release SharpLsp and verify #566 and #563 against the released binaries. Only then close the issues and delete this plan.
