using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace SharpLsp.Sidecar.Common.Supervision;

/// <summary>An owned Win32 Job Object handle; closing it kills a kill-on-close job.</summary>
[SupportedOSPlatform("windows")]
[ExcludeFromCodeCoverage(Justification = NativeMethods.WindowsOnlyCoverage)]
internal sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    /// <summary>Required by the interop marshaller.</summary>
    public SafeJobHandle()
        : base(ownsHandle: true) { }

    protected override bool ReleaseHandle()
    {
        return NativeMethods.CloseHandle(handle);
    }
}

/// <summary>
/// <c>JOBOBJECT_BASIC_LIMIT_INFORMATION</c>. Sequential layout reproduces the
/// native padding on both 32- and 64-bit.
/// </summary>
[StructLayout(LayoutKind.Sequential)]
internal struct JobBasicLimitInformation
{
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public nuint MinimumWorkingSetSize;
    public nuint MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public nuint Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
}

/// <summary><c>IO_COUNTERS</c>.</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct JobIoCounters
{
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
}

/// <summary><c>JOBOBJECT_EXTENDED_LIMIT_INFORMATION</c>.</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct JobExtendedLimitInformation
{
    public JobBasicLimitInformation BasicLimitInformation;
    public JobIoCounters IoInfo;
    public nuint ProcessMemoryLimit;
    public nuint JobMemoryLimit;
    public nuint PeakProcessMemoryUsed;
    public nuint PeakJobMemoryUsed;
}

/// <summary>The kernel32 Job Object entry points [SIDECAR-PROCESS-TREE] needs.</summary>
[SupportedOSPlatform("windows")]
internal static partial class NativeMethods
{
    /// <summary>
    /// Why the Win32-only paths are excluded from the coverage gate: it is measured on
    /// Linux, where they cannot run; the Windows CI job runs their tests.
    /// </summary>
    internal const string WindowsOnlyCoverage =
        "Win32 Job Object path; the coverage gate runs on Linux, the Windows job runs its tests";

    /// <summary><c>JOBOBJECTINFOCLASS.JobObjectExtendedLimitInformation</c>.</summary>
    internal const int JobObjectExtendedLimitInformation = 9;

    /// <summary><c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c>.</summary>
    internal const uint JobObjectLimitKillOnJobClose = 0x2000;

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [LibraryImport(
        "kernel32.dll",
        EntryPoint = "CreateJobObjectW",
        SetLastError = true,
        StringMarshalling = StringMarshalling.Utf16
    )]
    internal static partial SafeJobHandle CreateJobObject(nint attributes, string? name);

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetInformationJobObject(
        SafeJobHandle job,
        int infoClass,
        in JobExtendedLimitInformation info,
        uint infoLength
    );

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool AssignProcessToJobObject(
        SafeJobHandle job,
        SafeProcessHandle process
    );

    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool CloseHandle(nint handle);
}
