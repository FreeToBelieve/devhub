using System;
using System.Collections;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace DevHub.UnityAutomation
{
    public interface IDevHubScenario
    {
        bool Trigger();
    }

    public sealed partial class ScenarioProbe : MonoBehaviour
    {
        [Serializable]
        private sealed class Receipt
        {
            public string run;
            public string scene;
            public bool objectPresent;
            public bool skillTriggered;
            public int frames;
        }

        private static string ReadArgument(string name)
        {
            var arguments = Environment.GetCommandLineArgs();
            var index = Array.IndexOf(arguments, name);
            return index < 0 || index + 1 >= arguments.Length ? "" : arguments[index + 1];
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Initialize()
        {
            string stage = ReadArgument("-devhubStage");
            if (stage != "PLAYER" && stage != "GAME_VIEW") return;
            if (!Guid.TryParse(ReadArgument("-devhubRun"), out _)) return;
            var probe = new GameObject("DevHub Scenario Probe");
            probe.AddComponent<ScenarioProbe>();
        }

        private IEnumerator Start()
        {
            var first = Time.frameCount;
            yield return null;
            var scene = SceneManager.GetActiveScene();
            var anchor = scene.GetRootGameObjects().FirstOrDefault(root => root.name == "DevHubScenario");
            var behaviour = anchor == null ? null : anchor.GetComponents<MonoBehaviour>().OfType<IDevHubScenario>().FirstOrDefault();
            var triggered = behaviour != null && behaviour.Trigger();
            for (int count = 0; count < 3; count++) yield return null;
            bool editor = ReadArgument("-devhubStage") == "GAME_VIEW";
            string prefix = editor ? "game-view" : "player";
            if (triggered && anchor != null) yield return Capture(prefix);
            var receipt = new Receipt
            {
                run = ReadArgument("-devhubRun"),
                scene = scene.path,
                objectPresent = anchor != null,
                skillTriggered = triggered,
                frames = Time.frameCount - first
            };
            var output = Path.Combine(ReadArgument("-devhubArtifacts"), prefix + "-ready.json");
            File.WriteAllText(output + ".tmp", JsonUtility.ToJson(receipt));
            File.Move(output + ".tmp", output);
            bool passed = receipt.objectPresent && receipt.skillTriggered && receipt.frames > 0 && receipt.scene == ReadArgument("-devhubScene");
            Debug.Log(passed ? "DEVHUB_SCENARIO_VERIFIED" : "DEVHUB_SCENARIO_FAILED");
            if (!editor) Application.Quit(passed ? 0 : 3);
        }
    }
}
