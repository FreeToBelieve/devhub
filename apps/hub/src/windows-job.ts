import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class WindowsJobError extends Error {
  constructor(readonly stage: string) { super('WORKER_JOB_UNAVAILABLE'); }
}

export async function ownWindowsWorker(pid: number) {
  if (process.platform !== 'win32' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    throw new WindowsJobError('UNSUPPORTED_ARCHITECTURE');
  }
  const { default: koffi } = await import('koffi');
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const kernel = koffi.load(join(system, 'kernel32.dll'));
  const createJob = kernel.func('void * __stdcall CreateJobObjectW(void *, void *)');
  const setInformation = kernel.func('int32_t __stdcall SetInformationJobObject(void *, int32_t, void *, uint32_t)');
  const openProcess = kernel.func('void * __stdcall OpenProcess(uint32_t, int32_t, uint32_t)');
  const assign = kernel.func('int32_t __stdcall AssignProcessToJobObject(void *, void *)');
  const query = kernel.func('int32_t __stdcall QueryInformationJobObject(void *, int32_t, void *, uint32_t, void *)');
  const terminate = kernel.func('int32_t __stdcall TerminateJobObject(void *, uint32_t)');
  const close = kernel.func('int32_t __stdcall CloseHandle(void *)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError(void)');
  const failure = (stage: string) => new WindowsJobError(stage + '_' + lastError());

  const basic = koffi.struct({
    perProcessTime: 'int64_t', perJobTime: 'int64_t', flags: 'uint32_t',
    minWorkingSet: 'size_t', maxWorkingSet: 'size_t', processLimit: 'uint32_t',
    affinity: 'size_t', priorityClass: 'uint32_t', schedulingClass: 'uint32_t',
  });
  const extended = koffi.struct({
    basic, ioCounters: koffi.array('uint64_t', 6), processMemory: 'size_t',
    jobMemory: 'size_t', peakProcessMemory: 'size_t', peakJobMemory: 'size_t',
  });
  const accounting = koffi.struct({
    userTime: 'int64_t', kernelTime: 'int64_t', periodUserTime: 'int64_t', periodKernelTime: 'int64_t',
    pageFaults: 'uint32_t', totalProcesses: 'uint32_t', activeProcesses: 'uint32_t', terminatedProcesses: 'uint32_t',
  });
  const limits = Buffer.alloc(koffi.sizeof(extended));
  const active = Buffer.alloc(koffi.sizeof(accounting));
  limits.writeUInt32LE(0x2000, koffi.offsetof(extended, 'basic') + koffi.offsetof(basic, 'flags')); // Kill on job close.
  const activeOffset = koffi.offsetof(accounting, 'activeProcesses');

  const job = createJob(null, null);
  if (!job) throw failure('CREATE_JOB');
  try {
    if (!setInformation(job, 9, limits, limits.length)) throw failure('SET_JOB_LIMITS');
    const worker = openProcess(0x1101, 0, pid); // SET_QUOTA | TERMINATE | QUERY_LIMITED_INFORMATION.
    if (!worker) throw failure('OPEN_WORKER');
    try {
      if (!assign(job, worker)) throw failure('ASSIGN_WORKER');
    } finally {
      close(worker);
    }
  } catch (error) {
    close(job);
    throw error;
  }

  function activeCount() {
    if (!query(job, 1, active, active.length, null)) return undefined;
    return active.readUInt32LE(activeOffset);
  }
  let cleanup: Promise<boolean> | undefined;
  return {
    cleanUp() {
      cleanup ??= (async () => {
        try {
          if (activeCount() === 0) return true;
          if (!terminate(job, 130)) return false;
          const deadline = performance.now() + 4000;
          while (performance.now() < deadline) {
            if (activeCount() === 0) return true;
            await delay(50);
          }
          return false;
        } finally {
          close(job);
        }
      })();
      return cleanup;
    },
  };
}
