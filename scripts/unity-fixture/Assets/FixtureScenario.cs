using DevHub.UnityAutomation;
using UnityEngine;

public sealed class FixtureScenario : MonoBehaviour, IDevHubScenario
{
    private bool activated;
    private Transform orb;
    private Transform[] sparks;
    private float start;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    private static void Register()
    {
        GameObject anchor = GameObject.Find("DevHubScenario");
        if (anchor != null) anchor.AddComponent<FixtureScenario>();
    }

    public bool Trigger()
    {
        if (activated) return false;
        var prefab = Resources.Load<GameObject>("FixtureBeacon");
        var material = Resources.Load<Material>("FixtureGlow");
        if (prefab == null || material == null || !material.shader.isSupported) return false;
        var beacon = Instantiate(prefab, transform);
        activated = true;
        start = Time.realtimeSinceStartup;

        var camera = new GameObject("Fixture Camera").AddComponent<Camera>();
        camera.transform.position = new Vector3(4f, 3.2f, -7f);
        camera.transform.LookAt(new Vector3(0f, 0.6f, 0f));
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = new Color(0.045f, 0.075f, 0.13f);

        orb = Primitive(PrimitiveType.Sphere, "Skill Orb", material, new Color(0.05f, 0.85f, 0.98f), beacon.transform);
        var basePlate = Primitive(PrimitiveType.Cylinder, "Pedestal", material, new Color(0.13f, 0.28f, 0.40f), beacon.transform);
        basePlate.localScale = new Vector3(2.25f, 0.13f, 2.25f);
        sparks = new Transform[10];
        for (int index = 0; index < sparks.Length; index++)
        {
            sparks[index] = Primitive(PrimitiveType.Cube, "Orbit Spark", material, new Color(0.25f, 0.72f, 1f), beacon.transform);
            sparks[index].localScale = Vector3.one * 0.13f;
        }
        return orb != null && beacon != null;
    }

    private static Transform Primitive(PrimitiveType shape, string label, Material material, Color tint, Transform parent)
    {
        var instance = GameObject.CreatePrimitive(shape);
        instance.name = label;
        instance.transform.SetParent(parent, false);
        var renderer = instance.GetComponent<Renderer>();
        renderer.material = material;
        renderer.material.color = tint;
        return instance.transform;
    }

    private void Update()
    {
        if (!activated) return;
        float elapsed = Time.realtimeSinceStartup - start;
        orb.localPosition = new Vector3(0, 1.15f + Mathf.Sin(elapsed * 5f) * 0.18f, 0);
        orb.localScale = Vector3.one * (0.95f + Mathf.Sin(elapsed * 3.7f) * 0.12f);
        for (int index = 0; index < sparks.Length; index++)
        {
            float angle = index * Mathf.PI * 2f / sparks.Length + elapsed * 2.5f;
            sparks[index].localPosition = new Vector3(Mathf.Cos(angle) * 1.42f, 0.75f + Mathf.Sin(angle * 2) * 0.25f,
                Mathf.Sin(angle) * 1.42f);
            sparks[index].localRotation = Quaternion.Euler(elapsed * 70f, angle * Mathf.Rad2Deg, 38f);
        }
    }
}
