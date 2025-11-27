# Dual Sphere Ocean Implementation Plan

## Overview

This plan implements ocean rendering using a dual sphere architecture: one sphere for terrain (Google 3D tiles) and one for ocean (IFFT ocean chunks), leveraging Sebastian Lague's raster masks for water/land boundaries.

**Success Estimate: 85-90%** - Building on existing proven systems.

## Architecture Design

### Dual Sphere Setup
```
Terrain Sphere: radius = 6371000m (Earth)
Ocean Sphere:   radius = 6371001m (Earth + 1m offset)
```

### Component Structure
```typescript
<Scene>
  {/* Existing terrain rendering */}
  <TilesRenderer>  
    <Globe apiKey={googleKey} />
  </TilesRenderer>
  
  {/* New ocean rendering */}
  <OceanSphereRenderer radius={EARTH_RADIUS + 1}>
    <OceanTileProvider maskProvider={sebastianLagueMasks} />
    <OceanChunks waveGenerator={waveGenerator} />
  </OceanSphereRenderer>
</Scene>
```

## Implementation Plan

### Phase 1: Spherical Ocean Chunks (Week 1)

#### 1.1: Create Spherical Coordinate Utilities
```typescript
// packages/ocean-ifft/src/coordinates/SphericalMapping.ts
import { Ellipsoid, Geodetic } from '@takram/three-geospatial'

export class SphericalMapping {
  static readonly OCEAN_RADIUS = 6371001 // Earth radius + 1m
  
  // Convert tile coordinates to geographic bounds
  static tileToGeographicBounds(x: number, y: number, z: number): GeographicBounds {
    // Use same tile projection as Google 3D tiles (Web Mercator)
    const n = Math.pow(2, z)
    const lonLeft = (x / n) * 360 - 180
    const lonRight = ((x + 1) / n) * 360 - 180
    const latTop = this.tile2lat(y, z)
    const latBottom = this.tile2lat(y + 1, z)
    
    return { lonLeft, lonRight, latTop, latBottom }
  }
  
  // Create spherical quad geometry for tile
  static createSphericalTileGeometry(
    bounds: GeographicBounds, 
    resolution: number = 32
  ): THREE.BufferGeometry {
    const positions: number[] = []
    const indices: number[] = []
    const uvs: number[] = []
    
    // Generate grid points on sphere surface
    for (let i = 0; i <= resolution; i++) {
      for (let j = 0; j <= resolution; j++) {
        const u = i / resolution
        const v = j / resolution
        
        // Interpolate within tile bounds
        const lon = bounds.lonLeft + (bounds.lonRight - bounds.lonLeft) * u
        const lat = bounds.latTop + (bounds.latBottom - bounds.latTop) * v
        
        // Convert to sphere surface position
        const geodetic = new Geodetic(lon * Math.PI/180, lat * Math.PI/180, 0)
        const cartesian = Ellipsoid.WGS84.geodeticToCartesian(geodetic)
        cartesian.normalize().multiplyScalar(this.OCEAN_RADIUS)
        
        positions.push(cartesian.x, cartesian.y, cartesian.z)
        uvs.push(u, v)
      }
    }
    
    // Generate triangle indices
    for (let i = 0; i < resolution; i++) {
      for (let j = 0; j < resolution; j++) {
        const a = i * (resolution + 1) + j
        const b = a + 1
        const c = (i + 1) * (resolution + 1) + j
        const d = c + 1
        
        indices.push(a, b, c, b, d, c)
      }
    }
    
    const geometry = new THREE.BufferGeometry()
    geometry.setIndex(indices)
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.computeVertexNormals()
    
    return geometry
  }
}
```

#### 1.2: Modify Existing Ocean Chunk Manager
```typescript
// packages/ocean-ifft/src/ocean/spherical-ocean.js
import { SphericalMapping } from '../coordinates/SphericalMapping'

class SphericalOceanChunkManager extends OceanChunkManager {
  
  CreateOceanChunk(group, groupTransform, offset, width, resolution, lod) {
    // Convert flat ocean chunk to spherical tile
    const tileCoords = this.offsetToTileCoords(offset, lod)
    const bounds = SphericalMapping.tileToGeographicBounds(
      tileCoords.x, 
      tileCoords.y, 
      tileCoords.z
    )
    
    // Create spherical geometry instead of flat plane
    const geometry = SphericalMapping.createSphericalTileGeometry(bounds, resolution)
    
    // Use existing ocean material with IFFT
    const mesh = new THREE.Mesh(geometry, this.material_)
    mesh.position.copy(offset)
    
    // Add to group (same as existing system)
    group.add(mesh)
    
    return {
      mesh,
      bounds,
      lod
    }
  }
  
  // Convert flat offset to spherical tile coordinates
  offsetToTileCoords(offset, lod) {
    // Map flat quadtree offset to spherical tile system
    // This ensures existing LOD behavior is preserved
    return {
      x: Math.floor(offset.x / this.tileSize + this.worldCenter.x),
      y: Math.floor(offset.z / this.tileSize + this.worldCenter.z), 
      z: lod
    }
  }
}
```

### Phase 2: Ocean Sphere Renderer (Week 1-2)

#### 2.1: Create OceanSphereRenderer Component
```typescript
// packages/ocean-ifft/src/r3f/OceanSphereRenderer.tsx
import { useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { SphericalOceanChunkManager } from '../ocean/spherical-ocean'

interface OceanSphereRendererProps {
  radius?: number
  waveGenerator?: any
  maskProvider?: GlobalMaskProvider
  children?: React.ReactNode
}

export function OceanSphereRenderer({ 
  radius = SphericalMapping.OCEAN_RADIUS,
  waveGenerator,
  maskProvider,
  children 
}: OceanSphereRendererProps) {
  const { scene, camera, gl } = useThree()
  const oceanManagerRef = useRef<SphericalOceanChunkManager>()
  
  useEffect(() => {
    if (!waveGenerator) return
    
    // Create spherical ocean chunk manager
    const oceanManager = new SphericalOceanChunkManager({
      scene,
      camera,
      renderer: gl,
      waveGenerator,
      maskProvider,
      radius
    })
    
    oceanManagerRef.current = oceanManager
    
    return () => {
      oceanManager.dispose?.()
    }
  }, [waveGenerator, maskProvider, radius])
  
  useFrame(() => {
    oceanManagerRef.current?.update()
  })
  
  return (
    <group name="ocean-sphere">
      {children}
    </group>
  )
}
```

#### 2.2: Update Ocean Stories
```typescript
// storybook-webgpu/src/ocean/Ocean-Sphere-Story.tsx
import { OceanSphereRenderer } from '@three-geospatial/ocean-ifft'

const Content: FC<StoryProps> = () => {
  const [waveGenerator, setWaveGenerator] = useState<any>(null)
  const [maskProvider, setMaskProvider] = useState<GlobalMaskProvider>()
  
  // Load Sebastian Lague masks
  useEffect(() => {
    const provider = new GlobalMaskProvider()
    provider.loadMasks().then(() => setMaskProvider(provider))
  }, [])
  
  return (
    <>
      {/* Existing terrain sphere */}
      <Globe apiKey={apiKey}>
        <GlobeControls enableDamping overlayScene={overlayScene} />
      </Globe>
      
      {/* New ocean sphere */}
      <WaveGenerator onInitialized={setWaveGenerator} />
      {waveGenerator && maskProvider && (
        <OceanSphereRenderer 
          waveGenerator={waveGenerator}
          maskProvider={maskProvider}
        />
      )}
    </>
  )
}
```

### Phase 3: Sebastian Lague Mask Integration (Week 2)

#### 3.1: Download Sebastian Lague Masks
```bash
# Create assets directory
mkdir -p packages/ocean-ifft/assets/masks

# Download masks (update URLs to actual raw files)
curl -o packages/ocean-ifft/assets/masks/coastline_raster.png \
  "https://raw.githubusercontent.com/SebLague/Geographical-Adventures/main/Assets/Data/Mask/Coastline%20Raster.png"

curl -o packages/ocean-ifft/assets/masks/shore_distance.png \
  "https://raw.githubusercontent.com/SebLague/Geographical-Adventures/main/Assets/Data/Mask/Shore%20Dst.png"

curl -o packages/ocean-ifft/assets/masks/lakes.jpg \
  "https://raw.githubusercontent.com/SebLague/Geographical-Adventures/main/Assets/Data/Mask/Lakes.jpg"
```

#### 3.2: Create Global Mask Provider
```typescript
// packages/ocean-ifft/src/masking/GlobalMaskProvider.ts
export class GlobalMaskProvider {
  private coastlineMask?: THREE.Texture
  private shoreDistanceMask?: THREE.Texture
  private lakesMask?: THREE.Texture
  
  async loadMasks(): Promise<void> {
    const loader = new THREE.TextureLoader()
    
    this.coastlineMask = await loader.loadAsync('/assets/masks/coastline_raster.png')
    this.shoreDistanceMask = await loader.loadAsync('/assets/masks/shore_distance.png')
    this.lakesMask = await loader.loadAsync('/assets/masks/lakes.jpg')
    
    // Configure for proper sampling
    [this.coastlineMask, this.shoreDistanceMask, this.lakesMask].forEach(texture => {
      texture.wrapS = THREE.ClampToEdgeWrapping
      texture.wrapT = THREE.ClampToEdgeWrapping
      texture.magFilter = THREE.LinearFilter
      texture.minFilter = THREE.LinearFilter
    })
  }
  
  // Check if tile bounds contain water
  hasWaterInBounds(bounds: GeographicBounds): boolean {
    // Sample mask at tile corners and center
    const samplePoints = [
      { lon: bounds.lonLeft, lat: bounds.latTop },
      { lon: bounds.lonRight, lat: bounds.latTop },
      { lon: bounds.lonLeft, lat: bounds.latBottom },
      { lon: bounds.lonRight, lat: bounds.latBottom },
      { lon: (bounds.lonLeft + bounds.lonRight) / 2, lat: (bounds.latTop + bounds.latBottom) / 2 }
    ]
    
    return samplePoints.some(point => {
      const uv = this.geographicToUV(point.lon, point.lat)
      return this.sampleWaterMask(uv) > 0.1
    })
  }
  
  private geographicToUV(longitude: number, latitude: number): THREE.Vector2 {
    const u = (longitude + 180) / 360
    const v = 1.0 - (latitude + 90) / 180
    return new THREE.Vector2(u, v)
  }
  
  private sampleWaterMask(uv: THREE.Vector2): number {
    // This would need CPU-side texture sampling for tile culling
    // For now, return true for all tiles - implement proper sampling later
    return 1.0
  }
  
  getMasks() {
    return {
      coastline: this.coastlineMask,
      shoreDistance: this.shoreDistanceMask,
      lakes: this.lakesMask
    }
  }
}
```

#### 3.3: Add Mask-Based Tile Culling
```typescript
// Modify SphericalOceanChunkManager
class SphericalOceanChunkManager extends OceanChunkManager {
  constructor(params) {
    super(params)
    this.maskProvider = params.maskProvider
  }
  
  CreateOceanChunk(group, groupTransform, offset, width, resolution, lod) {
    const tileCoords = this.offsetToTileCoords(offset, lod)
    const bounds = SphericalMapping.tileToGeographicBounds(
      tileCoords.x, tileCoords.y, tileCoords.z
    )
    
    // Check if this tile should have water using Sebastian Lague masks
    if (this.maskProvider && !this.maskProvider.hasWaterInBounds(bounds)) {
      return null // Skip this tile - no water here
    }
    
    // Create ocean geometry (existing logic)
    const geometry = SphericalMapping.createSphericalTileGeometry(bounds, resolution)
    const mesh = new THREE.Mesh(geometry, this.material_)
    
    group.add(mesh)
    return { mesh, bounds, lod }
  }
}
```

### Phase 4: Coastline Trimming and Foam (Week 3)

#### 4.1: Add Mask Sampling to Ocean Material
```typescript
// Modify packages/ocean-ifft/src/ocean/ocean-material.js
class OceanMaterial extends entity.Component {
  Init(params) {
    // Existing IFFT material setup...
    
    // Add Sebastian Lague masks
    const masks = params.maskProvider?.getMasks()
    if (masks) {
      this.wgslShaderParams = {
        ...this.wgslShaderParams,
        coastlineMask: texture(masks.coastline),
        shoreDistanceMask: texture(masks.shoreDistance),
        lakesMask: texture(masks.lakes)
      }
    }
    
    // Update vertex and fragment shaders
    this.oceanMaterial = new MeshPhysicalNodeMaterial()
    this.oceanMaterial.positionNode = this.createMaskedVertexShader()
    this.oceanMaterial.colorNode = this.createMaskedFragmentShader()
  }
  
  createMaskedVertexShader() {
    return wgslFn(`
      fn maskedOceanVertex(position: vec3f) -> vec4f {
        // Convert world position to geographic UV
        let worldPos = (modelMatrix * vec4f(position, 1.0)).xyz;
        let uv = worldToGeographicUV(worldPos);
        
        // Sample water mask
        let waterMask = textureSample(coastlineMask, sampler, uv).r;
        let lakesMask = textureSample(lakesMask, sampler, uv).r;
        let isWater = max(waterMask, lakesMask);
        
        // If not water, hide vertex below terrain
        if (isWater < 0.5) {
          return vec4f(worldPos.x, -1000.0, worldPos.z, 1.0); // Hide below terrain
        }
        
        // Apply existing IFFT displacement
        return applyIFFTDisplacement(worldPos);
      }
    `)()
  }
  
  createMaskedFragmentShader() {
    return wgslFn(`
      fn maskedOceanFragment(worldPos: vec3f) -> vec4f {
        let uv = worldToGeographicUV(worldPos);
        
        // Sample masks
        let waterMask = textureSample(coastlineMask, sampler, uv).r;
        let shoreDistance = textureSample(shoreDistanceMask, sampler, uv).r;
        
        if (waterMask < 0.5) {
          discard; // Not water
        }
        
        // Existing IFFT ocean color
        let oceanColor = computeIFFTOcean(worldPos);
        
        // Sebastian Lague foam effect
        let foamMask = computeSebLagueFoam(worldPos, shoreDistance);
        let foamColor = vec3f(1.0);
        
        return vec4f(mix(oceanColor.rgb, foamColor, foamMask), 1.0);
      }
    `)()
  }
}
```

### Phase 5: Integration and Testing (Week 4)

#### 5.1: Update Ocean Stories
```typescript
// Test dual sphere in all ocean stories
// storybook-webgpu/src/ocean/Ocean-Dual-Sphere.stories.tsx

export default {
  title: 'ocean/Ocean Dual Sphere (WebGPU)',
  parameters: {
    docs: {
      description: {
        story: 'Ocean sphere rendering with Sebastian Lague masks over Google 3D tiles'
      }
    }
  }
} satisfies Meta

export const DualSphere = createStory(DualSphereStory, {
  parameters: {
    docs: {
      description: {
        story: 'Complete dual sphere setup with terrain and ocean'
      }
    }
  }
})
```

#### 5.2: Performance Optimization
```typescript
// Add LOD controls for ocean sphere
const oceanLODController = {
  getOceanLOD(distance: number): number {
    if (distance > 100000) return 1 // Low detail for space view
    if (distance > 10000) return 3  // Medium detail for aerial view  
    return 5 // High detail for ground view
  }
}
```

## File Structure

```
packages/ocean-ifft/
├── assets/
│   └── masks/
│       ├── coastline_raster.png
│       ├── shore_distance.png
│       └── lakes.jpg
├── src/
│   ├── coordinates/
│   │   └── SphericalMapping.ts
│   ├── masking/
│   │   └── GlobalMaskProvider.ts
│   ├── ocean/
│   │   └── spherical-ocean.js
│   └── r3f/
│       ├── OceanSphereRenderer.tsx
│       └── index.ts
├── storybook-webgpu/src/ocean/
│   └── Ocean-Dual-Sphere.stories.tsx
```

## Success Metrics

- ✅ Ocean renders as sphere above terrain sphere
- ✅ Sebastian Lague masks prevent ocean on land
- ✅ Existing IFFT waves work on spherical surface
- ✅ Performance maintains 60fps at ground level
- ✅ No Z-fighting between spheres
- ✅ Atmosphere integration preserved
- ✅ Coastline foam effects working

## Risk Mitigation

**Low Risk Items:**
- Spherical coordinate conversion (well-established math)
- Reusing existing ocean chunk system
- Sebastian Lague masks (proven data)

**Medium Risk Items:**
- CPU-side mask sampling for tile culling (solvable with WebGL readback)
- Sphere tile seaming (addressable with existing techniques)

**Contingency Plans:**
- If mask culling performance is poor: start with all tiles, optimize later
- If seaming issues: use existing tile padding techniques from 3D tiles
- If IFFT doesn't work on sphere: fall back to simpler wave equations

This plan leverages existing working systems with minimal new complexity, giving the highest probability of success.