# Ocean Integration Strategy for Three-Geospatial

Based on research into Sebastian Lague's Geographical Adventures project and the existing three-geospatial codebase, here's a comprehensive strategy for integrating ocean rendering with the full geospatial tile system.

## Sebastian Lague's Approach Analysis

### Key Innovations from Geographical Adventures

#### 1. Distance-from-Shore Masking
```glsl
// Core masking technique
float dstFromShore = tex2D(_FoamDistanceMap, uv);
dstFromShore = saturate(dstFromShore / _FoamDst);

// Dynamic threshold based on distance from shore
float threshold = lerp(0.375, 0.55, saturate(dstFromShore)); 
foamMask = smoothstep(threshold, threshold + _FoamMaskBlend * 0.01, foamMask);
```

**Key Insight**: Uses a pre-computed distance field texture (`_FoamDistanceMap`) that encodes distance from coastline. This allows for:
- Gradual foam intensity falloff from shore
- Dynamic masking thresholds
- Efficient GPU-based boundary detection

#### 2. Multi-Texture Ocean Color System
```glsl
float height = tex2D(_Bathymetry, uv).r;
float chloro = tex2D(_Chloro, uv).r;
float shallowHeight = tex2D(_BathyShallow, uv).r;
float3 shallowCol = lerp(_ShallowBlueB, _ShallowBlueA, shallowHeight);
float3 col = lerp(_DeepBlue, shallowCol, chloro * 0.4 + height);
```

**Key Components**:
- **Bathymetry texture**: Water depth/elevation data
- **Chlorophyll texture**: Biological activity for color variation
- **Shallow water mask**: Separate handling of coastal waters
- **Dynamic color blending**: Based on multiple environmental factors

#### 3. Land Mask Integration
```csharp
// C# code shows landMask texture passed to compute shader
oceanTileCompute.SetTexture(0, "LandMask", landMask);
```

**Architecture**:
- Pre-computed land/water classification texture
- Compute shader integration for tile generation
- Coastline-aware mesh and shader processing

## Proposed Integration Strategy

### Phase 1: Mask-Based Ocean Overlay

#### A. Create Land/Water Boundary System
```typescript
// New component: WaterMaskProvider
class WaterMaskProvider {
  // Generate or load water mask textures
  // Options: Cesium quantized mesh, OpenStreetMap waterways, 
  // or simplified distance fields
  generateWaterMask(bounds: GeographicBounds): Texture2D
  getDistanceFromShore(coordinate: GeodeticCoordinate): number
}
```

#### B. Enhanced Ocean Material
```wgsl
// WebGPU Ocean Shader Extension
@fragment fn oceanFragment(input: VertexOutput) -> @location(0) vec4f {
    // Sample water mask at current position
    let waterMask = textureSample(waterMaskTexture, sampler, input.uv);
    
    if (waterMask.r < waterThreshold) {
        discard; // This pixel is on land
    }
    
    // Distance from shore for foam/color variation
    let dstFromShore = waterMask.g; // Store in green channel
    
    // Existing IFFT ocean rendering
    let oceanColor = computeIFFTOcean(input.position, dstFromShore);
    
    // Sebastian Lague style masking
    let foamMask = computeFoamMask(input.position, dstFromShore);
    
    return mix(oceanColor, foamColor, foamMask);
}
```

### Phase 2: Ray-Ellipsoid Ocean Surface

#### A. Fragment-Based Ocean Rendering
```wgsl
// Use existing rayEllipsoidIntersection from three-geospatial/core
fn renderOceanOverlay(rayOrigin: vec3f, rayDirection: vec3f) -> vec4f {
    // Intersect with ellipsoid at sea level
    let intersections = rayEllipsoidIntersection(rayOrigin, rayDirection, earthRadii);
    let oceanDistance = intersections.x;
    
    if (oceanDistance < 0.0) { 
        discard; // Ray misses earth
    }
    
    let oceanSurfacePos = rayOrigin + rayDirection * oceanDistance;
    
    // Sample water mask at intersection point
    let geodetic = ecefToGeodetic(oceanSurfacePos);
    let maskCoord = geodeticToUV(geodetic);
    let waterMask = textureSample(globalWaterMask, sampler, maskCoord);
    
    if (waterMask.r < waterThreshold) {
        discard; // Intersection point is on land
    }
    
    // Render IFFT ocean at surface position
    return computeOceanAtPosition(oceanSurfacePos, waterMask);
}
```

### Phase 3: Integration with Existing Architecture

#### A. Post-Processing Pipeline Integration
```typescript
// Extend existing post-processing chain
const oceanPassNode = pass(oceanScene, camera, { samples: 0 })
const oceanColorNode = oceanPassNode.getTextureNode('output')

// Insert ocean after main scene, before aerial perspective
const aerialNode = aerialPerspective(
  context, 
  colorNode.add(oceanColorNode), // Composite ocean with scene
  depthNode, 
  normalNode
)
```

#### B. Atmosphere Integration
```typescript
// Ocean chunks with atmosphere context
<OceanChunks 
  waveGenerator={waveGenerator} 
  atmosphereContext={context}
  waterMaskProvider={waterMaskProvider} // New prop
  renderMode="overlay" // New mode for post-3D tiles rendering
/>
```

### Phase 4: Data Pipeline

#### A. Water Mask Generation Options

**Option 1: Cesium Ion Integration**
```typescript
// Use quantized mesh water masks when available
class CesiumWaterMaskProvider implements WaterMaskProvider {
  async getWaterMask(tileCoord: TileCoordinate): Promise<Uint8Array> {
    // Request quantized mesh with water mask extension
    const response = await fetch(`cesium-ion-url?extensions=watermask`)
    return this.parseWaterMask(response)
  }
}
```

**Option 2: OpenStreetMap Integration**
```typescript
// Generate water masks from OSM water polygons
class OSMWaterMaskProvider implements WaterMaskProvider {
  generateDistanceField(waterPolygons: Polygon[]): Texture2D {
    // Create distance field texture from vector water data
    return this.rasterizeWaterBoundaries(waterPolygons)
  }
}
```

**Option 3: Simplified Approach**
```typescript
// Use basic coastal proximity for prototyping
class ProximityWaterMaskProvider implements WaterMaskProvider {
  // Simple ocean = everywhere below sea level approach
  // Good for initial implementation
}
```

## Implementation Roadmap

### Week 1: Basic Masking
- [ ] Create WaterMaskProvider interface
- [ ] Implement ProximityWaterMaskProvider (simple version)
- [ ] Extend ocean material with basic land/water masking

### Week 2: Sebastian Lague Features
- [ ] Implement distance-from-shore foam masking
- [ ] Add bathymetry-based color variation
- [ ] Create triplanar noise sampling for foam

### Week 3: Ray-Ellipsoid Integration
- [ ] Implement fragment-based ocean overlay
- [ ] Integrate with existing ray-ellipsoid intersection functions
- [ ] Test with 3D tiles rendering

### Week 4: Post-Processing Integration
- [ ] Integrate ocean overlay with atmosphere pipeline
- [ ] Ensure depth buffer correctness for atmospheric effects
- [ ] Performance optimization and testing

## Technical Advantages

1. **Leverages Existing Infrastructure**: Uses three-geospatial's ray intersection, atmosphere, and post-processing systems
2. **Sebastian Lague's Proven Techniques**: Distance fields, multi-texture masking, and foam generation
3. **Scalable Data Pipeline**: Can start simple and upgrade to high-precision water masks
4. **WebGPU Optimized**: Fragment-intensive approach works well with WebGPU's compute capabilities
5. **Atmospheric Integration**: Single-pass optical depth calculation as mentioned by creator

## Key Files to Modify/Create

```
packages/ocean-ifft/src/
├── masking/
│   ├── WaterMaskProvider.ts          # Interface for water mask data
│   ├── ProximityWaterMask.ts         # Simple implementation
│   └── CesiumWaterMask.ts            # Cesium Ion integration
├── webgpu/
│   ├── OceanOverlayMaterial.ts       # Ray-ellipsoid ocean material
│   └── oceanMasking.wgsl             # WGSL masking functions
└── r3f/
    └── OceanOverlay.tsx              # React component for overlay mode
```

This strategy addresses the creator's concern about boundary precision while building on proven techniques from Sebastian Lague and the existing three-geospatial architecture.