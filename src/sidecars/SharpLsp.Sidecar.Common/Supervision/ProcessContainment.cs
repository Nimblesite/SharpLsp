using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;
using ContainmentResult = Outcome.Result<
    SharpLsp.Sidecar.Common.Supervision.ProcessContainment,
    string
>;

namespace SharpLsp.Sidecar.Common.Supervision;

/// <summary>
/// Descendant containment for a sidecar. On Windows the sidecar joins a Job
/// Object with <c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c>; every process it
/// later starts (Roslyn BuildHost, MSBuild workers) inherits the job, and when
/// the last handle closes — the sidecar exiting, crashing or being hard-killed
/// — the kernel kills them all. On Unix containment belongs to the host, which
/// is to launch the sidecar as a dedicated process-group leader; that half is
/// not built yet (SIDECAR-LIFECYCLE-PLAN, [SIDECAR-PLAN-CHECKLIST-PROCESS]), so
/// this is a no-op there and Unix descendants can still outlive a hard kill.
/// Implements [SIDECAR-PROCESS-TREE] (GitHub #163).
/// </summary>
public sealed class ProcessContainment : IDisposable
{
    private readonly IDisposable? _job;

    private ProcessContainment(IDisposable? job)
    {
        _job = job;
    }

    /// <summary>Whether a Job Object backs this containment.</summary>
    public bool IsJobBacked => _job is not null;

    /// <summary>
    /// Contain the current process. The returned value must live as long as
    /// the process: disposing it closes the job and kills every member,
    /// including this process.
    /// </summary>
    public static ContainmentResult ContainCurrentProcess()
    {
        if (!OperatingSystem.IsWindows())
        {
            return Owned(null);
        }

        using var self = Process.GetCurrentProcess();
        return Contain(self.SafeHandle);
    }

    /// <summary>
    /// Place <paramref name="process" /> in a new kill-on-close Job Object.
    /// Disposing the result terminates the process and all its descendants.
    /// </summary>
    [SupportedOSPlatform("windows")]
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage(
        Justification = NativeMethods.WindowsOnlyCoverage
    )]
    internal static ContainmentResult Contain(SafeProcessHandle process)
    {
        var job = NativeMethods.CreateJobObject(0, null);
        return job.IsInvalid ? Fail(job, "CreateJobObject")
            : !SetKillOnClose(job) ? Fail(job, "SetInformationJobObject")
            : !NativeMethods.AssignProcessToJobObject(job, process)
                ? Fail(job, "AssignProcessToJobObject")
            : Owned(job);
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Containment ownership transfers to the caller via Result"
    )]
    private static ContainmentResult Owned(IDisposable? job)
    {
        return new ContainmentResult.Ok<ProcessContainment, string>(new ProcessContainment(job));
    }

    /// <summary>Close the job, terminating every process still in it.</summary>
    public void Dispose()
    {
        _job?.Dispose();
    }

    [SupportedOSPlatform("windows")]
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage(
        Justification = NativeMethods.WindowsOnlyCoverage
    )]
    private static bool SetKillOnClose(SafeJobHandle job)
    {
        var info = new JobExtendedLimitInformation
        {
            BasicLimitInformation = new JobBasicLimitInformation
            {
                LimitFlags = NativeMethods.JobObjectLimitKillOnJobClose,
            },
        };
        var length = (uint)Marshal.SizeOf<JobExtendedLimitInformation>();
        return NativeMethods.SetInformationJobObject(
            job,
            NativeMethods.JobObjectExtendedLimitInformation,
            in info,
            length
        );
    }

    /// Capture the Win32 error before disposing the handle, which may reset it.
    [SupportedOSPlatform("windows")]
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage(
        Justification = NativeMethods.WindowsOnlyCoverage
    )]
    private static ContainmentResult Fail(SafeJobHandle job, string call)
    {
        var error = new Win32Exception(Marshal.GetLastPInvokeError()).Message;
        job.Dispose();
        return ContainmentResult.Failure($"{call} failed: {error}");
    }
}
