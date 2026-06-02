# Ocean Shader System Reference

## Overview

The ocean system is a **WebGPU-based IFFT (Inverse Fast Fourier Transform) ocean implementation** that creates realistic ocean waves using statistical wave simulation. It's currently implemented as a prototype in the `@three-geospatial/ocean-ifft` package.

## Architecture

### Two-Layer System
- **WaveGenerator** (`wave-generator.js`): Generates wave data using IFFT computations
- **OceanChunks** (`ocean.js`): Renders ocean surface using generated wave data as displacement maps

### Multi-Cascade Wave System
The system uses **3 wave cascades** with different length scales to simulate waves at multiple frequencies:
- **Cascade 0**: Large waves (low frequency)  
- **Cascade 1**: Medium waves  
- **Cascade 2**: Small waves/ripples (high frequency)

Each cascade generates:
- **Displacement texture**: Height and horizontal displacement
- **Derivative texture**: Surface derivatives for normal calculation
- **Jacobian texture**: Wave breaking detection for foam

### Quadtree-Based LOD System
- Ocean surface divided into chunks organized in a quadtree
- Level-of-detail (LOD) morphing based on distance from camera
- Prevents tessellation popping as camera moves
- Configurable via constants in `ocean-constants.js`

## Key Components

### Wave Generation (`src/waves/wave-generator.js`)
```javascript
// Key properties
this.size = wave_constants.IFFT_RESOLUTION;  // Texture resolution (512x512)
this.cascades = [];  // Array of 3 WaveCascade instances
this.butterflyBuffer = new THREE.StorageBufferAttribute();  // IFFT optimization
```

**Responsibilities:**
- Computes initial wave spectrum based on Phillips spectrum
- Uses WebGPU compute shaders for IFFT calculations
- Generates displacement, derivative, and Jacobian textures for each cascade
- Butterfly texture for IFFT optimization
- GUI controls for wave parameters

### Ocean Material (`src/ocean/ocean-material.js`)
```javascript
// Material inputs from cascades
displacement0: texture(params.cascades[0].displacement),
displacement1: texture(params.cascades[1].displacement),
displacement2: texture(params.cascades[2].displacement),
derivatives0: texture(params.cascades[0].derivative),
derivatives1: texture(params.cascades[1].derivative),
derivatives2: texture(params.cascades[2].derivative),
```

**Features:**
- WebGPU node-based material system (Three.js TSL)
- Combines displacement textures from all cascades
- Environmental reflections via cube maps
- Foam generation based on Jacobian determinant
- Sun positioning integration

### Vertex Shader (`resources/shader/ocean/vertexStageWGSL.js`)

**Key Functions:**
```wgsl
fn WGSLPosition(
    displacement0: texture_2d<f32>,
    displacement1: texture_2d<f32>, 
    displacement2: texture_2d<f32>,
    // ... other params
) -> vec4<f32>
```

**Processing Pipeline:**
1. **Morphing**: `getMorphValue()` - Smooth LOD transitions to prevent popping
2. **Vertex Morphing**: `morphVertex()` - Grid vertex interpolation
3. **Displacement**: `InterpolateBilinear()` - Samples IFFT textures to displace vertices
4. **Cascade Blending**: Combines three wave scales with distance-based LOD

**Critical Features:**
- Custom bilinear interpolation with texture wrapping
- Distance-based cascade LOD scaling
- Position clamping to prevent precision issues

### Fragment Shader (`resources/shader/ocean/fragmentStageWGSL.js`)

**Key Function:**
```wgsl
fn WGSLColor(
    // ... many parameters including textures and lighting
) -> vec4<f32>
```

**Rendering Pipeline:**
1. **Normal Calculation**: Derives surface normals from derivative textures
2. **Lighting Calculation**:
   - Fresnel reflections: `fresnelSchlick()`
   - Specular highlights: `specularLight2()`
   - Environmental reflections from cube map
3. **Foam Rendering**: Based on wave breaking (Jacobian < threshold)
4. **Atmospheric Integration**: Distance-based fog and atmospheric scattering

**Constants:**
```wgsl
const SKYCOLOR: vec3<f32> = vec3<f32>(0.196, 0.588, 0.785);
const SEACOLOR: vec3<f32> = vec3<f32>(0.004, 0.016, 0.047);
const WAVECOLOR: vec3<f32> = vec3<f32>(0.14, 0.25, 0.18);
```

## Rendering Pipeline

1. **Wave Simulation**: IFFT compute shaders generate displacement/derivative textures
2. **Quadtree Update**: Camera-based LOD calculation and chunk culling  
3. **Vertex Processing**: Displacement mapping with LOD morphing
4. **Fragment Rendering**: PBR-style water shading with environmental reflections
5. **Post-Processing**: Atmospheric perspective and tone mapping

## Integration Points

### Atmosphere System Integration
```typescript
// From OceanChunks component
atmosphereContext?: AtmosphereContextNode | null

// Usage in frame loop
worldSun
  .copy(atmosphereContext.sunDirectionECEF.value)
  .applyMatrix4(matrixECEFToWorld)
  .normalize()
oceanManagerRef.current.SetSunDirection?.(worldSun)
```

**Features:**
- Uses `AtmosphereContextNode` for sun/moon positioning
- Atmospheric scattering via `aerialPerspective` 
- Environmental reflections from sky dome
- Automatic sun direction updates

### Coordinate System Integration

**Flat Ocean Mode:**
- Simple plane with camera controls
- Used in `Ocean-Basic-Story.tsx`

**Globe Mode:**
- Ocean patches positioned on Earth's surface using ECEF coordinates
- East-North-Up (ENU) frame calculation
- Used in `Ocean-Globe-Patch.tsx`

```typescript
// Globe positioning example
const geodetic = new Geodetic(radians(longitude), radians(latitude), height)
const position = geodetic.toECEF()
const basis = new Matrix4()
Ellipsoid.WGS84.getEastNorthUpFrame(position, basis)
```

## File Structure

```
packages/ocean-ifft/
├── src/
│   ├── r3f/                    # React Three Fiber components
│   │   ├── WaveGenerator.tsx   # Wave generation wrapper
│   │   └── OceanChunks.tsx     # Ocean rendering wrapper
│   ├── waves/                  # Wave simulation core
│   │   ├── wave-generator.js   # Main wave generator
│   │   ├── wave-cascade.js     # Individual cascade
│   │   └── wave-constants.js   # Wave parameters
│   ├── ocean/                  # Ocean rendering core
│   │   ├── ocean.js           # Chunk management
│   │   ├── ocean-material.js  # WebGPU material
│   │   └── quadtree.js        # LOD system
│   └── materials/              # Additional materials
├── resources/
│   └── shader/
│       ├── IFFT/              # IFFT compute shaders
│       └── ocean/             # Ocean vertex/fragment shaders
└── components/                # Legacy React components
```

## Usage Patterns

### Basic Setup
```typescript
// In React component
const [waveGenerator, setWaveGenerator] = useState<any>(null)

return (
  <>
    <WaveGenerator onInitialized={setWaveGenerator} />
    {waveGenerator && (
      <OceanChunks 
        waveGenerator={waveGenerator} 
        atmosphereContext={context} 
      />
    )}
  </>
)
```

### Configuration
Wave parameters are controlled via:
- `wave-constants.js`: Default values and ranges
- GUI controls: Runtime parameter adjustment
- Presets: `presets/ocean/` JSON files

### Performance Considerations
- IFFT resolution affects quality vs performance (`IFFT_RESOLUTION`)
- Cascade count affects realism vs performance (currently 3)
- Quadtree depth affects LOD granularity
- Distance-based LOD reduces vertex count at distance

## Current Status

**Prototype State:**
- Core functionality implemented and working
- JS codebase (not TypeScript yet)
- WebGPU-only (no WebGL fallback)
- Integrated with atmosphere system

**Known Limitations:**
- Legacy JS codebase with `any` types in TypeScript wrappers
- Manual coordinate system setup for globe mode
- Limited foam quality at distance
- Performance not optimized for mobile

**Future Improvements:**
- TypeScript migration
- Better foam rendering
- Dynamic cascade wavelengths
- Mobile optimization
- WebGL fallback option