using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace DevHub.UnityAutomation
{
    [InitializeOnLoad]
    public static partial class EditorBridge
    {
        static EditorBridge()
        {
            var args = Environment.GetCommandLineArgs();
            int stage = Array.IndexOf(args, "-devhubStage");
            if (stage < 0 || stage + 1 >= args.Length || args[stage + 1] != "GAME_VIEW") return;
            EditorApplication.update += WaitForGameView;
        }

        public static void PlayScene()
        {
            var scene = Value("-devhubScene");
            if (AssetDatabase.LoadAssetAtPath<SceneAsset>(scene) == null)
                throw new InvalidOperationException("DEVHUB_SCENE_MISSING");
            EditorSceneManager.OpenScene(scene, OpenSceneMode.Single);
            var type = typeof(EditorWindow).Assembly.GetType("UnityEditor.GameView");
            if (type == null) throw new InvalidOperationException("DEVHUB_GAME_VIEW_UNAVAILABLE");
            EditorWindow.GetWindow(type).Show();
            EditorWindow.GetWindow(type).Focus();
            EditorApplication.isPlaying = true;
        }

        private static void WaitForGameView()
        {
            if (!File.Exists(Path.Combine(Value("-devhubArtifacts"), "game-view-ready.json"))) return;
            if (EditorApplication.isPlaying)
            {
                EditorApplication.isPlaying = false;
                return;
            }
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            EditorApplication.update -= WaitForGameView;
            EditorApplication.Exit(0);
        }
    }
}
