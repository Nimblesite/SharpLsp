# Sidecar Lifecycle Reliability Implementation Plan `[SIDECAR-PLAN]`

**Status:** Active — implements the normative specification; checklist state records completion
**Normative specification:** [SIDECAR-LIFECYCLE-SPEC.md](../specs/SIDECAR-LIFECYCLE-SPEC.md)
**Primary cluster:** `cluster:sidecar-startup` + `cluster:sidecar-lifecycle`
**Issues:** [#150](https://github.com/Nimblesite/SharpLsp/issues/150),
[#151](https://github.com/Nimblesite/SharpLsp/issues/151),
[#152](https://github.com/Nimblesite/SharpLsp/issues/152),
[#153](https://github.com/Nimblesite/SharpLsp/issues/153),
[#154](https://github.com/Nimblesite/SharpLsp/issues/154),
[#163](https://github.com/Nimblesite/SharpLsp/issues/163),
[#164](https://github.com/Nimblesite/SharpLsp/issues/164),
[#167](https://github.com/Nimblesite/SharpLsp/issues/167), and
[#172](https://github.com/Nimblesite/SharpLsp/issues/172)

## 1. Outcome `[SIDECAR-PLAN-OUTCOME]`

Implement one per-language sidecar supervisor and one per-generation connection driver, then route
all startup, health, request, crash, recovery, and shutdown events through them. This is the
highest-value cluster because the nine issues share three mutable resources—child process, IPC
endpoint/transport, and retry state—and the current code lets multiple call paths manage those
resources independently.

The finished system will:

- start one isolated C# or F# sidecar generation even under concurrent semantic requests;
- select only a directly spawnable absolute executable and fall through bad non-explicit candidates;
- use a new unpredictable IPC endpoint per spawn and connect to the endpoint actually bound;
- make every pre-READY failure visible and subject to the same bounded backoff as runtime crashes;
- own all frames in one driver, validate response IDs, and dispatch interleaved notifications;
- distinguish a busy request from an idle or genuinely stalled sidecar without a lock race;
- acknowledge shutdown before cancellation and clean the whole process tree on every platform;
- rehydrate workspace, analyzer configuration, and current VFS documents after recovery; and
- prove all of the above with coarse, real-process end-to-end tests on Windows and Unix.

## 2. Why this cluster is the highest-value fix `[SIDECAR-PLAN-CLUSTER]`

The cluster affects every Roslyn- and FCS-backed feature. A startup storm, endpoint collision,
protocol desynchronization, or orphaned sidecar can disable completion, hover, navigation,
diagnostics, refactoring, and Solution Explorer together. The root problem is not any language
engine; it is fragmented lifecycle ownership in `src/sharplsp/src/sidecar/manager.rs` and
`SidecarHost.MessageLoopAsync`.

The supervisor architecture directly resolves or supplies the necessary foundation for every issue:

| Priority | Issue | Current user impact | Architectural owner after this plan |
|---|---|---|---|
| P0 / critical | #151 | Second editor host collides with or steals the first host's endpoint | Per-spawn endpoint lease + handshake validation |
| P0 / critical | #152 | Each semantic request can launch another doomed process | Single supervisor attempt + unified backoff state |
| P0 / critical | #153 | Broken transport can leave a 100%-CPU zombie | Terminal message-loop outcome + process watcher |
| P0 / critical | #163 | Host failure leaves sidecars, BuildHost, or MSBuild descendants | Parent watcher + Job Object/process group |
| P1 / bug | #150 | Listener failures appear as opaque “before READY” exits | Structured startup outcome + stderr/status/log capture |
| P1 / bug | #154 | Relocated Unix listener advertises the wrong path | Versioned READY record with effective endpoint |
| P1 / bug | #164 | Wrong response can reach a caller; health can kill healthy work | Single transport owner + exact ID/activity tracking |
| P1 / bug | #167 | Windows PATH shim blocks valid fallback artifacts | Typed candidate list + absolute direct spawn |
| P1 / bug | #172 | Graceful shutdown always falls into hard kill | Ack-after-flush shutdown state |

All nine issues currently list `MelbourneDeveloper` as reporter, so severity and implementation
dependency—not a reporter-priority boost—determine their order inside this cluster. The broader issue
inventory can still prioritize reports from outside the owner/Abdul group when clusters have similar
impact.

All nine issues are siblings under this implementation effort. #150 is the label's lead issue, but it
is an observability defect rather than a genuine parent of the other bugs; the plan must not fabricate
native parent/child relationships by making the siblings children of #150.

## 3. Existing plans and present baseline `[SIDECAR-PLAN-BASELINE]`

No existing document owns the complete cluster. Three plans contain adjacent requirements:

- [SCRIPTING-FILEBASED-PLAN.md](SCRIPTING-FILEBASED-PLAN.md) requires one eager/lazy initialization
  path and health only after `workspace/open`.
- [DIAGNOSTICS-PLAN.md](DIAGNOSTICS-PLAN.md) needs sidecar generation invalidation, retries, and
  server-initiated notifications.
- [INFRASTRUCTURE-PLAN.md](INFRASTRUCTURE-PLAN.md) contains only sidecar startup performance (R2R),
  not reliability or process ownership.

This plan becomes the lifecycle source of truth and those plans consume its ready-generation and
notification APIs.

The current tree already contains useful partial patches. They should be retained as behavior but
folded into the new ownership model:

| Issue | Present implementation | Remaining gap |
|---|---|---|
| #150 | `StartupFailed`, one fatal stderr line, non-zero entry-point exit, and host exit-status/log hint | Boolean outcome is listener-specific; startup output is not centrally captured/classified; no full host process test |
| #151 | PID + process-local counter makes managers distinct | Token is reused across restarts; endpoint is not random; Unix listener still deletes a pre-existing path |
| #152 | `spawn_retry_after` throttles an immediate retry | State is split across locks; crash and spawn failure paths differ; concurrent waiters and stable-reset semantics are incomplete |
| #153 | I/O exceptions break and generic failures are capped | Run result does not consistently communicate fatal exit; no process/CPU/log-flood acceptance test |
| #154 | `BoundEndpoint` is printed in READY | Handshake is unversioned/unfenced and is not exercised through the real Rust host |
| #163 | No complete implementation | Direct-child kill, parent death before connect, Windows descendants, and Unix group cleanup remain |
| #164 | Request timeout drops a suspect transport | Response ID is unchecked; health performs check/drop/reacquire; notifications can be mistaken for responses |
| #167 | PATH finder accepts `.cmd`, `.bat`, extensionless entries and spawns a bare name | Candidate type/validation/fallback must be redesigned |
| #172 | Host waits briefly for a response | Sidecar cancels the response write token before returning the ack |

## 4. Target design `[SIDECAR-PLAN-DESIGN]`

### 4.1 Rust facade and supervisor `[SIDECAR-PLAN-DESIGN-SUPERVISOR]`

Keep `SidecarManager` as the stable facade so feature call sites do not learn process details. Internally
it owns bounded `tokio::mpsc` senders to a long-lived supervisor task. Define typed models roughly as:

- `SidecarKind` (`CSharp`, `FSharp`);
- `Generation(u64)`;
- `SupervisorCommand` (`EnsureReady`, `Request`, `UpdateSession`, `Restart`, `Status`, `Shutdown`);
- `SupervisorState` matching [SIDECAR-STATE-MODEL];
- `LaunchCandidate` with absolute program, arguments, and source;
- `EndpointLease` with requested/effective endpoint and ownership;
- `FailureKind` matching [SIDECAR-RECOVERY-FAILURES];
- `SessionSnapshot` for target/configuration/open documents; and
- `SidecarUnavailable` with language, category, and retry time.

The supervisor uses `tokio::select!` across commands, generation-scoped child exit, connection events,
startup timeout, stable-ready timer, and shutdown. It performs no blocking OS wait on the Tokio worker.
It uses `Result`/`Option`, structured errors, and generation checks; there are no production
`unwrap`/`expect`/`panic` paths.

### 4.2 Connection driver `[SIDECAR-PLAN-DESIGN-CONNECTION]`

Move `FramedTransport` out of the manager mutex and into a task that is its sole owner. It maintains
one `ActiveRequest { id, method, written_at, deadline, completion }`, a bounded pending queue, and an
idle-health deadline. It reads continuously, dispatches `id=null/method!=null` notifications, and
requires an exact ID for the active response.

This deliberately keeps semantic dispatch sequential. It supplies correct correlation and
notifications now without introducing concurrent Roslyn/FCS mutation ordering. If multiplexed
handlers are added later, the driver can replace `ActiveRequest` with a pending map without changing
the supervisor contract.

### 4.3 Managed host lifecycle `[SIDECAR-PLAN-DESIGN-DOTNET]`

Replace the `StartupFailed` boolean with a typed `SidecarRunResult`/exit outcome that distinguishes
normal peer close, acknowledged shutdown, startup fatal, transport fatal, and parent death. Parse a
shared `SidecarStartupOptions` in both C# and F# entry points. Initialize `ParentProcessWatchdog` and
`ProcessContainment` before listener creation and before any engine can spawn descendants.

The shutdown request records “shutdown requested” but does not cancel. `ProcessOneMessageAsync` writes
and flushes the response, then cancels the loop. Persistent stream failures terminate the run outcome
instead of re-entering the broken read.

### 4.4 Session recovery `[SIDECAR-PLAN-DESIGN-RECOVERY]`

Extract the duplicated eager startup, lazy project-less startup, second-language startup, and
`sharplsp/loadSolution` code in `src/sharplsp/src/main.rs` into one session-update path. The supervisor stores the
desired target and analyzer configuration; a VFS snapshot provider supplies current open documents.
On every generation it performs the ordered bootstrap in [SIDECAR-RECOVERY-REHYDRATE] before making
the request queue available.

The connection driver exposes sidecar notifications to the LSP orchestration layer. This is the
required transport foundation for `diagnostics/refresh` and `workspace/projectInitializationComplete`
in the diagnostics plan.

## 5. File-level change map `[SIDECAR-PLAN-FILES]`

| Path | Planned responsibility/change |
|---|---|
| `src/sharplsp/src/sidecar/manager.rs` | Thin facade, public request/session/status/shutdown API; remove child/transport/backoff lock ownership |
| `src/sharplsp/src/sidecar/supervisor.rs` | New actor, state transitions, generation fencing, launch/bootstrap/backoff/shutdown orchestration |
| `src/sharplsp/src/sidecar/connection.rs` | New sole transport owner, request queue, ID validation, notifications, activity/deadlines |
| `src/sharplsp/src/sidecar/launch.rs` | New typed resolution candidates, spawn validation, versioned READY parsing, capped output collection, endpoint leases |
| `src/sharplsp/src/sidecar/process_tree.rs` | New safe platform abstraction for direct child/process group and hard termination; no Rust unsafe code |
| `src/sharplsp/src/sidecar/protocol.rs` | Envelope shape validators, READY DTO, notification classification, typed protocol faults |
| `src/sharplsp/src/sidecar/transport.rs` | Keep bounded framing; distinguish clean EOF from truncated frame; split/ownership support if required by driver |
| `src/sharplsp/src/sidecar/mod.rs` | Export only facade/public status types; keep internal modules private |
| `src/sharplsp/src/main.rs` | Replace eager/lazy health tasks with session updates; provide target/config/VFS replay and notification sink |
| `src/sharplsp/src/diagnostics.rs` / pull diagnostics path | Invalidate on generation change and consume sidecar notifications without owning lifecycle |
| `src/sidecars/SharpLsp.Sidecar.Common/SidecarStartupOptions.cs` | Shared strict argument parser for endpoint, parent PID, generation, protocol |
| `src/sidecars/SharpLsp.Sidecar.Common/SidecarRunResult.cs` | Shared typed terminal outcome and failure category |
| `src/sidecars/SharpLsp.Sidecar.Common/ParentProcessWatchdog.cs` | Pre-READY hard-parent-death detection |
| `src/sidecars/SharpLsp.Sidecar.Common/ProcessContainment.cs` | Windows safe Job Object lifetime and Unix group termination support |
| `src/sidecars/SharpLsp.Sidecar.Common/SidecarHost.cs` | Versioned READY, terminal loop faults, ack-before-cancel, typed run outcome |
| `src/sidecars/SharpLsp.Sidecar.Common/Ipc/IpcConnection.cs` | No blind socket deletion; owned path cleanup; effective endpoint; current-user access |
| C# and F# `Program` entry points | Use shared options/outcome; emit correct non-zero status once; remove duplicated lifecycle decisions |
| `src/sharplsp/tests/fixtures/SidecarLifecycleFixture/` | Real separately spawned shared-host fixture for protocol faults, delayed handlers, and child-process containment |
| `src/sharplsp/tests/e2e_modules/sidecar_lifecycle.rs` | Full host/process/IPC recovery scenarios and issue traceability |
| `src/sidecars/SharpLsp.Sidecar.Common.Tests/SidecarHostEndToEndTests.cs` | Keep only coarse real-IPC host lifecycle coverage; add ack and process-exit assertions |
| `.github/workflows/ci-rust.yml` / `ci-dotnet.yml` | Run platform-relevant real-process lifecycle cases |
| `.github/workflows/ci-vsix-windows.yml` | Gate the lifecycle chunk on concurrent hosts, restart, and Windows tree cleanup |

File names may be adjusted to match an equivalent existing abstraction discovered during
implementation, but responsibilities MUST remain single-owner and the final tree MUST not retain a
second restart/health loop.

## 6. Implementation sequence `[SIDECAR-PLAN-SEQUENCE]`

### 6.1 Phase 0 — characterize the contract `[SIDECAR-PLAN-PHASE-0]`

First add real-process failing scenarios for the nine issues and record current attempt counts, PIDs,
exit statuses, endpoint paths, and shutdown behavior. Build the lifecycle fixture on production
`SidecarHost` and OS IPC; it is an executable artifact, not an in-memory mock. Add deterministic
commands to induce wrong response IDs, delayed responses, malformed frames, and a real child helper.

Audit available safe process/job primitives before adding dependencies. Any reused crate must work
with `unsafe_code = "deny"`; if Windows native calls are needed, keep safe handles and P/Invoke in the
shared managed process-containment implementation rather than adding Rust unsafe blocks.

### 6.2 Phase 1 — supervisor skeleton and generation state `[SIDECAR-PLAN-PHASE-1]`

Introduce the actor and facade behind the current `SidecarManager` API. Move coalesced ensure-ready,
child exit monitoring, one retry timestamp, failure classification, backoff growth/reset, and
idempotent shutdown into the actor before changing the wire protocol. Preserve observable request
behavior while deleting the independent health-loop and spawn-failure state only after call sites use
the actor.

This phase is the root fix for #152 and prevents later endpoint/connection work from creating another
set of shared locks.

### 6.3 Phase 2 — resolution, endpoint, and startup handshake `[SIDECAR-PLAN-PHASE-2]`

Replace `sidecar_launch`/`find_on_path` with the candidate model. Resolve absolute apphosts or explicit
`dotnet <dll>` launches, remove `dotnet run`, and iterate only allowed fallback failures. Allocate a
new CSPRNG endpoint lease per generation. Stop deleting pre-existing Unix sockets and clean only
owned paths.

Add shared sidecar option parsing and emit the versioned READY JSON with generation, PID, and effective
endpoint. The supervisor races READY, child exit, EOF, and timeout; captures bounded output; validates
the record; performs transient connect retries; and reports one classified error/backoff event.

This phase completes #150, #151, #154, and #167 and folds their current partial patches into the actor.

### 6.4 Phase 3 — connection driver, correlation, and health `[SIDECAR-PLAN-PHASE-3]`

Move the transport into its driver task. Add strict envelope classification, exact response-ID
validation, notification dispatch, bounded command capacity, pre/post-write cancellation behavior,
and transport poisoning on timeout/correlation/framing faults. Replace the external health monitor
with the driver's idle/activity timer. Keep existing 600s/120s request budgets and the 2s ping budget.

This phase completes #164 and supplies notification support needed by diagnostics recovery.

### 6.5 Phase 4 — managed loop and graceful shutdown `[SIDECAR-PLAN-PHASE-4]`

Return typed run outcomes from `SidecarHost`. Treat permanent stream errors as terminal, cap recoverable
decode failures, and make both entry points map terminal outcomes consistently. Change shutdown to
flush the correlated response before cancelling and let the supervisor wait for ack/clean exit before
hard termination.

This phase completes #153 and #172.

### 6.6 Phase 5 — process-tree containment `[SIDECAR-PLAN-PHASE-5]`

Make production and development launches direct. Start the parent watcher and containment before
READY. On Windows, create/retain a kill-on-close Job Object and assign the sidecar before engine child
processes can start. On Unix, create a dedicated process group and target only that generation's group
for planned hard termination. Verify host death while the sidecar is still waiting for a connection,
while idle, and while a real child helper exists.

This phase completes #163. It must land for C# and F# together.

### 6.7 Phase 6 — bootstrap and recovery integration `[SIDECAR-PLAN-PHASE-6]`

Unify `start_sidecar`, lazy initialization, second-language initialization, and load-solution updates
around `SessionSnapshot`. On a new generation, open the target, configure analyzers, replay latest VFS
documents, attach notification consumers, then mark ready. Emit generation-change invalidation so
diagnostics and semantic caches retry/refresh safely.

This phase turns process restart into actual feature recovery instead of merely reconnecting an empty
sidecar.

### 6.8 Phase 7 — cross-platform gates and rollout `[SIDECAR-PLAN-PHASE-7]`

Run focused lifecycle e2e tests during development, then the complete Rust, .NET, and Windows VSIX
gates. Capture structured logs for one forced failure/recovery cycle and prove there is one spawn per
backoff window, no stale endpoint, no child process, and no hard kill on normal shutdown. Close each
issue only with its specific platform evidence; do not close the cluster solely because the refactor
compiled.

## 7. Test and verification strategy `[SIDECAR-PLAN-TESTING]`

### 7.1 Test artifact policy `[SIDECAR-PLAN-TESTING-ARTIFACTS]`

The test fixture is a real executable using the same `SidecarHost`, `IpcListener`, framing, argument
parser, parent watcher, containment, and shutdown code as production. It may expose handlers whose
normal behavior is “delay”, “respond with a selected protocol fault”, or “spawn a child helper”; the
production supervisor contains no test-only branch. Engine recovery tests use the actual published
C# and F# sidecars and real workspaces.

Do not add in-memory transport tests as acceptance evidence. Existing narrow tests may remain, but
issue closure requires the real-process scenarios in [SIDECAR-TESTING].

### 7.2 Platform matrix `[SIDECAR-PLAN-TESTING-MATRIX]`

| Scenario | Windows | Linux | macOS |
|---|---:|---:|---:|
| Listener fatal/status/log path | Required | Required | Required |
| Two hosts, one workspace | Required named pipe | Required Unix socket | Required Unix socket |
| Spawn backoff and recovery | Required | Required | Required |
| Long/effective Unix endpoint | N/A | Required | Required |
| PATH shim fallback | Required | N/A | N/A |
| Wrong ID, notification interleave, health activity | Required | Required | Required |
| Ack-before-exit shutdown | Required | Required | Required |
| Job Object descendants | Required | N/A | N/A |
| Process-group/parent-death cleanup | N/A | Required | Required |
| C# and F# VFS rehydration | Required | Required | At least CI smoke if runner budget is constrained |
| Full packaged editor lifecycle | Required VSIX | Existing VSIX gate | Existing VSIX gate |

Use event-driven readiness, process exit, log record, and semantic-response assertions. Polling may be
bounded where an OS API has no awaitable interface, but a fixed sleep is never the only success
condition.

### 7.3 Validation commands `[SIDECAR-PLAN-TESTING-COMMANDS]`

During implementation, use the narrowest relevant real-process target first, followed by:

```text
make _test-dotnet
make _test-rust
make _test-vsix-win        # Windows lifecycle/editor surface
make lint
```

The final verification also runs the release-built sidecars' `--version` and startup contracts and
checks that both C# and F# artifacts use the shared lifecycle implementation.

## 8. Rollout and failure handling `[SIDECAR-PLAN-ROLLOUT]`

Ship the host and sidecars together behind the protocol version in READY. During one release the host
may accept the legacy handshake only after exact binary version verification; remove the compatibility
parser after all supported bundles emit protocol 1. No user-facing feature flag should select between
old and new supervisors because dual lifecycle implementations would make failures untriageable.

Before release, exercise one forced failure of every category and inspect the editor output channel:
one concise event and log link are allowed, while repeated request chatter, raw stacks, and ANSI are
not. Measure startup and request latency against [SIDECAR-PERFORMANCE]. If a regression occurs, fix the
single supervisor path; do not restore the independent health or spawn loops.

## 9. Risks and mitigations `[SIDECAR-PLAN-RISKS]`

| Risk | Mitigation |
|---|---|
| Actor refactor changes many call sites at once | Keep the facade signature, land state/driver behind it, then migrate session updates |
| Bootstrap deadlocks by calling the public facade from its own actor | Give the supervisor a private internal connection request path; never re-enter its public command channel |
| Slow `workspace/open` is mistaken for death | Driver owns the 600s deadline; health is idle-only |
| Old response/exit mutates a replacement | Fence every event and completion with generation |
| Random endpoint cleanup deletes another host's resource | Lease ownership + no pre-bind unlink + private runtime directory |
| Job Object conflicts with an enclosing job | Establish before READY, use safe handles, fail visibly, and cover the packaged VSIX environment in CI |
| Development `dotnet run` removal hurts local workflow | Build sidecars through existing make target and launch the resulting apphost/assembly directly |
| Recovery replays stale document text | Snapshot latest version/text from authoritative VFS immediately before bootstrap; generation-gate completion |
| Shutdown races parent watcher or health timer | `Stopping` disables health/admission; normal ack path is the sole clean-exit owner |
| New driver is mistaken for permission to run handlers concurrently | Keep one active request and document ordering; concurrency is a separate future design |

## 10. Definition of done `[SIDECAR-PLAN-DONE]`

The effort is complete only when all nine issue scenarios pass on their required platforms, the
published C# and F# sidecars share the same lifecycle code, restart restores usable semantic state,
normal shutdown is acknowledged without hard kill, hard host death leaves no sidecar or descendant,
and no old spawn/health/retry owner remains. Documentation IDs, issue links, implementation comments,
and test names must provide a direct trace from each issue to its requirement and evidence.

## 11. Detailed implementation checklist `[SIDECAR-PLAN-CHECKLIST]`

This is the execution checklist. Keep it at the bottom of this document; update boxes only when the
item and its required evidence are complete.

### 11.1 Contract and baseline `[SIDECAR-PLAN-CHECKLIST-CONTRACT]`

- [x] Confirm all nine issues are still open and capture their current labels, descriptions, and
      platform scope in the implementation PR/working notes.
- [x] Reconcile [SIDECAR-LIFECYCLE-SPEC.md](../specs/SIDECAR-LIFECYCLE-SPEC.md) with any issue-body
      updates made after 2026-08-03; change the spec before code when behavior differs.
- [x] Verify every heading in the lifecycle spec has one unique hierarchical uppercase ID.
- [x] Confirm [SHARPLSP-ARCHITECTURE-SIDECARS-TIMEOUT], [SCRIPT-ROUTE-HEALTH], [DIST-CLEAN-OUTPUT], and
      [DIST-CI-WIN-TRANSPORT] do not contradict the detailed lifecycle contract.
- [x] Record the current behavior for #150–#154 so the useful partial fixes are preserved during the
      refactor rather than accidentally reverted.
- [ ] Record current spawn count, retry timing, child PID, endpoint, exit status, and shutdown path for
      one healthy C# and one healthy F# session.
- [ ] Record the same evidence for a forced pre-READY failure, runtime transport failure, and host
      hard death on Windows and one Unix platform.
- [ ] Audit existing crates and shared libraries for a maintained safe process/job abstraction that
      satisfies `unsafe_code = "deny"`; document the reuse or rejection decision.
- [x] Confirm the implementation creates no new native parent/child GitHub relationship among
      #150–#172 unless a genuine umbrella tracking issue is created; keep the defects as siblings.

### 11.2 Real-process test harness first `[SIDECAR-PLAN-CHECKLIST-HARNESS]`

- [ ] Add `src/sharplsp/tests/fixtures/SidecarLifecycleFixture` as a separately built executable referencing the
      production shared sidecar host and IPC assemblies.
- [ ] Give the fixture a normal echo/ping handler for healthy request/response verification.
- [ ] Give the fixture a bounded delayed handler to exercise busy-within-budget and deadline-expired
      behavior without mocked clocks or streams.
- [ ] Give the fixture a protocol-fault mode that can emit a wrong response ID and a notification
      before a valid response over the real connection.
- [ ] Give the fixture a malformed-frame/connection-close mode that exercises terminal .NET loop
      errors in a separate process.
- [ ] Give the fixture a handler that starts a real long-lived child helper and reports its PID for
      containment assertions.
- [ ] Make all fixture modes available through normal command arguments or handlers; add no
      `cfg(test)`/test-only behavior to the production supervisor.
- [ ] Add bounded helpers that await READY, process exit, retry timestamp, child disappearance, and
      endpoint rebinding through observable events rather than fixed sleeps.
- [ ] Add issue numbers and spec IDs to scenario names/comments so test failure output is traceable.

### 11.3 Supervisor state and typed errors `[SIDECAR-PLAN-CHECKLIST-SUPERVISOR]`

- [ ] Define `SidecarKind`, `Generation`, `FailureKind`, `SidecarUnavailable`, and `SessionSnapshot`
      with structured fields and no string parsing for control flow.
- [ ] Define every state in [SIDECAR-STATE-MODEL] and make impossible resource combinations
      unrepresentable where practical.
- [ ] Create a bounded supervisor command channel and per-command completion channels.
- [ ] Keep `SidecarManager` as a cloneable facade; remove direct public access to child, transport,
      endpoint, backoff, and health-loop internals.
- [ ] Implement coalesced `EnsureReady` so concurrent callers wait on one generation.
- [ ] Allocate a monotonic generation before every spawn attempt and attach it to every async event.
- [ ] Ignore stale child-exit, driver, timeout, bootstrap, and shutdown events after logging their
      generation mismatch at debug level.
- [ ] Race supervisor commands, child exit, driver events, startup deadlines, stable-ready reset, and
      shutdown using non-blocking Tokio primitives.
- [ ] Implement one failure transition function that records category/context, cleans the generation,
      advances backoff, and completes affected callers.
- [ ] Implement the 1/2/4/8/16/30-second base sequence with ±20% jitter and monotonic retry timestamp.
- [ ] Return `SidecarUnavailable` immediately during backoff; prove requests do not sleep or spawn.
- [ ] Reset backoff only after 60 continuous ready seconds or a new full LSP session.
- [ ] Make restart and shutdown idempotent and ensure C# state cannot mutate F# state.
- [ ] Delete `spawn_retry_after`, the separate crash sleep, and all other superseded retry owners only
      after the actor tests pass.
- [ ] Remove production `unwrap`, `expect`, `panic`, and unstructured expected-error paths introduced
      or touched by the refactor.

### 11.4 Resolution and direct launch `[SIDECAR-PLAN-CHECKLIST-RESOLUTION]`

- [ ] Define `LaunchCandidate` with source, absolute program, arguments, explicit/non-explicit policy,
      and redacted diagnostic rendering.
- [ ] Re-resolve candidates for each generation rather than caching one command at manager creation.
- [ ] Treat an explicit sidecar environment override as authoritative and surface a clear hard error
      when it is missing, the wrong file type, or unspawnable.
- [ ] Resolve Shipwright/bundled and PATH candidates to the exact absolute path passed to spawn.
- [ ] On Windows accept only direct `.exe` candidates or explicit `dotnet.exe <sidecar.dll>` pairs.
- [ ] On Windows reject `.cmd`, `.bat`, PowerShell, and extensionless shims without invoking a shell.
- [ ] On Unix require a regular executable file for direct candidates.
- [ ] Continue through non-explicit candidates only for absence/invalid-format/mechanical spawn
      failures; stop and classify application/listener/handshake failures.
- [ ] Remove the `dotnet run` fallback and launch prebuilt development output directly.
- [ ] Ensure the development/build instructions produce the required apphost or DLL before tests.
- [ ] Add the real Windows PATH test with a bad shim before a valid candidate and assert the valid
      absolute executable starts.

### 11.5 Endpoint leases and READY `[SIDECAR-PLAN-CHECKLIST-STARTUP]`

- [ ] Generate at least 64 unpredictable bits from the OS CSPRNG for every spawn attempt.
- [ ] Include language, host PID, generation, and nonce in a length-bounded platform endpoint.
- [ ] Create/use a validated owner-only Unix runtime directory and keep socket mode `0600`.
- [ ] Keep `PipeOptions.CurrentUserOnly` and a single named-pipe server instance on Windows.
- [ ] Remove blind pre-bind `File.Delete` of Unix socket paths.
- [ ] Track listener ownership and delete only the Unix path actually created by that listener.
- [ ] Allocate a new endpoint after every failed generation; never reuse an endpoint because a
      `SidecarManager` instance survived.
- [ ] Add shared parsing for `--endpoint`, `--parent-pid`, `--generation`, and `--protocol` in C# and
      F# entry points.
- [ ] Initialize logging, containment, parent watcher, and listener before READY.
- [ ] Emit and flush one versioned READY JSON record containing protocol, generation, actual PID, and
      effective bound endpoint.
- [ ] Validate READY schema, protocol, generation, PID, platform endpoint shape, and lease attribution
      in the host.
- [ ] Race READY against exit, stdout EOF, and the 30-second deadline; terminate and reap every losing
      child.
- [ ] Retry only transient post-READY connect errors for at most 2 seconds with bounded delay.
- [ ] Capture/drain stdout and stderr concurrently, cap retained tails at 16KiB each, and prevent pipe
      backpressure from blocking startup.
- [ ] Preserve one sanitized pre-READY `FATAL` stderr line, structured file details, non-zero exit,
      host exit status, and log-directory hint for #150.
- [ ] Exercise listener failure end to end with both published sidecar entry points.
- [ ] Start two hosts on one real workspace on Windows and Unix; assert distinct endpoint/PID and
      successful semantic requests from both.
- [ ] Exercise an overlong Unix requested path through READY and connect to the advertised effective
      path without host-side shortening.

### 11.6 Connection driver and protocol `[SIDECAR-PLAN-CHECKLIST-CONNECTION]`

- [ ] Move `FramedTransport` into a connection driver task as its sole reader and writer.
- [ ] Add a bounded request queue and typed saturation result.
- [ ] Allocate non-zero request IDs monotonically within each generation.
- [ ] Validate request, response, and notification envelope shapes before dispatch.
- [ ] Require every response—including ping/bootstrap/shutdown—to match the active request ID.
- [ ] On missing, duplicate, unknown, or wrong ID, fail the request, stop writes, poison transport, and
      report one protocol failure to the supervisor.
- [ ] Dispatch `id=null/method!=null` sidecar notifications while a request is active and continue
      waiting for the correct response.
- [ ] Preserve one host-to-sidecar active request at a time and document arrival-order semantics.
- [ ] Start response deadlines when the request frame is written, not while queued.
- [ ] Cancel queued/unwritten requests without poisoning the connection.
- [ ] After post-write cancellation, send cancellation when supported and drain/discard the matching
      response before admitting the next request.
- [ ] Poison and restart when a written request cannot be drained within its 120s/600s budget.
- [ ] Distinguish clean EOF between frames from truncated length/payload EOF and classify the latter as
      a protocol failure.
- [ ] Keep the 64MiB frame check before allocation in Rust and .NET.
- [ ] Add a real wrong-ID scenario proving the stale response reaches neither current nor next caller.
- [ ] Add a real notification-before-response scenario proving both are delivered correctly.

### 11.7 Activity-aware health `[SIDECAR-PLAN-CHECKLIST-HEALTH]`

- [ ] Put the idle timer and ping request inside the connection driver; create no second transport
      caller or monitor task.
- [ ] Suppress ping outside `Ready` and while an ordinary request is active within its budget.
- [ ] Send a ping only after 5 idle seconds and require its exact response within 2 seconds.
- [ ] Treat request deadline, ping deadline, EOF, process exit, and protocol fault as distinct failure
      categories routed through the supervisor.
- [ ] Remove the `try_lock`/drop/reacquire health sequence and `start_health_monitor` call sites.
- [ ] Remove eager/lazy manual monitor ordering once the supervisor owns health internally.
- [ ] Prove a delayed request inside its budget survives multiple nominal ping intervals.
- [ ] Prove an idle unresponsive sidecar is terminated/backed off and later recovers.
- [ ] Prove a request beyond its budget poisons the transport and no late response is reused.

### 11.8 Managed message loop and shutdown `[SIDECAR-PLAN-CHECKLIST-DOTNET]`

- [ ] Replace `StartupFailed` with a typed run result covering normal close, acknowledged shutdown,
      startup fatal, transport fatal, and parent death.
- [ ] Make C# and F# entry points map the same run result to the same zero/non-zero semantics.
- [ ] Treat `IOException`, `ObjectDisposedException`, truncated frame, and response write failure as
      terminal message-loop outcomes.
- [ ] Bound recoverable decode/dispatch failures and reset the counter only after a complete valid
      message/response cycle.
- [ ] Emit one structured terminal error and exit; do not retry the same permanently broken stream.
- [ ] Change the shutdown handler to create the `ok` payload without cancelling `_shutdownCts`.
- [ ] Write and flush the correlated shutdown response with a bounded write token.
- [ ] Cancel dispatch and dispose listener/transport only after the response flush succeeds.
- [ ] In the supervisor, stop admission, cancel unwritten commands, send shutdown, and wait 1 second
      for the exact acknowledgement.
- [ ] After acknowledgement, wait within the remaining 5-second graceful budget for zero process exit.
- [ ] On ack/exit timeout, hard-terminate only the current generation's contained process tree and reap
      the direct child.
- [ ] Add a real-process test that observes the matching ack before process exit and asserts the hard
      kill path was not used.
- [ ] Add a persistent broken-stream/decode-storm test that exits within a bound and produces bounded
      logs rather than a hot loop.

### 11.9 Parent death and process-tree cleanup `[SIDECAR-PLAN-CHECKLIST-PROCESS]`

- [ ] Guarantee every production/development launch is direct so Rust child PID equals READY PID.
- [ ] Start parent-death detection before listener bind and fail pre-READY when the parent cannot be
      validated.
- [ ] On Windows open a waitable handle to the exact parent process object and detect death within one
      second even while waiting in accept.
- [ ] On Unix verify direct parent identity and detect reparenting/disappearance within one second.
- [ ] Implement Windows Job Object creation with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` through safe
      managed handles and assign the sidecar before engine descendants can start.
- [ ] Retain the Job Object handle for the full sidecar lifetime and make setup failure visible before
      READY.
- [ ] Launch Unix sidecars as leaders of dedicated process groups without placing the Rust host in the
      group.
- [ ] On planned Unix hard termination, signal only the current generation's group and escalate within
      a bound.
- [ ] On hard parent death, terminate descendants, dispose the listener, and exit without an IPC
      shutdown request.
- [ ] Never enumerate/kill processes by executable name and never target VS Code or an unverified PID.
- [ ] Add a Windows test: fixture spawns child, host dies before IPC connect, sidecar and child vanish,
      and the pipe can be rebound.
- [ ] Add a Windows test: wedged sidecar is hard-terminated and its child/BuildHost does not survive.
- [ ] Add Linux/macOS equivalents asserting no process-group member or owned socket survives.
- [ ] Assert every child is awaited/reaped and every containment/listener handle is disposed on all
      success and failure paths.

### 11.10 Session bootstrap and feature recovery `[SIDECAR-PLAN-CHECKLIST-RECOVERY]`

- [ ] Define the desired per-language session snapshot: workspace/solution/root-file target, analyzer
      configuration, notification subscriptions, and current open-document snapshots.
- [ ] Source open-document URI, language, version, and full text from the authoritative VFS.
- [ ] Replace eager `start_sidecar` orchestration with one supervisor session-update/bootstrap path.
- [ ] Replace lazy project-less startup with that same path and start only the owning language.
- [ ] Start the second language on its first supported document without duplicating bootstrap/health
      tasks.
- [ ] Route `sharplsp/loadSolution` through a desired-target update rather than an independent
      `workspace/open` task.
- [ ] Bootstrap each generation in order: `workspace/open`, analyzer/configuration, stable-URI VFS
      replay, then notification activation.
- [ ] Keep the generation out of `Ready` until every required bootstrap step succeeds.
- [ ] Route bootstrap failure through normal cleanup/backoff; do not expose a half-initialized sidecar.
- [ ] Emit generation-change invalidation to semantic/diagnostic caches before new results publish.
- [ ] Connect `diagnostics/refresh` and project-initialization notifications through the driver without
      giving diagnostics ownership of the transport.
- [ ] Rate-limit user-facing unavailable/recovery notices to one per failure episode.
- [ ] Keep Rust syntax features usable during sidecar backoff and return typed errors for semantic
      requests.
- [ ] Add a C# recovery e2e: edit an open document, kill the sidecar, await recovery, and assert hover
      or diagnostics reflects the latest VFS text.
- [ ] Add the equivalent F# recovery e2e with a real FCS semantic request.
- [ ] Add a mixed-language recovery e2e proving one language restart does not reset or kill the other.

### 11.11 Documentation, CI, and issue closure `[SIDECAR-PLAN-CHECKLIST-RELEASE]`

- [x] Update `SHARPLSP-SPEC.md` lifecycle/IPC summaries to link the detailed spec and accurately state
      one active request plus interleaved notifications.
- [x] Update [DIST-CLEAN-OUTPUT] to sanction one fatal pre-READY diagnostic and no other sidecar stderr
      chatter.
- [x] Update [DIST-CI-WIN-TRANSPORT] to require unpredictable per-spawn endpoints instead of calling
      endpoint names deterministic.
- [x] Update [SCRIPT-ROUTE-HEALTH] to reference activity-aware supervisor health and prohibit a
      duplicate caller-started monitor.
- [ ] Add implementation comments citing the most specific spec IDs at state, timeout, handshake,
      correlation, containment, and shutdown boundaries.
- [ ] Run the focused shared-host real-process lifecycle suite on Windows, Linux, and macOS.
- [ ] Run the Rust e2e lifecycle module with published C# and F# sidecars.
- [ ] Run `make _test-dotnet` and resolve every failure without weakening assertions.
- [ ] Run `make _test-rust` and resolve every failure without filtering lifecycle cases.
- [ ] Run the complete Windows VSIX lifecycle chunk via `make _test-vsix-win`.
- [ ] Run `make lint`; keep Rust `unsafe_code = "deny"`, missing-doc, and structured-error rules green.
- [ ] Inspect one healthy and one forced-failure editor output: no ANSI, raw stack flood, payload text,
      or repeated per-request toast.
- [ ] Verify startup/request/shutdown/backoff timings against [SIDECAR-PERFORMANCE].
- [ ] Verify concurrent hosts have distinct endpoints and that restart uses a new endpoint.
- [ ] Verify normal shutdown received an ack and left no sidecar/descendant/socket/pipe.
- [ ] Verify hard host death left no sidecar/descendant/socket/pipe on every supported platform.
- [ ] Verify both C# and F# recovered latest open-document state after a forced generation change.
- [ ] Search the tree for old independent spawn, health, crash sleep, transport mutex, and shutdown
      owners; remove or document every remaining occurrence.
- [ ] Attach platform-specific passing evidence to #150 and close only when fatal/status/log behavior
      is proven.
- [ ] Attach concurrent-host Windows+Unix evidence to #151 and close only when no collision/steal is
      possible.
- [ ] Attach measured attempt/backoff evidence to #152 and close only when requests cannot create a
      respawn storm.
- [ ] Attach bounded-exit/log evidence to #153 and close only when the hot loop is impossible.
- [ ] Attach overlong-Unix-path evidence to #154 and close only when the effective endpoint connects.
- [ ] Attach Windows parent-death and descendant cleanup evidence to #163 and close only when no
      process-tree member survives.
- [ ] Attach wrong-ID and activity-aware health evidence to #164 and close only when both halves pass.
- [ ] Attach real Windows PATH fallback evidence to #167 and close only when shims cannot block the
      valid candidate.
- [ ] Attach ack-before-exit evidence to #172 and close only when graceful shutdown avoids hard kill.
- [ ] Re-export `docs/bugs/open-issues.csv` after issue states/relationships change so the inventory
      remains synchronized with GitHub.
