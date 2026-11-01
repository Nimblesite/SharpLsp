using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Native test fixture: a real Windows source open waits for this oplock's release.
// [LSP-PULL-CONCURRENCY]. No administrator rights or symlinks are needed.
// https://learn.microsoft.com/windows/win32/api/winioctl/ni-winioctl-fsctl_request_oplock_level_1
public sealed class SourceOplock : IDisposable
{
    private SafeFileHandle file;
    private EventWaitHandle broken = new EventWaitHandle(false, EventResetMode.ManualReset);
    private IntPtr overlapped;
    private bool pending;

    [StructLayout(LayoutKind.Sequential)]
    private struct Overlapped
    {
        internal IntPtr Internal;
        internal IntPtr InternalHigh;
        internal uint Offset;
        internal uint OffsetHigh;
        internal IntPtr Event;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string path,
        uint access,
        uint share,
        IntPtr security,
        uint creation,
        uint flags,
        IntPtr template
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(
        SafeFileHandle handle,
        uint code,
        IntPtr input,
        uint inputSize,
        IntPtr output,
        uint outputSize,
        out uint returned,
        IntPtr operation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CancelIoEx(SafeFileHandle handle, IntPtr operation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetOverlappedResult(
        SafeFileHandle handle,
        IntPtr operation,
        out uint transferred,
        [MarshalAs(UnmanagedType.Bool)] bool wait
    );

    public static SourceOplock Acquire(string path)
    {
        var source = new SourceOplock();
        try
        {
            source.Request(path);
            return source;
        }
        catch
        {
            source.Dispose();
            throw;
        }
    }

    private void Request(string path)
    {
        // Match read-only source readers' sharing mode; write access fails before the oplock breaks.
        file = CreateFileW(path, 0x80000000, 7, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero);
        if (file.IsInvalid)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        AllocateOperation();
        uint returned;
        var completed = DeviceIoControl(
            file,
            0x00090000,
            IntPtr.Zero,
            0,
            IntPtr.Zero,
            0,
            out returned,
            overlapped
        );
        var error = Marshal.GetLastWin32Error();
        if (completed || error != 997)
            throw new Win32Exception(error);
        pending = true;
    }

    private void AllocateOperation()
    {
        // The kernel retains this address until completion; a movable managed ref is invalid.
        overlapped = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Overlapped)));
        var operation = new Overlapped { Event = broken.SafeWaitHandle.DangerousGetHandle() };
        Marshal.StructureToPtr(operation, overlapped, false);
    }

    public void WaitForReader()
    {
        if (!broken.WaitOne(20000))
            throw new TimeoutException("Native source reader did not arrive");
        uint transferred;
        if (!GetOverlappedResult(file, overlapped, out transferred, false))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        pending = false;
    }

    public void Dispose()
    {
        if (pending)
        {
            // Wait for cancellation completion before releasing native operation storage.
            CancelIoEx(file, overlapped);
            uint transferred;
            GetOverlappedResult(file, overlapped, out transferred, true);
            pending = false;
        }
        if (file != null)
            file.Dispose();
        if (overlapped != IntPtr.Zero)
            Marshal.FreeHGlobal(overlapped);
        overlapped = IntPtr.Zero;
        if (broken != null)
            broken.Dispose();
        broken = null;
    }
}
