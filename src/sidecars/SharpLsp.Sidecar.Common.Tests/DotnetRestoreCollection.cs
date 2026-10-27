// xUnit requires a collection-definition class to be public so the runner can
// discover it; CA1515 (make internal) does not apply. Matches the suppression
// convention used across the sidecar test suites.
#pragma warning disable CA1515 // Types can be internal

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Serialises the tests that mutate the process environment's MSBuild registration
/// variables or bound a real <c>dotnet</c> restore. Run beside the other restore
/// tests, the bogus registration would leak into their children; run beside any
/// other test, the first-run SDK cost and the killed process tree would race the
/// shared machine. Implements [DIAG-RESTORE].
/// </summary>
[CollectionDefinition("DotnetRestore", DisableParallelization = true)]
public sealed class DotnetRestoreDefinition;
