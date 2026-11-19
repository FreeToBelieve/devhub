param([int] $WorkerPid, [int] $SupervisorPid, [string] $Directory)
$ErrorActionPreference = 'Stop'
$evidence = [IO.Path]::Combine($Directory, 'evidence')
$stop = [IO.Path]::Combine($Directory, 'stop')
[IO.File]::WriteAllText($evidence, 'STARTING')
try {
    $supervisor = [System.Diagnostics.Process]::GetProcessById($SupervisorPid)
    $null = $supervisor.Handle
} catch {
    [IO.File]::WriteAllText($evidence, 'OPEN_PARENT_0')
    exit 1
}

try { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DevHubJob {
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimit {
        public long PerProcessTime;
        public long PerJobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimit {
        public BasicLimit Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr handle, int kind,
        ref ExtendedLimit value, int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr handle, int kind,
        out Accounting info, int size, IntPtr returnedSize);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr Own(int pid) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException("CREATE_JOB_" + Marshal.GetLastWin32Error());
        try {
            ExtendedLimit limits = new ExtendedLimit();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Breakaway stays disabled.
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimit))))
                throw new InvalidOperationException("SET_JOB_LIMITS_" + Marshal.GetLastWin32Error());
            IntPtr process = OpenProcess(0x1101, false, pid);
            if (process == IntPtr.Zero) throw new InvalidOperationException("OPEN_WORKER_" + Marshal.GetLastWin32Error());
            try {
                if (!AssignProcessToJobObject(job, process)) throw new InvalidOperationException("ASSIGN_WORKER_" + Marshal.GetLastWin32Error());
            } finally { CloseHandle(process); }
            return job;
        } catch { CloseHandle(job); throw; }
    }

    public static bool Clean(IntPtr job) {
        Accounting info;
        if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return false;
        if (info.ActiveProcesses == 0) return true;
        if (!TerminateJobObject(job, 130)) return false;
        for (int attempt = 0; attempt < 40; ++attempt) {
            if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return false;
            if (info.ActiveProcesses == 0) return true;
            System.Threading.Thread.Sleep(100);
        }
        return false;
    }
    public static void Close(IntPtr job) { CloseHandle(job); }
}
'@
} catch {
    [IO.File]::WriteAllText($evidence, 'COMPILE_JOB_0')
    exit 1
}

[IO.File]::WriteAllText($evidence, 'COMPILED')
try {
    $job = [DevHubJob]::Own($WorkerPid)
} catch {
    $stage = $_.Exception.GetBaseException().Message
    if ($stage -notmatch '^(CREATE_JOB|SET_JOB_LIMITS|OPEN_WORKER|ASSIGN_WORKER)_\d{1,10}$') { $stage = 'CONTAINMENT_FAILED' }
    [IO.File]::WriteAllText($evidence, $stage)
    exit 1
}
try {
    [IO.File]::WriteAllText($evidence, 'READY')
    while (-not $supervisor.HasExited -and -not [IO.File]::Exists($stop)) {
        Start-Sleep -Milliseconds 100
    }
    if (-not [DevHubJob]::Clean($job)) { exit 1 }
    [IO.File]::WriteAllText($evidence, 'CLEAN')
} finally {
    [DevHubJob]::Close($job)
    $supervisor.Dispose()
}
