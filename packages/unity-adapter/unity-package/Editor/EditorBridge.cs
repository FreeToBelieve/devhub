using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace DevHub.UnityAutomation
{
    public static partial class EditorBridge
    {
        [Serializable]
        private sealed class ReadyReceipt
        {
            public string run;
            public string version;
            public bool completed;
        }

        private static string Value(string key)
        {
            string[] args = Environment.GetCommandLineArgs();
            int index = Array.IndexOf(args, key);
            if (index < 0 || index + 1 >= args.Length) throw new ArgumentException(key);
            return args[index + 1];
        }

        private static void WriteReceipt(string name, object payload)
        {
            string folder = Value("-devhubArtifacts");
            if (!Path.IsPathRooted(folder) || !Directory.Exists(folder))
                throw new InvalidOperationException("Invalid DevHub artifact folder.");
            string target = Path.Combine(folder, name);
            File.WriteAllText(target + ".tmp", JsonUtility.ToJson(payload, true));
            File.Move(target + ".tmp", target);
        }

        public static void Ready() => FinishAfterImport(false);
        public static void Import() => FinishAfterImport(true);

        private static void FinishAfterImport(bool refresh)
        {
            if (refresh) AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            EditorApplication.update += Check;
            void Check()
            {
                if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
                EditorApplication.update -= Check;
                WriteReceipt("editor-ready.json", new ReadyReceipt
                {
                    run = Value("-devhubRun"),
                    version = Application.unityVersion,
                    completed = true
                });
                Debug.Log("DEVHUB_EDITOR_READY");
                EditorApplication.Exit(0);
            }
        }
    }
}
