// Carbon copy of the ocean material composition from WaterproAtmosphere-
// Story.tsx, factored out so the chunk story (GlobeWaterproOcean) and the
// flat-plane story share the EXACT same fragment graph + uniforms wiring.
// The only inputs that vary per caller are the vertex displacement (TSL
// expression for the plane, WGSL vertex stage for chunks) and the cascade
// fragment-UV source (world XZ for plane; ocean-local XZ for chunks).

import type { CubeTexture, Texture } from 'three'
import { DoubleSide, SRGBColorSpace, Vector2, Vector3, Vector4 } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { UniformNode } from 'three/webgpu'
import {
  cameraPosition,
  cubeTexture,
  dot,
  exp,
  float,
  max,
  min,
  mix,
  modelWorldMatrix,
  reflect as tslReflect,
  saturate,
  smoothstep,
  texture as tslTexture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Node } from 'three/webgpu'

import {
  combineFoamNode,
  fresnelDistanceNode,
  GerstnerOverlay,
  sampleWaveDisplacement,
  sampleWaveNormal,
  shorelineFoamNode,
  sparkleNode,
  subSurfaceScatteringNode,
  surfaceFoamNode,
  turbulentFoamNode,
  waterColorNode,
  waveFoamNode,
  WaveSimulation,
} from '../../../packages/ocean-ifft/src/waterpro/index.js'

// ─── Uniform bag ───────────────────────────────────────────────────────────
// Mirror of the `u` object in WaterproAtmosphere-Story.tsx:307-384. Caller
// builds with createWaterproOceanUniforms() and mutates per-frame /
// per-slider. The shared material composition reads from this bag.

export interface WaterproOceanUniforms {
  skyReflectionOn: UniformNode<number>
  skyReflectionColor: UniformNode<Vector3>
  skyReflectionExposure: UniformNode<number>
  skyReflectionScale: UniformNode<number>
  sssOn: UniformNode<number>
  sparkleOn: UniformNode<number>
  surfaceFoamOn: UniformNode<number>
  waveFoamOn: UniformNode<number>
  turbulentFoamOn: UniformNode<number>
  shorelineFoamOn: UniformNode<number>
  fftAmplitude: UniformNode<number>
  gerstnerAmplitude: UniformNode<number>
  fresnelPower: UniformNode<number>
  fresnelNormalStrength: UniformNode<number>
  sparkleIntensity: UniformNode<number>
  sparkleFocusPower: UniformNode<number>
  sssIntensity: UniformNode<number>
  sssPower: UniformNode<number>
  surfaceFoamColor: UniformNode<Vector3>
  surfaceFoamCoverage: UniformNode<number>
  surfaceFoamOpacity: UniformNode<number>
  surfaceFoamSize: UniformNode<number>
  // Large-scale region mask that gates surface foam on/off in drifting
  // blobs. Enabled=0 → mask=1 everywhere (legacy uniform tiling). Drift
  // is in tex/s of the region tile (~0.0005 × 1500m ≈ 0.75 m/s).
  surfaceFoamRegionEnabled: UniformNode<number>
  surfaceFoamRegionScale: UniformNode<number>
  surfaceFoamRegionThreshold: UniformNode<number>
  surfaceFoamRegionDrift: UniformNode<number>
  waveFoamColor: UniformNode<Vector3>
  waveFoamCoverage: UniformNode<number>
  waveFoamOpacity: UniformNode<number>
  waveFoamCrestCoverage: UniformNode<number>
  waveFoamPeakIntensity: UniformNode<number>
  waveFoamRippleWeight: UniformNode<number>
  waveFoamWaveWeight: UniformNode<number>
  waveFoamWindBias: UniformNode<number>
  waveFoamWindStretch: UniformNode<number>
  waveFoamSize: UniformNode<number>
  shorelineFoamColor: UniformNode<Vector3>
  shorelineFoamCoverage: UniformNode<number>
  shorelineFoamOpacity: UniformNode<number>
  shorelineFoamRange: UniformNode<number>
  shorelineFoamSize: UniformNode<number>
  shorelineBandRange: UniformNode<number>
  shorelineBandCoverage: UniformNode<number>
  shorelineBandOpacity: UniformNode<number>
  shorelineTintRange: UniformNode<number>
  shorelineTintCoverage: UniformNode<number>
  shorelineTintOpacity: UniformNode<number>
  turbulentIntensity: UniformNode<number>
  shallowColor: UniformNode<Vector3>
  deepColor: UniformNode<Vector3>
  transmissionColor: UniformNode<Vector3>
  depthFalloff: UniformNode<number>
  waterDepth: UniformNode<number>
  fadeStart: UniformNode<number>
  fadeEnd: UniformNode<number>
  fadePower: UniformNode<number>
  // ─ Tip foam ────────────────────────────────────────────────────────────
  // Additional foam layer that fires on actual visible wave-tip height.
  // Gated by both a height threshold AND a sparse rarity mask so foam only
  // appears on *some* peaks, not every one. Independent of the eigen-based
  // wave-foam crest detector.
  tipFoamEnabled: UniformNode<number>
  tipFoamIntensity: UniformNode<number>
  tipFoamHeightThreshold: UniformNode<number>
  tipFoamSoftness: UniformNode<number>
  tipFoamSize: UniformNode<number>
  /** 0 = foam on every qualifying peak, 1 = foam essentially nowhere. */
  tipFoamRarity: UniformNode<number>
  tipFoamColor: UniformNode<Vector3>
}

export function createWaterproOceanUniforms(): WaterproOceanUniforms {
  // Defaults copied verbatim from WaterproAtmosphere-Story.tsx:307-384.
  return {
    skyReflectionOn: uniform(1.0),
    skyReflectionColor: uniform(new Vector3(0.3, 0.5, 0.8)),
    skyReflectionExposure: uniform(0.2),
    skyReflectionScale: uniform(1.0),
    sssOn: uniform(1.0),
    sparkleOn: uniform(1.0),
    surfaceFoamOn: uniform(1.0),
    waveFoamOn: uniform(1.0),
    turbulentFoamOn: uniform(1.0),
    shorelineFoamOn: uniform(1.0),
    fftAmplitude: uniform(1.0),
    gerstnerAmplitude: uniform(1.0),
    fresnelPower: uniform(3.0),
    fresnelNormalStrength: uniform(0.1),
    sparkleIntensity: uniform(1.5),
    sparkleFocusPower: uniform(75.7),
    sssIntensity: uniform(0.5),
    sssPower: uniform(16.0),
    surfaceFoamColor: uniform(new Vector3(1, 1, 1)),
    surfaceFoamCoverage: uniform(0.02),
    surfaceFoamOpacity: uniform(0.25),
    surfaceFoamSize: uniform(20.0),
    surfaceFoamRegionEnabled: uniform(1.0),
    surfaceFoamRegionScale: uniform(1500.0),
    surfaceFoamRegionThreshold: uniform(0.5),
    surfaceFoamRegionDrift: uniform(0.0005),
    waveFoamColor: uniform(new Vector3(1, 1, 1)),
    waveFoamCoverage: uniform(0.5),
    waveFoamOpacity: uniform(0.6),
    waveFoamCrestCoverage: uniform(0.3),
    waveFoamPeakIntensity: uniform(1.0),
    waveFoamRippleWeight: uniform(1.0),
    waveFoamWaveWeight: uniform(1.0),
    waveFoamWindBias: uniform(0.8),
    waveFoamWindStretch: uniform(0.5),
    waveFoamSize: uniform(20.0),
    shorelineFoamColor: uniform(new Vector3(1, 1, 1)),
    shorelineFoamCoverage: uniform(0.5),
    shorelineFoamOpacity: uniform(1.0),
    shorelineFoamRange: uniform(2.0),
    shorelineFoamSize: uniform(50.0),
    shorelineBandRange: uniform(2.0),
    shorelineBandCoverage: uniform(0.5),
    shorelineBandOpacity: uniform(1.0),
    shorelineTintRange: uniform(30.0),
    shorelineTintCoverage: uniform(0.5),
    shorelineTintOpacity: uniform(0.3),
    turbulentIntensity: uniform(0.2),
    shallowColor: uniform(new Vector3(0, 0.8, 0.8)),
    deepColor: uniform(new Vector3(0, 0.2, 0.4)),
    transmissionColor: uniform(new Vector3(0, 1, 0.8)),
    depthFalloff: uniform(50.0),
    waterDepth: uniform(20.0),
    fadeStart: uniform(50.0),
    fadeEnd: uniform(200.0),
    fadePower: uniform(1.0),
    tipFoamEnabled: uniform(1.0),
    tipFoamIntensity: uniform(1.0),
    tipFoamHeightThreshold: uniform(0.6),
    tipFoamSoftness: uniform(0.4),
    tipFoamSize: uniform(8.0),
    tipFoamRarity: uniform(0.65),
    tipFoamColor: uniform(new Vector3(1, 1, 1)),
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

export interface BuildWaterproOceanMaterialParams {
  waveSim: WaveSimulation
  gerstner: GerstnerOverlay
  u: WaterproOceanUniforms
  gerstnerTime: UniformNode<number>
  sunDirUniform: UniformNode<Vector3>
  sunDirLightUniform: UniformNode<Vector3>
  sunIntensityUniform: UniformNode<number>
  depthTexture: Texture
  depthTextureEnabled: Node | UniformNode<number>
  /** Live atmosphere sky cube — `envNode.renderTarget.texture`. */
  envCubeTexture: CubeTexture
  foamTexture: Texture

  /**
   * Vertex displacement node — set as `material.positionNode`. For the plane,
   * this is the TSL expression `localPos + ifftDisp + gerstnerDispVtx`. For
   * chunks, it's the WGSL vertex stage that does morph + IFFT + Gerstner
   * internally.
   */
  positionNode: Node | Node

  /**
   * Cascade fragment-UV source — read by the fragment graph to sample wave
   * normals / Jacobian / foam textures. For the flat plane this is
   * `vec2(displacedWorld4.x, displacedWorld4.z)` (equivalent to local because
   * the plane is at world origin). For chunks at ECEF, world coords lose
   * float32 precision (~6.37×10⁶ m / cascade-length-meters hashes adjacent
   * fragments to identical UV → single solid color), so chunks pass the
   * vDisplacedPosition varying directly (ocean-local frame). This is the one
   * place where chunks cannot be a literal carbon copy of the plane wiring.
   */
  fragSurfaceXZ: Node

  /**
   * World-space surface XZ — used by fresnel distance-to-camera, viewDir,
   * and SSS distance fade. These all need WORLD coordinates (because
   * cameraPosition is world). For the plane at origin this is the same as
   * fragSurfaceXZ; for chunks it differs (ocean-local vs ECEF). Passing the
   * same node for both works in the plane case, fails on chunks.
   */
  worldSurfaceXZ?: Node

  /**
   * Full world-space surface position (vec3) used for viewDir. Plane callers
   * leave undefined → viewDir uses `vec3(worldXZ.x, 0, worldXZ.y)` (Y=0 keeps
   * viewDir stable against wave-height jitter for close-camera scenes). Chunk
   * callers MUST pass the real world position — at ECEF the surface is at
   * Y ≈ 6.37×10⁶, not 0, and zeroing Y aims viewDir at Earth's centre,
   * producing a diagonal threshold-crossing in fresnel/reflection.
   */
  worldSurfacePos?: Node

  /**
   * Optional override for `oceanDepth` (view-space surface depth) when the
   * positionNode is a custom WGSL stage. TSL's `positionView` reads from the
   * raw attribute, not the displaced position, so chunks pass an explicit
   * `modelViewMatrix × vDisplaced` here. Plane passes undefined (water-color
   * uses TSL `positionView` internally).
   */
  oceanDepth?: Node
  /**
   * Optional override for `oceanPositionWorld` (used by water-column-depth's
   * grazing-angle divisor). Plane passes undefined; chunks pass
   * `modelWorldMatrix × vDisplaced`.
   */
  oceanPositionWorld?: Node

  /**
   * Optional actual surface Y (the displaced vertex height in ocean-local
   * frame). Tip foam uses this to gate on real wave height. For chunks pass
   * `vDisplaced.y` (the varying the WGSL stage writes). For the flat plane
   * caller can pass the TSL `displacedLocal.y` directly. Leaving this
   * undefined falls back to sampling the cascade displacement at the
   * fragment XZ — which is OFF by lambda chop for peaks (foam ends up
   * next to the crest, not on it).
   */
  surfaceHeight?: Node

  /**
   * Optional tileable surface position (vec3) passed to ALL foam nodes
   * (surface/wave/shoreline/turbulent) as their `oceanPositionWorld`. These
   * nodes compute foam-texture UVs as `worldXZ / size` and use `positionWorld.y`
   * for depth attenuation — at ECEF (~6.37e6 m) those formulas precision-
   * collapse to single-color tiles + invisible turbulent foam. Chunks pass
   * the ocean-local `vDisplaced` here so foam tiles at metres-not-megametres.
   * Plane callers leave this undefined → nodes use TSL `positionWorld` which
   * equals the local frame at origin → same behaviour.
   */
  tilingPosition?: Node
}

/**
 * Carbon-copy of WaterproAtmosphere-Story.tsx:547-805 material composition.
 * Same TSL graph, same envNode cube sample, same emissive / colorNode split,
 * same MeshStandardNodeMaterial flags. Two callers (atmosphere plane, chunk
 * tiles) share this exact source; the per-caller deltas are the two
 * `positionNode` / `fragSurfaceXZ` parameters above.
 */
export function buildWaterproOceanMaterial(
  params: BuildWaterproOceanMaterialParams
): MeshStandardNodeMaterial {
  const {
    waveSim,
    gerstner,
    u,
    gerstnerTime,
    sunDirUniform,
    sunDirLightUniform,
    sunIntensityUniform,
    depthTexture,
    depthTextureEnabled,
    envCubeTexture,
    foamTexture,
    positionNode,
    fragSurfaceXZ,
    worldSurfaceXZ,
    worldSurfacePos,
    oceanDepth,
    oceanPositionWorld,
    tilingPosition,
    surfaceHeight,
  } = params

  // Defaults to fragSurfaceXZ — preserves the literal plane behaviour. Chunks
  // override with the world-frame variant for fresnel/SSS distance + viewDir.
  const worldXZ = worldSurfaceXZ ?? fragSurfaceXZ

  // Fragment normals + Jacobian eigenvalues — verbatim from WaterproAtmosphere.
  const cascadeSample = sampleWaveNormal(waveSim, { worldXZ: fragSurfaceXZ })
  const gerstnerFrag = gerstner.evaluate(fragSurfaceXZ, gerstnerTime)
  const surfaceNormalLocal = vec3(
    cascadeSample.normal.x.add(gerstnerFrag.normal.x.mul(u.gerstnerAmplitude)),
    cascadeSample.normal.y.add(
      gerstnerFrag.normal.y.sub(float(1)).mul(u.gerstnerAmplitude)
    ),
    cascadeSample.normal.z.add(gerstnerFrag.normal.z.mul(u.gerstnerAmplitude))
  )
  // Cascade samples encode normals in the same frame as their sampling
  // coordinate (ocean-local for chunks, world for plane-at-origin). Lighting
  // / fresnel / reflection ops below operate in world frame (cameraPosition,
  // sunDir, etc.), so we rotate the normal by modelWorldMatrix (w=0 skips
  // translation). For the plane at world origin modelWorldMatrix is identity
  // and this collapses to a no-op — WaterproAtmosphere's tuned output is
  // preserved bit-for-bit.
  const surfaceNormal = (modelWorldMatrix as any)
    .mul(vec4(surfaceNormalLocal, float(0)))
    .xyz.normalize()
  const eigen0 = cascadeSample.eigen0.sub(
    gerstnerFrag.folding.mul(u.gerstnerAmplitude)
  )
  const eigen1 = cascadeSample.eigen1

  // Program 4 (water-color). Chunks supply oceanDepth / oceanPositionWorld
  // overrides because their custom WGSL positionNode breaks TSL's built-in
  // positionView / positionWorld; the plane lets the node use its TSL defaults.
  const { waterColor, waterColumnDepth, isObjectInFront, isDynamic } =
    waterColorNode({
      depthTexture,
      depthTextureEnabled,
      waterDepth: u.waterDepth,
      depthFalloff: u.depthFalloff,
      shallowColor: u.shallowColor,
      deepColor: u.deepColor,
      ...(oceanDepth != null ? { oceanDepth } : {}),
      ...(oceanPositionWorld != null ? { oceanPositionWorld } : {}),
    })

  // Program 5 (surface foam).
  const surfaceFoamRaw = surfaceFoamNode({
    foamTexture,
    enabled: u.surfaceFoamOn,
    size: u.surfaceFoamSize,
    coverage: u.surfaceFoamCoverage,
    opacity: u.surfaceFoamOpacity,
    foamColor: u.surfaceFoamColor,
    ...(tilingPosition != null ? { oceanPositionWorld: tilingPosition } : {}),
  })

  // Large-scale "weather" mask over the surface foam — same noise texture
  // sampled at thousands-of-metres scale and slowly drifted by gerstnerTime.
  // Near-binary smoothstep (0.02 band) so it reads as on/off blobs, not a
  // soft tile pattern. When the toggle is off, mix(1, mask, 0) = 1 so the
  // foam reverts to legacy uniform tiling.
  const surfDrift = (gerstnerTime as any).mul(u.surfaceFoamRegionDrift)
  const surfRegionUV = fragSurfaceXZ
    .div(u.surfaceFoamRegionScale)
    .add(vec2(float(0.43), float(0.91)))
    .add(vec2(surfDrift, surfDrift.mul(float(-0.7))))
  const surfRegionNoise = tslTexture(foamTexture, surfRegionUV).r
  const surfRegionMaskRaw = smoothstep(
    u.surfaceFoamRegionThreshold,
    (u.surfaceFoamRegionThreshold as any).add(float(0.02)),
    surfRegionNoise
  )
  const surfRegionMask = mix(float(1), surfRegionMaskRaw, u.surfaceFoamRegionEnabled)
  const surfaceFoam = {
    strength: (surfaceFoamRaw.strength as any).mul(surfRegionMask),
    color: surfaceFoamRaw.color,
  }

  // Program 7 (wave foam).
  const waveFoam = waveFoamNode({
    foamTexture,
    enabled: u.waveFoamOn,
    waveWeight: u.waveFoamWaveWeight,
    rippleWeight: u.waveFoamRippleWeight,
    crestCoverage: u.waveFoamCrestCoverage,
    windBias: u.waveFoamWindBias,
    size: u.waveFoamSize,
    windStretch: u.waveFoamWindStretch,
    coverage: u.waveFoamCoverage,
    opacity: u.waveFoamOpacity,
    peakIntensity: u.waveFoamPeakIntensity,
    foamColor: u.waveFoamColor,
    windDirection: uniform(new Vector2(1, 0)),
    eigen0,
    eigen1,
    hasJacobianFoam: uniform(1.0),
    surfaceNormal,
    ...(tilingPosition != null ? { oceanPositionWorld: tilingPosition } : {}),
  })

  // Program 6 (shoreline foam) — two layers (band + tint).
  const shorelineBand = shorelineFoamNode(waterColumnDepth, {
    foamTexture,
    enabled: u.shorelineFoamOn,
    range: u.shorelineBandRange,
    size: u.shorelineFoamSize,
    coverage: u.shorelineBandCoverage,
    opacity: u.shorelineBandOpacity,
    foamColor: u.shorelineFoamColor,
    ...(tilingPosition != null ? { oceanPositionWorld: tilingPosition } : {}),
  })
  const shorelineTint = shorelineFoamNode(waterColumnDepth, {
    foamTexture,
    enabled: u.shorelineFoamOn,
    range: u.shorelineTintRange,
    size: u.shorelineFoamSize,
    coverage: u.shorelineTintCoverage,
    opacity: u.shorelineTintOpacity,
    foamColor: u.shorelineFoamColor,
    ...(tilingPosition != null ? { oceanPositionWorld: tilingPosition } : {}),
  })
  const shorelineFoam = shorelineBand

  // Program 2 (fresnel only). distanceFade output discarded.
  const noFadeStart = uniform(1e6)
  const noFadeEnd = uniform(1e6 + 1)
  const noFadePower = uniform(1.0)
  // Local-up in world frame: transform ocean-local Y by the model rotation.
  // For the plane at origin modelWorldMatrix is identity → (0,1,0) (matches
  // the legacy hardcoded flatNormal). For chunks at ECEF this becomes the
  // geocentric up at the ocean position — i.e. the actual surface "up" the
  // fresnel reference is supposed to mix toward.
  const worldUp = (modelWorldMatrix as any)
    .mul(vec4(float(0), float(1), float(0), float(0)))
    .xyz.normalize()
  const fresnelOut = fresnelDistanceNode({
    interpolatedNormal: surfaceNormal,
    worldX: worldXZ.x,
    worldZ: worldXZ.y,
    fadeStart: noFadeStart,
    fadeEnd: noFadeEnd,
    fadePower: noFadePower,
    normalStrength: u.fresnelNormalStrength,
    power: u.fresnelPower,
    flatNormal: worldUp,
  })
  const { fresnel: fresnelRaw, distanceToCamera } = fresnelOut
  const sssFadeStart = uniform(50.0)
  const sssFadeEnd = uniform(200.0)

  // viewDir = cameraPosition - surface point, both in world frame.
  // - Plane caller leaves worldSurfacePos undefined → fall back to the
  //   original `vec3(worldXZ.x, 0, worldXZ.y)` (Y=0 stabilises viewDir
  //   against wave-height jitter for the close-camera scene).
  // - Chunk caller MUST pass the real world position — at ECEF, zeroing Y
  //   aims viewDir at Earth's centre instead of the surface, producing a
  //   diagonal fresnel discontinuity once viewDir·normal flips sign.
  const surfaceWorldPoint =
    worldSurfacePos ?? vec3(worldXZ.x, float(0), worldXZ.y)
  const viewDir = cameraPosition.sub(surfaceWorldPoint).normalize()

  // Program 3 (SSS).
  const sssOut = subSurfaceScatteringNode({
    viewDir,
    sunDir: sunDirUniform,
    waveNormal: surfaceNormal,
    waterColor,
    distanceToCamera,
    transmissionColor: u.transmissionColor,
    sunIntensity: sunIntensityUniform,
    fadeStart: sssFadeStart,
    fadeEnd: sssFadeEnd,
    enabled: u.sssOn,
    power: u.sssPower,
    intensity: u.sssIntensity,
  })

  // Program 1 (sparkle). Sun-elevation against local up (worldUp), not the
  // hardcoded world-Y axis — at globe scale those differ by the chunk's
  // geocentric latitude.
  const sunElevation = saturate(dot(sunDirUniform, worldUp))
  const sparkleSunColor = mix(
    vec3(1.0, 0.45, 0.2),
    vec3(1.0, 0.97, 0.88),
    sunElevation
  )
  const sparkleOut = sparkleNode({
    viewDir,
    sunDir: sunDirLightUniform,
    flippedNormal: surfaceNormal,
    enabled: u.sparkleOn,
    focusPower: u.sparkleFocusPower,
    intensity: u.sparkleIntensity,
    color: sparkleSunColor,
  })

  // Program 11 (turbulent foam).
  const turbulentFoam = turbulentFoamNode({
    sampleNormal: xz => sampleWaveNormal(waveSim, { worldXZ: xz }).normal,
    enabled: u.turbulentFoamOn,
    sampleEpsilon: uniform(2.0),
    depthAttenuation: uniform(0.5),
    intensity: u.turbulentIntensity,
    worldXZ: fragSurfaceXZ,
    ...(tilingPosition != null ? { oceanPositionWorld: tilingPosition } : {}),
  })

  // AF.build composition.
  const combined = combineFoamNode({
    surfaceFoam,
    waveFoam,
    shorelineFoam,
    scene: { isObjectInFront, isDynamic, fresnel: fresnelRaw },
  })

  // Live atmosphere cube sample with exponential tonemap.
  const reflectDir = tslReflect(viewDir.negate(), fresnelOut.fresnelNormal)
  const rawSky = cubeTexture(envCubeTexture, reflectDir).rgb
  const tonemappedSky = float(1).sub(
    exp(rawSky.mul(u.skyReflectionExposure).negate())
  )
  const skyReflection = tonemappedSky
    .mul(u.skyReflectionColor)
    .mul(u.skyReflectionScale)
  const gatedFresnel = fresnelRaw.mul(u.skyReflectionOn)

  // colorNode composition.
  const transmittedBody = waterColor.mul(float(1).sub(gatedFresnel))
  const waterColorLitGlow = transmittedBody.add(sparkleOut.glowColor)
  const withCombined = mix(
    waterColorLitGlow,
    combined.combinedFoamColor,
    combined.combinedFoamStrength
  )
  const withTurbulent = withCombined.add(turbulentFoam.foam.mul(float(0.1)))
  const withTint = mix(withTurbulent, shorelineTint.color, shorelineTint.strength)
  const withShoreline = mix(
    withTint,
    combined.shorelineFoamTint,
    combined.shorelineFoamStrength
  )

  // Tip foam — fires on actual wave-tip height with a sparse second noise
  // so foam only appears on *some* peaks, not all.
  //
  // Height source: when the caller passes `surfaceHeight` (chunks pass
  // `vDisplaced.y` — the exact Y the vertex stage produced) we use it
  // directly. Otherwise we re-sample the cascade at fragSurfaceXZ, which
  // ends up off by lambda chop on chunks (foam shifted off the peak).
  //
  // Two-mask composition:
  //   heightMask = smoothstep(threshold, threshold+softness, height)
  //   detailNoise = noise(xz / size)            — fine variation INSIDE foam
  //   rarityMask = smoothstep(rarity, rarity+0.05, noise(xz / (size*8) + offset))
  //   strength = saturate(heightMask · detailNoise · rarityMask · intensity)
  //
  // rarity=0 → mask=1 (every qualifying peak); rarity=1 → essentially zero.
  // The (size*8) scale for rarity gives "patchy" regions where foam is
  // allowed, with detailNoise providing fine texture inside those patches.
  const cascadeYFromSample = sampleWaveDisplacement(waveSim, {
    worldXZ: fragSurfaceXZ,
  }).displacement.y
  const waveHeight =
    surfaceHeight ??
    cascadeYFromSample
      .mul(u.fftAmplitude)
      .add(gerstnerFrag.displacement.y.mul(u.gerstnerAmplitude))
  const heightMask = smoothstep(
    u.tipFoamHeightThreshold,
    (u.tipFoamHeightThreshold as any).add(u.tipFoamSoftness),
    waveHeight
  )
  const tipDetailNoise = tslTexture(
    foamTexture,
    fragSurfaceXZ.div(u.tipFoamSize)
  ).r
  const tipRarityNoise = tslTexture(
    foamTexture,
    fragSurfaceXZ
      .div((u.tipFoamSize as any).mul(float(8)))
      .add(vec2(float(0.37), float(0.13)))
  ).r
  const tipRarityMask = smoothstep(
    u.tipFoamRarity,
    (u.tipFoamRarity as any).add(float(0.05)),
    tipRarityNoise
  )
  const tipFoamStrength = saturate(
    heightMask
      .mul(tipDetailNoise)
      .mul(tipRarityMask)
      .mul(u.tipFoamIntensity)
      .mul(u.tipFoamEnabled)
  )
  const withTipFoam = mix(withShoreline, u.tipFoamColor, tipFoamStrength)

  const finalColor = withTipFoam

  // emissiveNode composition. Foam mask = 1 - (combined foam + tip foam),
  // clamped — reflection / SSS are zeroed out where any foam covers the
  // surface so they don't bleed through a white-cap.
  const foamMask = saturate(
    float(1).sub(combined.combinedFoamStrength).sub(tipFoamStrength)
  )
  const reflectionEmissive = skyReflection.mul(gatedFresnel).mul(foamMask)
  const sssEmissive = sssOut.scattering
    .mul(float(1).sub(gatedFresnel))
    .mul(foamMask)
  const totalEmissive = reflectionEmissive.add(sssEmissive)

  // Material.
  const mat = new MeshStandardNodeMaterial()
  mat.positionNode = positionNode as any
  mat.colorNode = vec4(finalColor, float(1))
  ;(mat as any).emissiveNode = totalEmissive
  mat.side = DoubleSide
  ;(mat as any).colorSpace = SRGBColorSpace
  return mat
}

// Re-exports so callers don't have to re-import for the displacement
// computation that varies per caller.
export { sampleWaveDisplacement, GerstnerOverlay, WaveSimulation }
export type { Node, UniformNode }
export { Vector2, Vector3, Vector4 }
