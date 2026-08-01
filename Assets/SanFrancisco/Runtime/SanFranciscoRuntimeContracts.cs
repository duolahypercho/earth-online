using UnityEngine;

namespace SanFrancisco.Runtime
{
    /// <summary>
    /// Runtime systems implement this contract so the project bootstrap can discover them
    /// without coupling the city, traffic, pedestrian, and presentation slices together.
    /// </summary>
    public interface ISanFranciscoRuntimeSystem
    {
        void BuildRuntimeWorld();
    }

    public static class SanFranciscoMaterials
    {
        public static Material Create(string name, Color color, float metallic = 0f, float smoothness = 0.35f)
        {
            var material = new Material(FindLitShader()) { name = name };
            material.color = color;
            material.SetFloat("_Metallic", metallic);
            material.SetFloat("_Smoothness", smoothness);
            material.EnableKeyword("_EMISSION");
            return material;
        }

        public static Shader FindLitShader()
        {
            return Shader.Find("Universal Render Pipeline/Lit")
                ?? Shader.Find("HDRP/Lit")
                ?? Shader.Find("Standard")
                ?? Shader.Find("Sprites/Default");
        }

        public static void ApplyEmission(Material material, Color color, float intensity = 1f)
        {
            material.EnableKeyword("_EMISSION");
            material.SetColor("_EmissionColor", color * intensity);
        }
    }

    public static class SanFranciscoGeometry
    {
        public static GameObject CreatePrimitive(string name, PrimitiveType type, Vector3 position, Vector3 scale, Material material, Transform parent = null)
        {
            var instance = GameObject.CreatePrimitive(type);
            instance.name = name;
            instance.transform.SetParent(parent, false);
            instance.transform.position = position;
            instance.transform.localScale = scale;
            if (material != null)
            {
                var renderer = instance.GetComponent<Renderer>();
                if (renderer != null) renderer.sharedMaterial = material;
            }
            return instance;
        }

        public static void Face(Vector3 from, Vector3 to, Transform target)
        {
            var direction = to - from;
            direction.y = 0f;
            if (direction.sqrMagnitude > 0.0001f) target.rotation = Quaternion.LookRotation(direction.normalized, Vector3.up);
        }
    }
}
