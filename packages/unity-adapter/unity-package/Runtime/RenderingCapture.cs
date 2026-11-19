using System;
using System.Collections;
using System.IO;
using UnityEngine;

namespace DevHub.UnityAutomation
{
    public sealed partial class ScenarioProbe
    {
        private IEnumerator Capture(string prefix)
        {
            if (!int.TryParse(ReadArgument("-devhubWidth"), out int width) ||
                !int.TryParse(ReadArgument("-devhubHeight"), out int height) ||
                !int.TryParse(ReadArgument("-devhubSeconds"), out int seconds)) yield break;
            if (width < 320 || width > 1920 || height < 240 || height > 1080 || seconds < 1 || seconds > 12)
                throw new InvalidOperationException("Invalid capture bounds.");

            string folder = ReadArgument("-devhubArtifacts");
            string frames = Path.Combine(folder, "frames");
            Directory.CreateDirectory(frames);
            var deadline = Time.realtimeSinceStartupAsDouble;
            for (int index = 0; index < seconds * 8; index++)
            {
                while (Time.realtimeSinceStartupAsDouble < deadline) yield return null;
                yield return new WaitForEndOfFrame();
                var source = ScreenCapture.CaptureScreenshotAsTexture();
                if (source == null) throw new InvalidOperationException("No render frame received.");
                var scratch = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
                var previous = RenderTexture.active;
                var output = new Texture2D(width, height, TextureFormat.RGB24, false);
                byte[] bytes;
                try
                {
                    Graphics.Blit(source, scratch);
                    RenderTexture.active = scratch;
                    output.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                    output.Apply();
                    bytes = output.EncodeToPNG();
                }
                finally
                {
                    RenderTexture.active = previous;
                    RenderTexture.ReleaseTemporary(scratch);
                    Destroy(source);
                    Destroy(output);
                }
                if (bytes == null || bytes.Length == 0 || bytes.Length > 12 * 1024 * 1024)
                    throw new InvalidOperationException("Capture bytes outside budget.");
                File.WriteAllBytes(Path.Combine(frames, "frame-" + index.ToString("D4") + ".png"), bytes);
                if (index == 0) File.WriteAllBytes(Path.Combine(folder, prefix + ".png"), bytes);
                deadline += 1.0 / 8;
            }
        }
    }
}
