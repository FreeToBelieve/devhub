import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { UnityReport, UnityStage } from '@devhub/contracts';
import {
  buildInventory, directoryBytes, editorArgs, finalizeUnityCapture, playerArgs, playerExecutable, readRegular, readUnityTests,
  readyMarker, runByteLimit, saveSanitizedLog, storageByteLimit,
  testReportNames, unityDiagnostics,
} from '@devhub/unity-adapter';
import type { UnityWorkerInput } from '@devhub/unity-adapter';
import { startBatchMode, startEditor, waitForEditorReady } from './process.js';

const controller = new AbortController();
const send = (message: unknown) => { if (process.connected) process.send?.(message); };
const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 1000);
let spawned = false;
process.on('disconnect', () => controller.abort());
send({ type: 'ready' });

async function stage(input: UnityWorkerInput, phase: UnityStage, signal: AbortSignal) {
  signal.throwIfAborted();
  const startedAt = Date.now();
  const raw = join(input.directory, phase.toLowerCase() + '.raw');
  const test = testReportNames(phase);
  const player = phase === 'PLAYER';
  const gameView = phase === 'GAME_VIEW';
  const sceneStage = player || gameView;
  const build = phase === 'BUILD';
  const executable = player ? await playerExecutable(input) : input.editor;
  const args = player ? playerArgs(input, raw) : editorArgs(input, phase, raw);
  const process = (phase === 'EDITOR' || sceneStage ? startEditor : startBatchMode)(executable, args, input.project);
  const identity = process.inspectEditorProcess();
  spawned ||= identity.pid !== null;
  send({ type: 'process', phase, ...identity });
  const exited = process.waitForEditorExit();
  const marker = join(input.directory, player ? 'player-ready.json' : gameView ? 'game-view-ready.json' :
    build ? 'build-native.json' : readyMarker);
  const local = AbortSignal.any([signal, AbortSignal.timeout(input.plan.timeoutSeconds * 1000)]);
  const cancel = () => process.stopEditor();
  local.addEventListener('abort', cancel, { once: true });
  let checkingQuota = false;
  const quotas = setInterval(() => {
    if (checkingQuota) return;
    checkingQuota = true;
    void Promise.all([
      directoryBytes(input.directory, runByteLimit),
      directoryBytes(join(input.directory, '..'), storageByteLimit, true),
    ]).catch((error: unknown) => {
      const code = error instanceof Error && error.message === 'UNITY_ARTIFACT_LIMIT'
        ? 'UNITY_ARTIFACT_LIMIT' : 'UNITY_ARTIFACT_UNSAFE';
      controller.abort(code);
    }).finally(() => { checkingQuota = false; });
  }, 3000);
  try {
    const markerReceipt = test ? null : await waitForEditorReady(() => readRegular(marker, 64_000).then((data) => {
      const json = JSON.parse(data.toString()) as Record<string, unknown>;
      return json.run === input.id && (sceneStage || json.version === input.editorVersion) ? json : null;
    }).catch(() => null), exited, local);
    const bounded = delay(input.plan.timeoutSeconds * 1000 + 1500 -
      Math.min(Date.now() - startedAt, input.plan.timeoutSeconds * 1000), null, { ref: false });
    const result = await Promise.race([exited, bounded]);
    const log = await saveSanitizedLog(raw, input.directory, player ? 'player.log' : 'editor.log', input.project);
    await rm(raw, { force: true });
    const diagnostics = unityDiagnostics(log);
    const report: UnityReport = { stage: phase, startedAt, finishedAt: Date.now(), code: null,
      exitCode: result?.code ?? null, diagnostics };
    const tests = test ? await readUnityTests(join(input.directory, test.raw), input.project).catch(() => null) : null;
    if (test && tests) {
      report.tests = tests.tests;
      await writeFile(join(input.directory, test.output), tests.text, { mode: 0o600, flag: 'wx' });
    }
    if (test) await rm(join(input.directory, test.raw), { force: true });
    if (sceneStage && markerReceipt) {
      report.scene = { path: markerReceipt.scene === input.plan.scene ? input.plan.scene! : '',
        objectPresent: markerReceipt.objectPresent === true, skillTriggered: markerReceipt.skillTriggered === true,
        frames: typeof markerReceipt.frames === 'number' && Number.isSafeInteger(markerReceipt.frames) ? markerReceipt.frames : 0 };
    }
    const target = input.platform === 'MACOS' ? 'StandaloneOSX' : 'StandaloneWindows64';
    if (build && markerReceipt?.completed === true && markerReceipt.target === target && markerReceipt.scene === input.plan.scene) {
      try { report.build = { target, ...await buildInventory(input.directory) }; }
      catch { report.code = 'UNITY_BUILD_OUTPUT_INVALID'; }
    }
    const actualVersion = /Unity Editor version:\s+([^\s]+)/.exec(log)?.[1];
    if (local.aborted) {
      const reason: unknown = signal.reason;
      report.code = reason === 'UNITY_ARTIFACT_LIMIT' || reason === 'UNITY_ARTIFACT_UNSAFE' ? reason :
        signal.aborted ? 'UNITY_CANCELLED' : 'UNITY_TIMEOUT';
    }
    else if (actualVersion && actualVersion !== input.editorVersion) report.code = 'UNITY_EDITOR_VERSION_MISMATCH';
    else if (diagnostics.some(({ severity, code }) => severity === 'error' && code.startsWith('CS'))) report.code = 'UNITY_COMPILATION_FAILED';
    else if (diagnostics.some(({ code }) => code === 'UNITY_LICENSE_UNAVAILABLE')) report.code = 'UNITY_LICENSE_UNAVAILABLE';
    else if (test && !tests) report.code = 'UNITY_TEST_REPORT_MISSING';
    else if (test && tests?.tests.total === 0) report.code = 'UNITY_TESTS_EMPTY';
    else if (tests?.tests.failed) report.code = 'UNITY_TESTS_FAILED';
    else if (result?.diagnostic) report.code = result.diagnostic;
    else if (build && !report.build) report.code ??= 'UNITY_BUILD_FAILED';
    else if (sceneStage && (!report.scene?.path || !report.scene.objectPresent || !report.scene.skillTriggered ||
      report.scene.frames < 1 || result?.code !== 0)) report.code = 'UNITY_SCENE_ASSERTION_FAILED';
    else if (!test && !sceneStage && markerReceipt?.completed !== true) report.code = 'UNITY_READY_UNCONFIRMED';
    else if (result?.code !== 0) report.code = player ? 'UNITY_PLAYER_EXIT' : 'UNITY_EDITOR_EXIT';
    if (sceneStage && !report.code && input.plan.capture) {
      try { await finalizeUnityCapture(input, gameView, signal); }
      catch (error) {
        report.code = error instanceof Error && /^UNITY_CAPTURE_[A-Z_]+$/.test(error.message)
          ? error.message : 'UNITY_CAPTURE_INVALID';
      }
    }
    if (build) await writeFile(join(input.directory, 'build-report.json'), JSON.stringify({ ...report, native: {
      warnings: Number.isSafeInteger(markerReceipt?.warnings) ? markerReceipt?.warnings : null,
      errors: Number.isSafeInteger(markerReceipt?.errors) ? markerReceipt?.errors : null,
      reportedBytes: Number.isSafeInteger(markerReceipt?.reportedBytes) ? markerReceipt?.reportedBytes : null,
    } }), { mode: 0o600, flag: 'wx' });
    if (phase === 'IMPORT' || phase === 'EDITOR') {
      await writeFile(join(input.directory, 'import-report.json'), JSON.stringify(report), { mode: 0o600, flag: 'wx' });
      await writeFile(join(input.directory, 'compilation-report.json'), JSON.stringify({ code: report.code, diagnostics }),
        { mode: 0o600, flag: 'wx' });
    }
    send({ type: 'report', report });
    return { code: report.code, report, normalExit: !!result && result.code !== null && !local.aborted &&
      (markerReceipt !== null || tests !== null || /Exiting batchmode successfully|Scripts have compiler errors|Exiting batchmode due to failure/i.test(log)) };
  } finally {
    local.removeEventListener('abort', cancel);
    clearInterval(quotas);
  }
}

process.on('message', async (message: 'cancel' | UnityWorkerInput) => {
  if (message === 'cancel') { controller.abort(); return; }
  if (!message || typeof message !== 'object') return;
  let outcome = { code: 'UNITY_WORKER_FAILED' as string | null, normalExit: false };
  try {
    if (!['EDITOR', 'IMPORT', 'EDITMODE', 'PLAYMODE', 'BUILD', 'PLAYER', 'GAME_VIEW', 'PIPELINE'].includes(message.plan.stage)) {
      throw new Error('UNITY_STAGE_UNAVAILABLE');
    }
    const stages: UnityStage[] = message.plan.stage === 'PLAYER' ? ['BUILD', 'PLAYER'] : message.plan.stage === 'PIPELINE'
      ? ['IMPORT', 'EDITMODE', 'PLAYMODE', 'BUILD', 'PLAYER'] : [message.plan.stage];
    const reports: UnityReport[] = [];
    for (const phase of stages) {
      const result = await stage(message, phase, controller.signal);
      outcome = result;
      reports.push(result.report);
      if (result.code || !result.normalExit) break;
    }
    await writeFile(join(message.directory, 'run-summary.json'), JSON.stringify({ id: message.id, projectId: message.projectId,
      editorVersion: message.editorVersion, reports }),
      { mode: 0o600, flag: 'wx' });
  } catch {
    outcome.normalExit = !spawned;
  } finally {
    clearInterval(heartbeat);
    send({ type: 'done', ...outcome });
    if (process.connected) process.disconnect?.();
  }
});
