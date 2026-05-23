// Phase A refactor — OceanMaterial assembly.
// Builds the WGSL shader-parameter object as three composable groups:
// cascade IFFT bindings, surface-optics tunables (foam + SSS + sparkle), and
// lighting (environment cubemap + sun). The MeshStandardNodeMaterial assembled
// at the bottom pulls vertex + fragment WGSL from resources/shader/ocean.

import { THREE } from '../three-defs.js';
import { texture, cubeTexture, attribute, uniform, vec3, vec4, screenUV, mix, float, modelViewMatrix, modelWorldMatrix } from 'three/tsl';
import { entity } from '../entity.js';
import { ocean_constants } from './ocean-constants.js';
import { vertexStageWGSL } from '../../resources/shader/ocean/vertexStageWGSL.js';
import { fragmentStageWGSL } from '../../resources/shader/ocean/fragmentStageWGSL.js';
import { buildWaterColumnDepth } from '../waterpro/nodes/water-color.js';
import { shorelineFoamNode } from '../waterpro/nodes/shoreline-foam.js';

const assetUrl = path => new URL(path, import.meta.url).href;

function buildCascadeUniforms(params) {
	return {
		ifftResolution: uniform(params.ifftResolution),
		displacement0: texture(params.cascades[0].displacement),
		displacement1: texture(params.cascades[1].displacement),
		displacement2: texture(params.cascades[2].displacement),
		derivatives0: texture(params.cascades[0].derivative),
		derivatives1: texture(params.cascades[1].derivative),
		derivatives2: texture(params.cascades[2].derivative),
		jacobian0: texture(params.cascades[0].jacobian),
		jacobian1: texture(params.cascades[1].jacobian),
		jacobian2: texture(params.cascades[2].jacobian),
		ifft_sampler0: texture(params.cascades[0].derivative),
		ifft_sampler1: texture(params.cascades[1].derivative),
		ifft_sampler2: texture(params.cascades[2].derivative),
		waveLengths: vec4(
			params.cascades[0].params_.lengthScale,
			params.cascades[1].params_.lengthScale,
			params.cascades[2].params_.lengthScale,
		),
		lodScale: params.lodScale,
	};
}

function buildSurfaceOpticsUniforms(params, noiseTexture) {
	return {
		foamStrength: params.foamStrength,
		foamThreshold: params.foamThreshold,
		noise: texture(noiseTexture),
		noise_sampler: texture(noiseTexture),
		sssColor: uniform(new THREE.Vector3(0.0, 0.5, 0.4)),
		sssStrength: uniform(0.4),
		sparkleIntensity: uniform(2.0),
		sparkleSize: uniform(256.0),
		foamTextureScale: uniform(0.02),
		foamSpeed: uniform(0.05),
		foamMix: uniform(0.7),
		// Gerstner: each wave packed as (dirX, dirZ, wavelength, amplitude).
		// Amplitude = 0 disables the slot. Defaults: one large NW swell, one
		// medium cross-swell, one short chop. Tune in GUI for hero scenes.
		gerstnerWave0: uniform(new THREE.Vector4(1.0, 0.3, 120.0, 1.2)),
		gerstnerWave1: uniform(new THREE.Vector4(0.5, 1.0, 60.0, 0.6)),
		gerstnerWave2: uniform(new THREE.Vector4(-0.8, 0.6, 30.0, 0.25)),
		gerstnerSteepness: uniform(0.5),
		gerstnerStrength: uniform(1.0),
	};
}

function buildLightingUniforms(params) {
	return {
		envTexture: cubeTexture(params.environment),
		envTexture_sampler: cubeTexture(params.environment),
		sunPosition: uniform(params.sunPosition),
	};
}

// Scene linear-depth pre-pass texture (rendered by OceanChunks at priority 0.5
// with per-mesh material swap to the WaterPro linear-depth material). R channel
// encodes (-view_z - near)/(far - near). Bound as a regular texture_2d<f32> so
// WebGPU TEXTURE_BINDING works. When no depth texture is provided, a 1x1
// HalfFloat RGBA fallback keeps the texture identity stable across the material
// lifetime; depthTextureEnabled gates all depth sampling in the TSL nodes.
let _depthFallback = null;
function getDepthFallbackTexture() {
	if (_depthFallback == null) {
		_depthFallback = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
		_depthFallback.needsUpdate = true;
	}
	return _depthFallback;
}
function buildSceneDepthUniforms(params) {
	const hasDepth = params.depthTexture != null;
	const depthSource = hasDepth ? params.depthTexture : getDepthFallbackTexture();
	return {
		depthTexture: texture(depthSource),
		depthTextureEnabled: uniform(hasDepth ? 1.0 : 0.0),
		screenUV: screenUV,
		cameraNear: uniform(params.cameraNear ?? 1.0),
		cameraFar: uniform(params.cameraFar ?? 1e8),
		cameraForward: uniform(new THREE.Vector3(0, -1, 0)),
		contactFoamDistance: uniform(params.contactFoamDistance ?? 500.0),
		contactFoamIntensity: uniform(params.contactFoamIntensity ?? 1.0),
	};
}

class OceanMaterial extends entity.Component {
	constructor(params) {
		super();
		this.Init(params);
	}

	Init(params) {
		const loader = new THREE.TextureLoader();
		const noiseTexture = loader.load(assetUrl('../../resources/textures/simplex-noise.png'));
		noiseTexture.wrapS = THREE.RepeatWrapping;
		noiseTexture.wrapT = THREE.RepeatWrapping;
		const testTexture = loader.load(assetUrl('../../resources/textures/uv_grid_opengl.jpg'));

		const cubeTextureLoader = new THREE.CubeTextureLoader();
		const cubeFaces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
			face => new URL(`../../resources/textures/cube/sky/${face}.jpg`, import.meta.url).href
		);
		const environmentTexture = cubeTextureLoader.load(cubeFaces);
		environmentTexture.minFilter = THREE.LinearFilter;
		environmentTexture.magFilter = THREE.LinearFilter;

		const wgslShaderParams = {
			time: uniform(0),
			cameraPosition: uniform(new THREE.Vector3()),
			wMatrix: uniform(new THREE.Matrix4()),
			oceanSize: ocean_constants.OCEAN_SIZE,
			minLodRadius: ocean_constants.QT_OCEAN_MIN_LOD_RADIUS,
			numLayers: ocean_constants.QT_OCEAN_MIN_NUM_LAYERS,
			gridResolution: ocean_constants.QT_OCEAN_MIN_CELL_RESOLUTION,
			vMorphedPosition: vertexStageWGSL.vMorphedPosition,
			vDisplacedPosition: vertexStageWGSL.vDisplacedPosition,
			vCascadeScales: vertexStageWGSL.vCascadeScales,
			position: attribute("position"),
			vindex: attribute("vindex"),
			width: attribute("width"),
			lod: attribute("lod"),
			testTexture: texture(testTexture),
			testTexture_sampler: texture(testTexture),
			...buildCascadeUniforms(params),
			...buildSurfaceOpticsUniforms(params, noiseTexture),
			...buildLightingUniforms(params),
		};

		// Scene depth pre-pass texture (raw THREE.Texture, not a TSL binding) feeds
		// the TSL water-column-depth + shoreline-foam nodes. A 1x1 HalfFloat fallback
		// keeps texture identity stable when no depth texture is provided.
		const hasDepth = params.depthTexture != null;
		const depthSource = hasDepth ? params.depthTexture : getDepthFallbackTexture();
		const depthTextureEnabled = uniform(hasDepth ? 1.0 : 0.0);

		// Compute oceanDepth + positionWorld explicitly from the WGSL vertex stage's
		// vDisplacedPosition varying. The custom positionNode in this material
		// makes TSL's built-in `positionView` / `positionWorld` unreliable —
		// passing displaced-position-derived overrides avoids the iso-line
		// foam artifact (foam appearing only on the screen line where the
		// constant positionView happens to equal terrainDepth).
		const vDisplaced = vertexStageWGSL.vDisplacedPosition;
		const displacedWorld = modelWorldMatrix.mul(vec4(vDisplaced, float(1))).xyz;
		const displacedView = modelViewMatrix.mul(vec4(vDisplaced, float(1)));
		const oceanDepthExplicit = displacedView.z.negate();

		const waterColumnDepth = buildWaterColumnDepth({
			depthTexture: depthSource,
			depthTextureEnabled,
			waterDepth: uniform(20.0),
			oceanDepth: oceanDepthExplicit,
			oceanPositionWorld: displacedWorld,
		});
		const { strength, color: contactFoamColor } = shorelineFoamNode(waterColumnDepth, {
			foamTexture: noiseTexture,
			enabled: uniform(1.0),
			// range = depth at which foam fully fades. 50m gives a visible band along
			// continental shelves at ECEF scale; tune via params.contactFoamDistance.
			range: uniform(params.contactFoamDistance ?? 50.0),
			// size = foam tile size in world meters (WaterPro convention).
			// 50m matches the decompiled BF._size default.
			size: uniform(50.0),
			// coverage = 0..1 threshold on the noise texture (WaterPro convention).
			coverage: uniform(0.5),
			opacity: uniform(params.contactFoamIntensity ?? 0.9),
			foamColor: uniform(new THREE.Vector3(0.9, 0.95, 1.0)),
			oceanPositionWorld: displacedWorld,
		});

		this.oceanMaterial = new THREE.MeshStandardNodeMaterial();
		this.oceanMaterial.positionNode = vertexStageWGSL.vertexStageWGSL(wgslShaderParams);

		const wgslColor = fragmentStageWGSL(wgslShaderParams);
		this.oceanMaterial.colorNode = vec4(mix(wgslColor.rgb, contactFoamColor, strength), float(1));
		this.oceanMaterial.side = THREE.DoubleSide;
		this.oceanMaterial.colorSpace = THREE.SRGBColorSpace;
		this.oceanMaterial.transparent = true;
	}
}

export { OceanMaterial, buildCascadeUniforms, buildSurfaceOpticsUniforms, buildLightingUniforms, buildSceneDepthUniforms };
