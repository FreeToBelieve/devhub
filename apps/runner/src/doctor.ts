import { inspectEnvironment } from './platform.js';

const usage = 'Usage: devhub doctor [--json]';

export async function runCli(args: string[]): Promise<number> {
  if (args[0] === '--help' || (args[0] === 'doctor' && args[1] === '--help')) {
    console.log(usage);
    return 0;
  }
  if (!(args[0] === 'doctor' && (args.length === 1 || (args.length === 2 && args[1] === '--json')))) {
    console.error(usage);
    return 2;
  }

  const report = await inspectEnvironment();
  if (args[1] === '--json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const { id, status, detail } of report.checks) {
      console.log(`[${status.toUpperCase()}] ${id}: ${detail}`);
    }
  }
  return report.checks.some((check) => check.status === 'fail') ? 1 : 0;
}
