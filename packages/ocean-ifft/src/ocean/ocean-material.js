import { THREE } from '../three-defs.js';
import { texture, cubeTexture, attribute, uniform, vec3, vec4 } from 'three/tsl';
import { entity } from '../entity.js';
import { ocean_constants } from './ocean-constants.js';
import { vertexStageWGSL } from '../../resources/shader/ocean/vertexStageWGSL.js';
import { fragmentStageWGSL } from '../../resources/shader/ocean/fragmentStageWGSL.js';

const assetUrl = path => new URL(path, import.meta.url).href;

class OceanMaterial extends entity.Component {
	constructor(params) {
		super();    	
		this.Init(params);
	}

	Init(params) {
  
		const loader = new THREE.TextureLoader();
		const noiseTexture = loader.load(assetUrl('../../resources/textures/simplex-noise.png'));
		const testTexture = loader.load(assetUrl('../../resources/textures/uv_grid_opengl.jpg'));



		const cubeTextureLoader = new THREE.CubeTextureLoader();
		const cubeFaces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
			face => new URL(`../../resources/textures/cube/sky/${face}.jpg`, import.meta.url).href
		);
		const environmentTexture = cubeTextureLoader.load(cubeFaces);
		//const environmentTexture = cubeTextureLoader.load(cubeFaces.map(f => f.replace('.jpg', '.png')));
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
			noise: texture(noiseTexture),
			testTexture: texture(testTexture),
			testTexture_sampler: texture(testTexture),
			noiseSampler: texture(noiseTexture),
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
			//depthTexture: params.threejs.sceneDepthPassTexture,
			foamStrength: params.foamStrength,
			foamThreshold: params.foamThreshold,
			lodScale: params.lodScale,
			waveLengths: vec4(
				params.cascades[0].params_.lengthScale,
				params.cascades[1].params_.lengthScale,
				params.cascades[2].params_.lengthScale,
			),
			//envTexture: cubeTexture(environmentTexture),
			//envTexture_sampler: cubeTexture(environmentTexture),
			envTexture: cubeTexture(params.environment),
			envTexture_sampler: cubeTexture(params.environment),
			sunPosition: uniform(params.sunPosition)    
		}

		this.oceanMaterial = new THREE.MeshBasicNodeMaterial();
		this.oceanMaterial.positionNode = vertexStageWGSL.vertexStageWGSL(wgslShaderParams);
		this.oceanMaterial.colorNode = fragmentStageWGSL(wgslShaderParams);
		this.oceanMaterial.side = THREE.DoubleSide;
		this.oceanMaterial.colorSpace = THREE.SRGBColorSpace;
		this.oceanMaterial.transparent = true;

	}

}


export { OceanMaterial };
