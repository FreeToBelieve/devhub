import { constants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UnityPlan, UnityStage } from '@devhub/contracts';

export interface UnityWorkerInput {
  id: string;
  project: string;
  directory: string;
  editor: string;
  platform: 'MACOS' | 'WINDOWS';
  ffmpeg: string | null;
  plan: UnityPlan;
}

export const readyMarker = 'editor-ready.json';
export function testReportNames(stage: UnityStage) {
  return stage === 'EDITMODE' || stage === 'PLAYMODE'
    ? { raw: stage.toLowerCase() + '-results.private.xml', output: stage.toLowerCase() + '-results.xml' } : null;
}
const bridge = 'DevHub.UnityAutomation.EditorBridge';
export function editorArgs(input: UnityWorkerInput, stage: UnityStage, log: string) {
  const args = ['-projectPath', input.project, '-logFile', log, '-devhubRun', input.id,
    '-devhubArtifacts', input.directory, '-devhubStage', stage, '-devhubPlatform', input.platform];
  if (input.plan.scene) args.push('-devhubScene', input.plan.scene);
  const test = testReportNames(stage);
  if (test) {
    args.push('-batchmode', '-runTests', '-testPlatform', stage === 'EDITMODE' ? 'EditMode' : 'PlayMode',
      '-testResults', join(input.directory, test.raw));
    if (stage === 'EDITMODE') args.push('-nographics');
    if (input.plan.testFilter) args.push('-testFilter', input.plan.testFilter);
    return args;
  }
  const method = stage === 'EDITOR' ? 'Ready' : stage === 'BUILD' ? 'Build' : stage === 'GAME_VIEW' ? 'PlayScene' : 'Import';
  if (stage !== 'EDITOR' && stage !== 'GAME_VIEW') args.push('-batchmode', '-nographics');
  if (stage === 'GAME_VIEW') args.push(...captureArgs(input.plan));
  args.push('-executeMethod', bridge + '.' + method);
  return args;
}

export function captureArgs(plan: UnityPlan): string[] {
  const value = plan.capture;
  return value ? ['-devhubWidth', String(value.width), '-devhubHeight', String(value.height), '-devhubSeconds', String(value.seconds)] : [];
}

export async function readRegular(path: string, maximum: number) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.isSymbolicLink() || before.size > BigInt(maximum)) {
    throw new Error('UNITY_ARTIFACT_UNSAFE');
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await file.stat({ bigint: true });
    if (!after.isFile() || after.nlink !== 1n || after.ino !== before.ino || after.dev !== before.dev ||
        after.size > BigInt(maximum)) throw new Error('UNITY_ARTIFACT_UNSAFE');
    const buffer = Buffer.alloc(Number(after.size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export function sanitizeUnityText(text: string, project?: string) {
  let value = project ? text.replaceAll(project, '<worktree>').replaceAll(project.replaceAll('\\', '/'), '<worktree>') : text;
  const home = homedir();
  if (home) value = value.replaceAll(home, '<home>').replaceAll(home.replaceAll('\\', '/'), '<home>');
  value = value.replace(/\b(?:gh[pousr]_[a-z0-9]+|github_pat_[a-z0-9_]+|glpat-[a-z0-9_-]+)\b/gi, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic) +[A-Za-z0-9_.+/=-]+/gi, '[REDACTED]')
    .replace(/https?:\/\/[^/@\s]+@/gi, 'https://[REDACTED]@')
    .replace(/((?:access[ _-]*token|refresh[ _-]*token|private[ _-]*token|client[ _-]*secret|password|authorization|api[ _-]*key|cookie|session[ _-]*id)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
  return value.split(/\r?\n/).map((line) => /\[Licensing::|entitlement|licen[sc](?:e|ing).*(?:account|serial|user|token|signature|access|client id)|(?:user |account )?(?:e-?mail|account id)\s*[:=]/i.test(line)
    ? '[REDACTED Unity licensing details]' : line.slice(0, 4000)).join('\n');
}

export async function saveSanitizedLog(raw: string, directory: string, name: 'editor.log' | 'player.log', project: string) {
  const data = await readRegular(raw, 12 * 1024 ** 2).catch(() => null);
  if (!data) return '';
  const text = sanitizeUnityText(data.toString('utf8'), project);
  await writeFile(join(directory, name), text, { mode: 0o600, flag: 'a' });
  return text;
}
