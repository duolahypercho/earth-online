using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using SanFrancisco.Runtime;

namespace SanFrancisco
{
    /// <summary>
    /// Starts the playable vertical slice in an empty scene. This keeps the deliverable easy to
    /// open while allowing each feature system to remain independently replaceable.
    /// </summary>
    public sealed class SanFranciscoBootstrap : MonoBehaviour
    {
        private readonly List<ISanFranciscoRuntimeSystem> systems = new();
        private float startedAt;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Install()
        {
            if (FindFirstObjectByType<SanFranciscoBootstrap>() != null) return;
            var root = new GameObject("SAN FRANCISCO // PLAYABLE SLICE");
            DontDestroyOnLoad(root);
            root.AddComponent<SanFranciscoBootstrap>();
        }

        private void Awake()
        {
            startedAt = Time.realtimeSinceStartup;
            Application.targetFrameRate = 60;
            QualitySettings.vSyncCount = 0;
            ConfigureEnvironment();
            EnsureCamera();
            DiscoverSystems();
            foreach (var system in systems) system.BuildRuntimeWorld();
        }

        private void ConfigureEnvironment()
        {
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogColor = new Color(0.52f, 0.62f, 0.72f);
            RenderSettings.fogDensity = 0.0022f;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.34f, 0.47f, 0.66f);
            RenderSettings.ambientEquatorColor = new Color(0.54f, 0.56f, 0.52f);
            RenderSettings.ambientGroundColor = new Color(0.12f, 0.11f, 0.10f);
            RenderSettings.defaultReflectionMode = DefaultReflectionMode.Skybox;
            RenderSettings.reflectionIntensity = 0.9f;

            var sun = FindFirstObjectByType<Light>();
            if (sun == null)
            {
                var sunObject = new GameObject("SF // late afternoon sun");
                sun = sunObject.AddComponent<Light>();
            }
            sun.type = LightType.Directional;
            sun.intensity = 3.0f;
            sun.color = new Color(1.0f, 0.83f, 0.67f);
            sun.transform.rotation = Quaternion.Euler(32f, -38f, 0f);
            sun.shadows = LightShadows.Soft;
            sun.shadowStrength = 0.78f;
        }

        private void EnsureCamera()
        {
            var camera = Camera.main;
            if (camera == null)
            {
                var cameraObject = new GameObject("SF // cinematic camera");
                camera = cameraObject.AddComponent<Camera>();
                camera.tag = "MainCamera";
            }
            camera.fieldOfView = 58f;
            camera.nearClipPlane = 0.05f;
            camera.farClipPlane = 2200f;
            camera.transform.position = new Vector3(62f, 42f, -74f);
            camera.transform.rotation = Quaternion.Euler(24f, 38f, 0f);
            camera.gameObject.AddComponent<SanFranciscoCameraRig>();
        }

        private void DiscoverSystems()
        {
            var candidates = AppDomain.CurrentDomain.GetAssemblies()
                .SelectMany(assembly => SafeGetTypes(assembly))
                .Where(type => typeof(MonoBehaviour).IsAssignableFrom(type) && typeof(ISanFranciscoRuntimeSystem).IsAssignableFrom(type) && !type.IsAbstract)
                .OrderBy(type => type.FullName);

            foreach (var candidate in candidates)
            {
                var component = gameObject.GetComponent(candidate) ?? gameObject.AddComponent(candidate);
                if (component is ISanFranciscoRuntimeSystem system) systems.Add(system);
            }
        }

        private static IEnumerable<Type> SafeGetTypes(System.Reflection.Assembly assembly)
        {
            try { return assembly.GetTypes(); }
            catch (System.Reflection.ReflectionTypeLoadException exception) { return exception.Types.Where(type => type != null); }
        }

        private void OnGUI()
        {
            var style = new GUIStyle(GUI.skin.label)
            {
                fontSize = Mathf.Max(12, Screen.height / 72),
                normal = { textColor = new Color(0.95f, 0.97f, 1f) },
                richText = true
            };
            GUI.Label(new Rect(26, 22, 650, 42), "<b>SAN FRANCISCO</b>  /  PACIFIC DISTRICT  //  LIVE CITY SLICE", style);
            GUI.Label(new Rect(26, 54, 650, 34), $"SYSTEMS ONLINE  {systems.Count:00}    RUNTIME  {Time.realtimeSinceStartup - startedAt:0.0}s    FPS  {1f / Mathf.Max(Time.unscaledDeltaTime, 0.001f):0}", style);
        }
    }

    public sealed class SanFranciscoCameraRig : MonoBehaviour
    {
        private Vector3 velocity;
        private float orbit;

        private void LateUpdate()
        {
            orbit += Time.deltaTime * 0.8f;
            var lookAt = new Vector3(0f, 8f, 35f);
            var desired = new Vector3(86f + Mathf.Sin(orbit * 0.11f) * 4f, 44f + Mathf.Sin(orbit * 0.07f) * 2f, -92f);
            transform.position = Vector3.SmoothDamp(transform.position, desired, ref velocity, 1.4f);
            transform.rotation = Quaternion.Slerp(transform.rotation, Quaternion.LookRotation(lookAt - transform.position, Vector3.up), Time.deltaTime * 1.2f);
        }
    }
}
