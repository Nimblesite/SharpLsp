# Sidecar Implementation Plan

## Context

Forge is a Rust LSP host that needs .NET sidecar processes for semantic intelligence. The Rust tier handles syntax features (tree-sitter). Sidecars handle semantic features (completions, hover, diagnostics, etc.) via Roslyn (C#) and FSharp.Compiler.Service (F#). This plan implements the sidecar infrastructure and initial workspace loading.

## Scope

Implement 8 TODO items:
- C# sidecar: Roslyn hosting, MSBuildWorkspace, design-time builds, SDK-style projects
- F# sidecar: FCS hosting, Ionide.ProjInfo project cracking, project loading

## Directory Structure

```
sidecars/
  Forge.Sidecars.sln
  Forge.Sidecar.Common/           # Shared IPC library
    Forge.Sidecar.Common.csproj
    Ipc/
      FramedTransport.cs           # 4-byte LE length-prefix framing
      IpcConnection.cs             # Unix socket / named pipe abstraction
      MessageRouter.cs             # Request/response dispatch with IDs
    Messages/
      Envelope.cs                  # {Id, Method, Payload, Error}
    SidecarHost.cs                 # Base class: listen, dispatch, health, shutdown
  Forge.Sidecar.CSharp/
    Forge.Sidecar.CSharp.csproj
    Program.cs                     # Entry: MSBuildLocator, start host
    CSharpSidecar.cs               # Registers C# handlers
    Workspace/
      WorkspaceManager.cs          # MSBuildWorkspace lifecycle
      SolutionLoader.cs            # Solution/project discovery
  Forge.Sidecar.FSharp/
    Forge.Sidecar.FSharp.csproj
    Program.cs                     # Entry: start host
    FSharpSidecar.cs               # Registers F# handlers
    Workspace/
      ProjectCracker.cs            # Ionide.ProjInfo integration
      CheckerManager.cs            # FSharpChecker lifecycle
src/sidecar/
  mod.rs                           # Module declarations
  protocol.rs                      # MessagePack message types
  transport.rs                     # Framed async read/write
  connection.rs                    # Platform-specific socket/pipe
  manager.rs                       # Spawn, health, crash recovery
```

## IPC Protocol

- **Transport**: MessagePack over Unix domain sockets (macOS/Linux) / named pipes (Windows)
- **Framing**: 4-byte LE length prefix + MessagePack payload
- **Envelope**: `{ id: Option<u32>, method: Option<String>, payload: bytes, error: Option<Error> }`
- **Socket path**: `/tmp/forge-{hash8}.sock` (short to avoid 108-char Unix limit)
- **Startup handshake**: Sidecar prints `READY:{socket_path}` to stdout once listening
- **Health**: Rust sends `ping` every 5s, 2s timeout
- **Crash recovery**: Exponential backoff (1s, 2s, 4s, max 30s)
- **Lazy startup**: Sidecars spawn on first semantic request for that language

## Implementation Phases

### Phase A: Shared .NET IPC Library + Rust IPC Module

1. Create `sidecars/Forge.Sidecars.sln` and `Forge.Sidecar.Common` project (.NET 9.0)
2. Implement `FramedTransport.cs` — async read/write with 4-byte LE framing
3. Implement `IpcConnection.cs` — platform factory for Unix socket / named pipe streams
4. Implement `Envelope.cs` — MessagePack contract types (AOT-compatible)
5. Implement `MessageRouter.cs` — dispatch requests by method name
6. Implement `SidecarHost.cs` — base class: parse args, listen, dispatch, ping, shutdown
7. Add `rmp-serde`, `tokio`, `interprocess` to `Cargo.toml`
8. Implement `src/sidecar/protocol.rs` — Rust message types with serde
9. Implement `src/sidecar/transport.rs` — framed async transport
10. Implement `src/sidecar/connection.rs` — platform-specific connect
11. Implement `src/sidecar/manager.rs` — spawn, health monitoring, crash recovery, request forwarding

### Phase B: F# Sidecar

1. Create `Forge.Sidecar.FSharp` project with FCS + Ionide.ProjInfo dependencies
2. `Program.cs` — parse args, run
3. `FSharpSidecar.cs` — register handlers
4. `CheckerManager.cs` — `FSharpChecker.Create()`, parse/check operations
5. `ProjectCracker.cs` — `Ionide.ProjInfo` to crack .fsproj into `FSharpProjectOptions`

### Phase C: C# Sidecar

1. Create `Forge.Sidecar.CSharp` project with Roslyn + MSBuild dependencies
2. `Program.cs` — `MSBuildLocator.RegisterDefaults()`, parse args, run
3. `CSharpSidecar.cs` — register handlers: ping, workspace/open, workspace/status
4. `WorkspaceManager.cs` — `MSBuildWorkspace.Create()` with design-time build properties:
   - `DesignTimeBuild=true`, `BuildingInsideVisualStudio=true`, `SkipCompilerExecution=true`
5. `SolutionLoader.cs` — auto-detect .sln, fall back to .csproj discovery

### Phase D: Integration

1. Update `src/main.rs` — create tokio runtime, init `SidecarManager`, route semantic requests
2. Update `src/config.rs` — add `sidecar_path` to CSharpConfig/FSharpConfig
3. Update `build_capabilities()` — advertise semantic features when sidecars enabled
4. Update CI — add .NET 9.0 SDK setup, dotnet build step, NuGet caching

## Key Design Decisions

- **Sync/async bridge**: Keep main LSP loop synchronous (lsp-server pattern). Create a `tokio::Runtime` for sidecar IPC. Use `runtime.block_on()` for sync-to-async bridging.
- **Binary discovery**: Dev mode uses `dotnet run --project`. Prod uses co-located binaries. Config override via `sidecar_path`.
- **Crash isolation**: All sidecar communication wrapped in `Result`. Sidecar crash returns LSP error response, never panics the host.

## Files Modified

- `Cargo.toml` — add rmp-serde, tokio, interprocess
- `src/main.rs` — tokio runtime, SidecarManager init, semantic routing
- `src/config.rs` — sidecar_path fields
- `.github/workflows/ci.yml` — .NET 9.0 SDK, dotnet build
- `TODO.md` — mark items complete

## Files Created

- All files under `sidecars/` (~14 files)
- All files under `src/sidecar/` (5 files)
- Test fixtures: `tests/fixtures/dotnet-workspace/` with .sln/.csproj/.fsproj

## Verification

1. `cargo check` — Rust compiles with new sidecar module
2. `cargo clippy` — passes at deny level
3. `dotnet build sidecars/Forge.Sidecars.sln` — .NET projects compile
4. `cargo test` — existing e2e tests still pass (sidecars are lazy, won't interfere)
5. Manual: start forge-lsp with a .NET workspace, verify sidecar spawns and loads solution
