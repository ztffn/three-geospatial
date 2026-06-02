# Sebastian Lague Mask Integration Plan

## Overview

This plan details how to integrate Sebastian Lague's raster mask files from Geographical-Adventures into the three-geospatial ocean system for realistic land/water boundaries and foam effects.

## Sebastian Lague's Mask Files Analysis

### Available Mask Files
1. **Coastline Raster.png** - Global land/water boundary mask
2. **Shore Dst.png** - Distance field from coastlines (for foam effects)
3. **Lakes.jpg** - Inland water bodies (lakes, rivers)
4. **Mask 16x8 (thin edges).png** - Low-resolution global mask

### How Sebastian Lague Uses These
- **Equirectangular Projection**: World mapped to 0-1 UV coordinates
- **Distance Fields**: Shore Dst.png stores normalized distance from coastline
- **Binary Masks**: Coastline Raster.png for land (0) vs water (1) classification
- **Foam Generation**: Distance field drives foam intensity and placement

## Implementation Plan

### Phase 1: Download and Setup Mask Assets

```bash
# Create assets directory in ocean-ifft package
mkdir -p packages/ocean-ifft/assets/masks

# Download Sebastian Lague's masks
curl -o packages/ocean-ifft/assets/masks/coastline_raster.png \
  https://raw.githubusercontent.com/SebLague/Geographical-Adventures/main/Assets/Data/Mask/Coastline%20Raster.png

curl -o packages/ocean-ifft/assets/masks/shore_distance.png \
  https://raw.githubusercontent.com/SebLague/Geographical-Adventures/main/Assets/Data/Mask/Shore%20Dst.png

curl -o packages/ocean-ifft/assets/masks/lakes.jpg \
  https://raw.githubusercontent.com/SebLague/Geographical-Adventures/main/Assets/Data/Mask/Lakes.jpg

curl -o packages/ocean-ifft/assets/masks/global_mask_16x8.png \
  https://raw.githubusercontent.com/SebLague/Geographical-Adventures/main/Assets/Data/Mask/Mask%2016x8%20%28thin%20edges%29.png
```

### Phase 2: Create Mask Texture Loading System

```typescript
// packages/ocean-ifft/src/masking/GlobalMaskProvider.ts
import * as THREE from 'three'

export class GlobalMaskProvider {
  private coastlineMask?: THREE.Texture
  private shoreDistanceMap?: THREE.Texture  
  private lakesMask?: THREE.Texture
  private globalMask?: THREE.Texture

  async loadMasks(): Promise<void> {
    const loader = new THREE.TextureLoader()
    
    // Load all mask textures
    this.coastlineMask = await loader.loadAsync('/assets/masks/coastline_raster.png')
    this.shoreDistanceMap = await loader.loadAsync('/assets/masks/shore_distance.png')
    this.lakesMask = await loader.loadAsync('/assets/masks/lakes.jpg')
    this.globalMask = await loader.loadAsync('/assets/masks/global_mask_16x8.png')

    // Configure texture settings for proper sampling
    [this.coastlineMask, this.shoreDistanceMap, this.lakesMask, this.globalMask]
      .forEach(texture => {
        texture.wrapS = THREE.ClampToEdgeWrapping
        texture.wrapT = THREE.ClampToEdgeWrapping
        texture.magFilter = THREE.LinearFilter
        texture.minFilter = THREE.LinearFilter
      })
  }

  // Convert ECEF world position to equirectangular UV (0-1)
  worldToEquirectangularUV(worldPos: THREE.Vector3): THREE.Vector2 {
    // Convert to geodetic coordinates
    const geodetic = Ellipsoid.WGS84.cartesianToGeodetic(worldPos)
    
    // Map longitude [-π, π] to U [0, 1]
    const u = (geodetic.longitude + Math.PI) / (2 * Math.PI)
    
    // Map latitude [-π/2, π/2] to V [0, 1] (flipped for texture coordinate system)
    const v = 1.0 - (geodetic.latitude + Math.PI/2) / Math.PI
    
    return new THREE.Vector2(u, v)
  }

  // Get all masks for shader use
  getMasks() {
    return {
      coastline: this.coastlineMask,
      shoreDistance: this.shoreDistanceMap,
      lakes: this.lakesMask,
      global: this.globalMask
    }
  }
}
```

### Phase 3: Extend Ocean Material with Mask Sampling

```typescript
// packages/ocean-ifft/src/materials/MaskedOceanMaterial.ts
import { texture, uniform, wgslFn } from 'three/tsl'

export const globalMaskSampling = wgslFn(`
fn worldToEquirectangularUV(worldPos: vec3f) -> vec2f {
    // Convert world position to geodetic
    let r = length(worldPos);
    let lat = asin(worldPos.y / r);
    let lon = atan2(worldPos.z, worldPos.x);
    
    // Map to 0-1 UV coordinates
    let u = (lon + 3.14159) / (2.0 * 3.14159);
    let v = 1.0 - (lat + 1.5708) / 3.14159;
    
    return vec2f(u, v);
}

fn sampleWaterMask(worldPos: vec3f) -> f32 {
    let uv = worldToEquirectangularUV(worldPos);
    
    // Sample coastline and lakes masks
    let coastline = textureSample(coastlineMask, maskSampler, uv).r;
    let lakes = textureSample(lakesMask, maskSampler, uv).r;
    
    // Water if either ocean or lake
    return max(coastline, lakes);
}

fn getShoreDistance(worldPos: vec3f) -> f32 {
    let uv = worldToEquirectangularUV(worldPos);
    return textureSample(shoreDistanceMask, maskSampler, uv).r;
}

fn computeFoamMask(worldPos: vec3f, time: f32) -> f32 {
    let dstFromShore = getShoreDistance(worldPos);
    
    // Sebastian Lague's foam masking technique
    let threshold = mix(0.375, 0.55, saturate(dstFromShore));
    
    // Add noise for foam texture
    let noiseUV = worldPos.xz * 0.1 + vec2f(-0.021, 0.07) * time;
    let foamNoise = textureSample(noiseTex, noiseSampler, noiseUV).r;
    
    return smoothstep(threshold, threshold + 0.01, foamNoise) * (1.0 - dstFromShore);
}
`)

export class MaskedOceanMaterial {
  constructor(maskProvider: GlobalMaskProvider, waveGenerator: any) {
    const masks = maskProvider.getMasks()
    
    const material = new THREE.MeshPhysicalNodeMaterial({
      // Existing IFFT ocean properties...
      
      // Add mask textures
      coastlineMask: texture(masks.coastline),
      shoreDistanceMask: texture(masks.shoreDistance),
      lakesMask: texture(masks.lakes),
      noiseTex: texture(noiseTexture),
      
      // Time for animated foam
      time: uniform(0),
    })
    
    // Override fragment shader to include masking
    material.fragmentNode = this.createMaskedFragment()
  }
  
  createMaskedFragment() {
    return wgslFn(`
    fn fragment(input: VertexOutput) -> @location(0) vec4f {
        let worldPos = input.worldPosition.xyz;
        
        // Check if this pixel should be water
        let waterMask = sampleWaterMask(worldPos);
        if (waterMask < 0.5) {
            discard; // This pixel is on land
        }
        
        // Get existing IFFT ocean color
        let oceanColor = computeIFFTOcean(input);
        
        // Add Sebastian Lague style foam
        let foamMask = computeFoamMask(worldPos, time);
        let foamColor = vec3f(1.0, 1.0, 1.0);
        
        // Blend ocean and foam
        let finalColor = mix(oceanColor.rgb, foamColor, foamMask);
        
        return vec4f(finalColor, oceanColor.a);
    }
    `)()
  }
}
```

### Phase 4: Integration with Existing Ocean System

```typescript
// packages/ocean-ifft/src/r3f/MaskedOceanChunks.tsx
import { useEffect, useState } from 'react'
import { GlobalMaskProvider } from '../masking/GlobalMaskProvider'

interface MaskedOceanChunksProps {
  waveGenerator: any
  atmosphereContext?: any
}

export default function MaskedOceanChunks({ 
  waveGenerator, 
  atmosphereContext 
}: MaskedOceanChunksProps) {
  const [maskProvider, setMaskProvider] = useState<GlobalMaskProvider>()
  
  useEffect(() => {
    const provider = new GlobalMaskProvider()
    provider.loadMasks().then(() => {
      setMaskProvider(provider)
    })
  }, [])
  
  if (!maskProvider || !waveGenerator) return null
  
  return (
    <OceanChunks 
      waveGenerator={waveGenerator}
      atmosphereContext={atmosphereContext}
      maskProvider={maskProvider} // Pass masks to ocean chunks
    />
  )
}
```

### Phase 5: Ocean Chunks Integration

```typescript
// Modify packages/ocean-ifft/src/r3f/OceanChunks.tsx
export default function OceanChunks({
  waveGenerator,
  atmosphereContext,
  maskProvider // New prop
}: OceanChunksProps) {
  
  useEffect(() => {
    if (waveGenerator && maskProvider) {
      // Create masked ocean material instead of default
      const maskedMaterial = new MaskedOceanMaterial(maskProvider, waveGenerator)
      
      // Pass to ocean manager
      oceanManager.setMaterial(maskedMaterial)
    }
  }, [waveGenerator, maskProvider])
  
  // Rest of existing logic...
}
```

### Phase 6: Performance Optimizations

```typescript
// packages/ocean-ifft/src/masking/MaskLODProvider.ts
export class MaskLODProvider {
  // Use different resolution masks based on distance
  getMaskForDistance(distance: number) {
    if (distance > 50000) {
      return this.globalMask // 16x8 low res for distant viewing
    } else {
      return this.coastlineMask // Full resolution for close viewing
    }
  }
  
  // Precompute common UV lookups
  createUVLookupTable(bounds: GeographicBounds) {
    // Cache UV coordinates for tile boundaries
  }
}
```

## Integration with Existing Stories

### Update Ocean Stories
```typescript
// storybook-webgpu/src/ocean/Ocean-Basic-Story.tsx
import { MaskedOceanChunks } from '@three-geospatial/ocean-ifft'

export default function OceanBasicStory() {
  return (
    <>
      <WaveGenerator onInitialized={setWaveGenerator} />
      {waveGenerator && (
        <MaskedOceanChunks  // Replace OceanChunks
          waveGenerator={waveGenerator} 
          atmosphereContext={context} 
        />
      )}
    </>
  )
}
```

## File Structure

```
packages/ocean-ifft/
├── assets/
│   └── masks/
│       ├── coastline_raster.png
│       ├── shore_distance.png
│       ├── lakes.jpg
│       └── global_mask_16x8.png
├── src/
│   ├── masking/
│   │   ├── GlobalMaskProvider.ts
│   │   ├── MaskLODProvider.ts
│   │   └── index.ts
│   ├── materials/
│   │   ├── MaskedOceanMaterial.ts
│   │   └── globalMaskSampling.wgsl
│   └── r3f/
│       ├── MaskedOceanChunks.tsx
│       └── index.ts (updated exports)
```

## Testing Plan

1. **Mask Loading**: Verify all textures load correctly with proper UV mapping
2. **Coastline Accuracy**: Test against known coastlines (UK, Japan, etc.)
3. **Foam Effects**: Verify foam appears near shores and fades with distance
4. **Performance**: Ensure no significant FPS impact with mask sampling
5. **Integration**: Test with atmosphere and post-processing pipeline

## Expected Results

- **Realistic Coastlines**: Ocean only renders where masks indicate water
- **Dynamic Foam**: Shore-distance based foam generation like Sebastian Lague
- **Global Coverage**: Works anywhere on Earth with provided masks
- **Performance**: Efficient texture sampling with LOD system
- **Integration**: Seamless with existing IFFT ocean and atmosphere systems

This approach leverages Sebastian Lague's proven masking data while adapting it to the three-geospatial WebGPU architecture.