import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCodexWorktree } from '../apps/hub/dist/codex-worktree.js';
import { codexConfiguration } from '../packages/codex-adapter/dist/index.js';

// This native sandbox and Editor test uses synthetic files and no credentials.
const binary = process.env.DEVHUB_CODEX_BIN;
if (process.platform !== 'darwin' || !binary) throw new Error('Set DEVHUB_CODEX_BIN to the installed macOS SDK CLI.');
const temporary = mkdtempDisposableSync(join(tmpdir(), 'devhub-unity-'));
const exec = promisify(execFile);
const root = temporary.path;
const source = join(root, 'source');
const logFile = join(root, 'unity.log');
const editorVersion = process.env.DEVHUB_UNITY_VERSION ?? '6000.3.28f1';
let localRequests = 0;
const listener = createServer((_request, response) => { localRequests++; response.end('fixture'); });

try {
  mkdirSync(join(source, 'Assets', 'Editor'), { recursive: true });
  mkdirSync(join(source, 'Assets', 'Shaders'), { recursive: true });
  mkdirSync(join(source, 'Packages'));
  mkdirSync(join(source, 'ProjectSettings'));
  writeFileSync(join(source, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + editorVersion + '\n');
  writeFileSync(join(source, 'Packages', 'manifest.json'), '{"dependencies":{"com.unity.modules.physics":"1.0.0"}}\n');
  writeFileSync(join(source, '.gitignore'), '/Library/\n/Temp/\n/Obj/\n/Logs/\n/UserSettings/\n/Build/\n');
  writeFileSync(join(source, 'Assets', 'Shaders', 'Fixture.shader'), 'Shader "DevHub/Fixture" { SubShader { Pass {} } }\n');
  writeFileSync(join(source, 'Assets', 'Editor', 'DevHubFixture.cs'), `
using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.Build.Reporting;
using UnityEngine;

public static class DevHubFixture {
  public static void Prepare() {
    Directory.CreateDirectory("Assets/Scenes");
    Directory.CreateDirectory("Assets/Prefabs");
    var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
    var item = new GameObject("FixtureScene");
    EditorSceneManager.SaveScene(scene, "Assets/Scenes/Fixture.unity");
    item.name = "Fixture";
    PrefabUtility.SaveAsPrefabAsset(item, "Assets/Prefabs/Fixture.prefab");
    AssetDatabase.SaveAssets();
    Debug.Log("DEVHUB_FIXTURE_PREPARED");
  }
  public static void Build() {
    AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
    var scene = EditorSceneManager.OpenScene("Assets/Scenes/Fixture.unity");
    var prefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Prefabs/Fixture.prefab");
    var script = AssetDatabase.LoadAssetAtPath<MonoScript>("Assets/FixtureBehavior.cs");
    if (scene.GetRootGameObjects()[0].name != "DevHubScene") throw new Exception("DEVHUB_FIXTURE_SCENE_FAILED");
    if (prefab == null) throw new Exception("DEVHUB_FIXTURE_PREFAB_FAILED");
    if (Shader.Find("DevHub/Modified") == null) throw new Exception("DEVHUB_FIXTURE_SHADER_FAILED");
    if (script == null || script.GetClass() == null) throw new Exception("DEVHUB_FIXTURE_SCRIPT_FAILED");
    if (PlayerSettings.productName != "DevHubSprint23B") throw new Exception("DEVHUB_FIXTURE_SETTINGS_FAILED");
    Debug.Log("DEVHUB_FIXTURE_IMPORTED");
    var report = BuildPipeline.BuildPlayer(new [] { "Assets/Scenes/Fixture.unity" },
        "Build/DevHubFixture.app", BuildTarget.StandaloneOSX, BuildOptions.None);
    if (report.summary.result != BuildResult.Succeeded) throw new Exception("DEVHUB_FIXTURE_BUILD_FAILED");
    Debug.Log("DEVHUB_FIXTURE_BUILD_COMPLETE");
  }
}
`);

  async function editor(project, method) {
    try {
      await exec('unity', ['run', project, '--editor-version', editorVersion, '--timeout', '240',
        '--log-file', logFile, '--no-tail', '--', '-nographics', '-executeMethod', 'DevHubFixture.' + method],
      { env: { ...process.env, UNITY_NO_UPDATE_CHECK: '1', UNITY_NO_CRASH_REPORT: '1', UNITY_NO_AGENT_HINTS: '1' },
        timeout: 250_000, maxBuffer: 256_000 });
    } catch (error) {
      const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
      console.error(text.split(/\r?\n/).filter((line) =>
        /error CS\d+|DEVHUB_FIXTURE_|Failed to|Build completed with a result/.test(line)).slice(-18).join('\n'));
      throw new Error('Unity fixture ' + method + ' exited with code ' + (error.code ?? 'unknown'));
    }
    return readFileSync(logFile, 'utf8');
  }
  assert.match(await editor(source, 'Prepare'), /DEVHUB_FIXTURE_PREPARED/);
  console.log('PASS Unity 6.3 seed import and serialization');
  const git = (...args) => execFileSync('git', ['-C', source, '-c', 'user.name=DevHub Fixture', '-c',
    'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=disabled-fixture-hooks',
    ...args], { stdio: 'pipe' });
  git('init', '-b', 'main', '-q');
  git('add', '--all');
  git('commit', '-qm', 'Temporary Unity fixture');
  const worktree = (await createCodexWorktree(source, join(root, 'worktrees'))).root;
  const login = join(root, 'profile');
  mkdirSync(login, { mode: 0o700 });
  const syntheticAuth = join(login, 'auth.json');
  const syntheticKey = join(root, 'private-fixture');
  const otherProject = join(root, 'other-project');
  mkdirSync(otherProject);
  writeFileSync(syntheticAuth, '{}\n', { mode: 0o600 });
  writeFileSync(syntheticKey, 'synthetic fixture\n', { mode: 0o600 });
  writeFileSync(join(otherProject, '.env'), 'FIXTURE=true\n', { mode: 0o600 });
  const gitPointer = readFileSync(join(worktree, '.git'), 'utf8');
  symlinkSync(syntheticKey, join(worktree, 'fixture-link'));
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  const { rawConfigOverrides } = codexConfiguration(worktree);
  const sandboxCommand = [
    'set -eu',
    'for fixture in "$1" "$2" "$3" fixture-link; do',
    '  if /bin/cat "$fixture" >/dev/null 2>&1; then exit 21; fi',
    'done',
    'if ( : >> .git ) 2>/dev/null; then exit 22; fi',
    'if ( : > ../outside-worktree ) 2>/dev/null; then exit 23; fi',
    'if /usr/bin/curl --noproxy "*" --max-time 3 -fsS "$4" >/dev/null 2>&1; then exit 24; fi',
    '/usr/bin/sed -i "" "s/m_Name: FixtureScene/m_Name: DevHubScene/" Assets/Scenes/Fixture.unity',
    '/usr/bin/sed -i "" "s/m_Name: Fixture$/m_Name: DevHubPrefab/" Assets/Prefabs/Fixture.prefab',
    '/usr/bin/sed -i "" "s@DevHub/Fixture@DevHub/Modified@" Assets/Shaders/Fixture.shader',
    '/usr/bin/sed -i "" "s/productName:.*/productName: DevHubSprint23B/" ProjectSettings/ProjectSettings.asset',
    "cat > Packages/manifest.json <<'MANIFEST'",
    '{"dependencies":{"com.unity.modules.physics":"1.0.0","com.unity.modules.animation":"1.0.0"}}',
    'MANIFEST',
    'printf "%s\\n" "using UnityEngine; public sealed class FixtureBehavior : MonoBehaviour {}" > Assets/FixtureBehavior.cs',
    'printf "\\n# DevHub fixture\\n" >> Assets/Shaders/Fixture.shader.meta',
  ].join('\n');
  try {
    await exec(binary, ['sandbox', '--permission-profile', 'PROJECT_DEVELOPER', '--cd', worktree,
      ...rawConfigOverrides.flatMap((value) => ['-c', value]), '--', '/bin/sh', '-c', sandboxCommand,
      'devhub-fixture', syntheticAuth, syntheticKey, join(otherProject, '.env'), 'http://127.0.0.1:' + port + '/'],
      { env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: login }, timeout: 20_000 });
  } catch (error) {
    throw new Error('Native sandbox fixture failed with code ' + (error.code ?? 'unknown'));
  }
  assert.equal(localRequests, 0);
  assert.equal(readFileSync(join(worktree, '.git'), 'utf8'), gitPointer);
  assert.equal(existsSync(join(worktree, '..', 'outside-worktree')), false);
  assert.equal(existsSync(join(source, 'Assets', 'FixtureBehavior.cs')), false);
  assert.match(readFileSync(join(worktree, 'Assets', 'Prefabs', 'Fixture.prefab'), 'utf8'), /m_Name: DevHubPrefab/);
  assert.match(readFileSync(join(worktree, 'Assets', 'Shaders', 'Fixture.shader.meta'), 'utf8'), /DevHub fixture/);
  assert.equal(JSON.parse(readFileSync(join(worktree, 'Packages', 'manifest.json'), 'utf8'))
    .dependencies['com.unity.modules.animation'], '1.0.0');
  unlinkSync(join(worktree, 'fixture-link'));
  console.log('PASS native sandbox credentials, symlink, Git, write scope and direct network OFF');
  const built = await editor(worktree, 'Build');
  assert.match(built, /DEVHUB_FIXTURE_IMPORTED/);
  assert.match(built, /DEVHUB_FIXTURE_BUILD_COMPLETE/);
  assert.ok(existsSync(join(worktree, 'Build', 'DevHubFixture.app', 'Contents', 'MacOS')));
  console.log('PASS Unity 6.3 import and macOS player build from modified linked worktree');
} finally {
  listener.close();
  temporary.remove();
}
