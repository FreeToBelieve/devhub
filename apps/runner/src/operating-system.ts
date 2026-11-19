import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DoctorCheck } from '@devhub/contracts';
import { windowsPowerShellPath } from '@devhub/security';

type SupportedPlatform = 'darwin' | 'win32';
const execFileAsync = promisify(execFile);
const windowsMinimum = 22000;
const macMinimum = { major: 13, minor: 5 };
const supportedSystems = 'Windows 11 client (build 22000+) or macOS 13.5+, on x64 or arm64.';

export async function readOperatingSystem(platform: SupportedPlatform): Promise<{
  version: string;
  windowsProductType?: number;
}> {
  const options = { timeout: 8000, maxBuffer: 16 * 1024, windowsHide: true };
  if (platform === 'darwin') {
    const { stdout } = await execFileAsync('/usr/bin/sw_vers', ['-productVersion'], options);
    return { version: stdout.trim() };
  }

  const { stdout } = await execFileAsync(windowsPowerShellPath(), [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop | Select-Object Version,ProductType | ConvertTo-Json -Compress',
  ], options);
  const result: unknown = JSON.parse(stdout);
  if (!result || typeof result !== 'object' || !('Version' in result) || typeof result.Version !== 'string' ||
      !('ProductType' in result) || typeof result.ProductType !== 'number') {
    throw new Error('Windows returned invalid OS version information.');
  }
  return { version: result.Version, windowsProductType: result.ProductType };
}

export async function checkOperatingSystem(
  platform: string,
  arch: string,
  readVersion: typeof readOperatingSystem,
): Promise<DoctorCheck> {
  const check = (status: 'pass' | 'fail', detail: string): DoctorCheck => ({
    id: 'platform',
    status,
    detail: `${detail} Supported: ${supportedSystems}`,
  });
  if ((platform !== 'darwin' && platform !== 'win32') || (arch !== 'x64' && arch !== 'arm64')) {
    return check('fail', `${platform}/${arch} is outside the supported platform or architecture range.`);
  }

  try {
    const { version, windowsProductType } = await readVersion(platform);
    if (platform === 'win32') {
      const build = Number(/^10\.0\.(\d+)(?:\.\d+)?$/.exec(version)?.[1]);
      if (!Number.isSafeInteger(build) || ![1, 2, 3].includes(windowsProductType ?? 0)) {
        throw new Error('Invalid Windows version or product type.');
      }
      if (windowsProductType !== 1) return check('fail', `Windows Server (build ${build}, ${arch}).`);
      return build >= windowsMinimum
        ? check('pass', `Windows 11 client (build ${build}, ${arch}).`)
        : check('fail', `Windows client build ${build} (${arch}) is below the Windows 11 minimum.`);
    }

    const mac = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
    if (!mac) throw new Error('Invalid macOS version.');
    const major = Number(mac[1]);
    const minor = Number(mac[2]);
    const supported = major > macMinimum.major || (major === macMinimum.major && minor >= macMinimum.minor);
    return check(supported ? 'pass' : 'fail', `macOS ${version} (${arch}).`);
  } catch {
    return check('fail', `Could not determine the OS version for ${platform}/${arch}.`);
  }
}
