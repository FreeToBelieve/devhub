Shader "DevHub/FixtureGlow" {
  Properties { _Color ("Tint", Color) = (0.1, 0.8, 0.9, 1) }
  SubShader {
    Tags { "RenderType"="Opaque" }
    Pass {
      CGPROGRAM
      #pragma vertex vert
      #pragma fragment frag
      #include "UnityCG.cginc"
      fixed4 _Color;
      struct Frame { float4 position : SV_POSITION; float3 normal : TEXCOORD0; };
      Frame vert(appdata_base input) {
        Frame output;
        output.position = UnityObjectToClipPos(input.vertex);
        output.normal = UnityObjectToWorldNormal(input.normal);
        return output;
      }
      fixed4 frag(Frame input) : SV_Target {
        float brightness = 0.45 + 0.55 * max(0, dot(normalize(input.normal), normalize(float3(-0.6, 1, -0.7))));
        return fixed4(_Color.rgb * brightness, 1);
      }
      ENDCG
    }
  }
}
