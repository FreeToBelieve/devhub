import { execFileSync } from 'node:child_process';

interface Entry { pid: number; parent: number; group: number; birth: string }

function processes() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 1024 ** 2, env: { LC_ALL: 'C' },
  });
  return output.trimEnd().split('\n').flatMap((line): Entry[] => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), birth: match[4]!.trim() }] : [];
  });
}

export function watchUnityProcessTree(group: number) {
  const owned = new Map<number, string>();
  let healthy = true;
  function live() {
    try {
      const rows = processes();
      const current = new Set(rows.filter(({ pid, birth }) => owned.get(pid) === birth).map(({ pid }) => pid));
      let remaining = rows;
      while (remaining.length) {
        const after = remaining.filter((row) => {
          if (row.group !== group && !current.has(row.parent) && !current.has(row.pid)) return true;
          current.add(row.pid);
          owned.set(row.pid, row.birth);
          return false;
        });
        if (after.length === remaining.length) break;
        remaining = after;
      }
      return rows.filter(({ pid }) => current.has(pid));
    } catch {
      healthy = false;
      return [];
    }
  }
  live();
  const timer = setInterval(live, 250);
  timer.unref();
  return {
    stop() {
      // Include children discovered after the last tick, and verify PID birth time before signalling.
      for (const entry of live().reverse()) {
        if (entry.pid === group) continue;
        try { process.kill(entry.pid, 'SIGKILL'); } catch { /* absence is checked below */ }
      }
    },
    confirmedGone() { const remaining = live(); return healthy && remaining.length === 0; },
    close() { clearInterval(timer); },
  };
}
