// xUnit requires a collection-definition class to be public so the runner can
// discover it; CA1515 (make internal) does not apply. Matches the suppression
// convention used across the sidecar test suites.
#pragma warning disable CA1515 // Types can be internal

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Serialises every test that mutates the process-global Serilog
/// <c>Log.Logger</c> singleton so they never run concurrently.
///
/// <see cref="MessageRouterTests" /> installs a capturing sink to assert routing
/// is logged (#78); <see cref="SidecarHostEndToEndTests" /> drives
/// <c>SidecarHost</c>, which calls <c>SidecarLog.Initialize</c> (swaps
/// <c>Log.Logger</c> to a rolling-file logger) and <c>SidecarLog.Shutdown</c>
/// (<c>Log.CloseAndFlush</c> → <c>SilentLogger</c>). Run in parallel the host's
/// logger swap races the router test's sink window, so the router's log lands in
/// the wrong logger and the assertion misses it — deterministically green on
/// Windows, flaky-red on the Linux CI runner. Sharing one non-parallel
/// collection closes the race without weakening any assertion.
/// </summary>
[CollectionDefinition("SerilogGlobalLogger", DisableParallelization = true)]
public sealed class SerilogGlobalLoggerDefinition;
