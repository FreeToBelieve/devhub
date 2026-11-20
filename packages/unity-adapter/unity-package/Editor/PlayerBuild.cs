using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace DevHub.UnityAutomation
{
    public static partial class EditorBridge
    {
        [Serializable]
        private sealed class BuildReceipt
        {
            public string run;
            public string version;
            public bool completed;
            public string target;
            public string scene;
            public int errors;
            public int warnings;
            public long reportedBytes;
            public double seconds;
        }

        public static void Build()
        {
            var scene = Value("-devhubScene");
            var platform = Value("-devhubPlatform");
            var target = platform == "MACOS" ? BuildTarget.StandaloneOSX : BuildTarget.StandaloneWindows64;
            var configured = EditorBuildSettings.scenes.Where(entry => entry.enabled).ToArray();
            if (AssetDatabase.LoadAssetAtPath<SceneAsset>(scene) == null ||
                (configured.Length > 0 && !configured.Any(entry => entry.path == scene)) ||
                !BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.Standalone, target))
                throw new InvalidOperationException("DEVHUB_BUILD_SETTINGS_DENIED");
            var project = Path.Combine(Value("-devhubArtifacts"), "build");
            Directory.CreateDirectory(project);
            var output = Path.Combine(project, platform == "MACOS" ? "DevHubPlayer.app" : "DevHubPlayer.exe");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { scene }, locationPathName = output, target = target, options = BuildOptions.None
            });
            bool passed = report.summary.result == BuildResult.Succeeded;
            WriteReceipt("build-native.json", new BuildReceipt
            {
                run = Value("-devhubRun"), version = Application.unityVersion, completed = passed,
                target = target.ToString(), scene = scene, errors = report.summary.totalErrors,
                warnings = report.summary.totalWarnings, reportedBytes = (long)report.summary.totalSize,
                seconds = report.summary.totalTime.TotalSeconds
            });
            Debug.Log(passed ? "DEVHUB_BUILD_COMPLETE" : "DEVHUB_BUILD_FAILED");
            EditorApplication.Exit(passed ? 0 : 2);
        }
    }
}
