Here’s what I found about the clever shader technique for masking the ocean in SebLague/Geographical-Adventures:

## Shader-Based Ocean Masking

### 1\. **Dedicated Ocean Shader:**

The main shader file is `Assets/Scripts/Shaders/Game/Ocean.shader` ([source](https://github.com/SebLague/Geographical-Adventures/blob/82fcda20bebb033c749b2339e9ce3a6e58007699/Assets/Scripts/Shaders/Game/Ocean.shader)). This shader uses several properties and custom logic to simulate realistic ocean masking and transitions, notably:

*   It uses various textures: `Ocean Colour`, `Noise`, `Wave Normal A/B`, and special foam and mask maps like `Foam Distance Map`.
*   It leverages custom parameters (_FoamMaskScale_, _FoamMaskBlend_, etc.) to control foam’s appearance and dynamic masking near shore.

### 2\. **Foam Masking Logic:**

Inside the foam creation, the shader calculates detailed foam patterns that radiate from the shore, using a combination of noise textures and mathematical operations. Relevant code block ([link](https://github.com/SebLague/Geographical-Adventures/blob/82fcda20bebb033c749b2339e9ce3a6e58007699/Assets/Scripts/Shaders/Game/Ocean.shader#L132-L141)):

GLSLWrap

Copy code

```
float2 foamMaskOffset = float2(-0.021, 0.07) * _FoamNoiseSpeed * _Time.x;
float foamMask = triplanar(pointOnUnitSphere, pointOnUnitSphere, _FoamMaskScale * 0.1, _Noise, foamMaskOffset).r;
float threshold = lerp(0.375, 0.55, saturate(dstFromShore)); // mask out more further from the shore
foamMask = smoothstep(threshold, threshold + _FoamMaskBlend * 0.01, foamMask);
```

*   **Key idea:** Foam is masked out more aggressively further from the shore using a noise-based mask and `smoothstep` blending.

### 3\. **Shadows & Night Masking:**

The shader includes a clever fix for regions where ocean shadows might be missing due to distant chunks getting culled—if it’s dark enough (at night), it forcibly zeros the value to indicate shadows ([link](https://github.com/SebLague/Geographical-Adventures/blob/82fcda20bebb033c749b2339e9ce3a6e58007699/Assets/Scripts/Shaders/Game/Ocean.shader#L232-L244)). This keeps the mask visually correct in all lighting conditions.

### 4\. **Land/Ocean Separation:**

In generation code (`Assets/Scripts/Generation/Terrain/OceanGenerator.cs`), there’s use of a `landMask` texture passed into a compute shader, which ensures tiles are aware of coastlines for mesh and shader masking ([link](https://github.com/SebLague/Geographical-Adventures/blob/82fcda20bebb033c749b2339e9ce3a6e58007699/Assets/Scripts/Generation/Terrain/OceanGenerator.cs#L51-L70)).

### 5\. **Color and Depth Masking:**

The `OceanColour.shader` ([source](https://github.com/SebLague/Geographical-Adventures/blob/82fcda20bebb033c749b2339e9ce3a6e58007699/Assets/Scripts/Shaders/Gen/OceanColour.shader)) computes color per pixel by sampling bathymetry, chlorophyll, and depth textures. It uses these to determine how much of the “ocean” should be rendered at a location, which is a form of mask.

GLSLWrap

Copy code

```
float height = tex2D(_Bathymetry, uv).r;
float chloro = tex2D(_Chloro, uv).r;
float shallowHeight = tex2D(_BathyShallow, uv).r;
float3 shallowCol = lerp(_ShallowBlueB, _ShallowBlueA, shallowHeight);
float3 col = lerp(_DeepBlue, shallowCol, chloro * 0.4 + height);
```

- - -

## Summary

*   The **masking technique is a blend of mesh generation using coastline-aware data and dynamic shader logic**, with special foam/noise blending for shore transitions.
*   Shadows, rim light, and depth-based masking help visually separate ocean/land (especially at night).
*   Bathymetry and custom mask textures are used to modulate both color and foam, contributing to the “masked” look.

You can review or tweak values (like `_FoamMaskScale` or landMask inputs) in the ocean shader to further modify or inspect the clever masking effect.

If you want code excerpts or more technical explanation for a specific part (foam, shadow, land masking), just say!