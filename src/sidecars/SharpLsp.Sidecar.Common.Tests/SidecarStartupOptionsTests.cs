namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// The sidecar command line: <c>&lt;endpoint&gt; [--parent-pid &lt;pid&gt;]</c>,
/// parsed strictly. Implements the parent-PID half of [SIDECAR-STARTUP-SPAWN] (GitHub #163).
/// </summary>
public sealed class SidecarStartupOptionsTests
{
    private const string Endpoint = @"\\.\pipe\sharplsp-csharp-test";

    private static SidecarStartupOptions Parsed(params string[] args)
    {
        var result = SidecarStartupOptions.Parse(args);
        Assert.False(result.IsError, result.Match(_ => string.Empty, e => e));
        return result.Match(o => o, _ => throw new InvalidOperationException());
    }

    private static string Rejected(params string[] args)
    {
        var result = SidecarStartupOptions.Parse(args);
        Assert.True(result.IsError, $"must reject: {string.Join(' ', args)}");
        return result.Match(_ => string.Empty, e => e);
    }

    [Fact]
    public void A_host_launch_carries_the_endpoint_and_parent_pid()
    {
        var supervised = Parsed(Endpoint, "--parent-pid", "4242");
        Assert.Equal(Endpoint, supervised.Endpoint);
        Assert.Equal(4242, supervised.ParentPid);

        // The legacy endpoint-only launch still parses, unsupervised.
        var bare = Parsed("/tmp/sharplsp-csharp.sock");
        Assert.Equal("/tmp/sharplsp-csharp.sock", bare.Endpoint);
        Assert.Null(bare.ParentPid);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-7")]
    [InlineData("+7")]
    [InlineData("abc")]
    [InlineData("99999999999")]
    [InlineData("")]
    public void A_parent_pid_that_is_not_a_positive_integer_is_rejected(string pid)
    {
        var error = Rejected(Endpoint, "--parent-pid", pid);
        Assert.Contains("--parent-pid must be a positive integer", error, StringComparison.Ordinal);
        Assert.Contains(SidecarStartupOptions.Usage, error, StringComparison.Ordinal);
    }

    [Fact]
    public void Any_other_shape_is_a_usage_error_not_an_ignored_flag()
    {
        Assert.Contains(SidecarStartupOptions.Usage, Rejected(), StringComparison.Ordinal);
        Assert.Contains(
            "invalid arguments",
            Rejected("--parent-pid", "12"),
            StringComparison.Ordinal
        );
        Assert.Contains(
            "invalid arguments",
            Rejected(Endpoint, "--parent-pid"),
            StringComparison.Ordinal
        );
        Assert.Contains(
            "invalid arguments",
            Rejected(Endpoint, "--verbose", "1"),
            StringComparison.Ordinal
        );
        Assert.Contains(
            "invalid arguments",
            Rejected(Endpoint, "--parent-pid", "12", "extra"),
            StringComparison.Ordinal
        );
    }
}
