import { THREE } from '../three-defs.js';
import { entity } from '../entity.js';
import { ocean_constants } from './ocean-constants.js';
import { ocean_builder_threaded } from './ocean-builder-threaded.js';
import { quadtree } from './quadtree.js';
import { utils } from './utils.js';
import { OceanMaterial } from './ocean-material.js';
class OceanChunkManager extends entity.Component {

	constructor( params ) {

		super();

	}


	async Init( params ) {

		this.params_ = params;
		this.builder_ = new ocean_builder_threaded.OceanChunkRebuilder_Threaded();

		this.sun = new THREE.Vector3();

		this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget( 256 );
		this.cubeRenderTarget.texture.format = THREE.RGBAFormat;
		this.cubeRenderTarget.texture.type = THREE.HalfFloatType;
		this.cubeRenderTarget.texture.minFilter = THREE.LinearMipMapLinearFilter;
		this.cubeRenderTarget.texture.magFilter = THREE.LinearFilter;
		this.cubeRenderTarget.texture.generateMipmaps = true;
		this.cubeCamera = new THREE.CubeCamera( 1, 1000000, this.cubeRenderTarget );
		this.cubeCamera.rotation.z = Math.PI/2;
		this.cubeCamera.layers.set( 2 );


		// Optional material override: callers can supply a pre-built chunk
		// material (e.g. the WaterPro TSL composition from
		// storybook-webgpu/src/ocean/buildWaterproChunkMaterial). When absent
		// we fall back to the legacy OceanMaterial path that drives the
		// existing localhost:5173 demo — backwards-compatible.
		if ( params.material != null ) {
			this.material_ = params.material;
		} else {
			const oceanDatas = {
				...params,
				lodScale: this.params_.waveGenerator.lodScale,
				cascades: this.params_.waveGenerator.cascades,
				// waveLengths is constructed in OceanMaterial from cascades, not needed here
				foamStrength: this.params_.waveGenerator.foamStrength,
				foamThreshold: this.params_.waveGenerator.foamThreshold,
				ifftResolution: this.params_.waveGenerator.size,
				depthTexture: this.params_.depthTexture || null,
				viewportSize: this.params_.viewportSize || new THREE.Vector2(1, 1),
				mySampler: this.params_.mySampler || null,
				environment: this.cubeRenderTarget.texture,
				sunPosition: this.sun
			}

			this.material_ = new OceanMaterial( oceanDatas ).oceanMaterial;
		}

		this.InitOcean( params );


		// Optional quadtree overrides — callers can shrink lod_layers for
		// debugging (fewer chunks → faster compile + isolate slow paths).
		this.quadTree = new quadtree.Root( {
			size: params.oceanSize ?? ocean_constants.OCEAN_SIZE,
			min_lod_radius: params.minLodRadius ?? ocean_constants.QT_OCEAN_MIN_LOD_RADIUS,
			lod_layers: params.numLayers ?? ocean_constants.QT_OCEAN_MIN_NUM_LAYERS,
			min_node_size: params.minNodeSize ?? ocean_constants.QT_OCEAN_MIN_CELL_SIZE,
		} );

	}


	InitOcean( params ) {

		this.group = new THREE.Group();
		params.scene.add( this.group );
		this.chunks_ = {};

		params.guiParams.ocean = {
			wireframe: false,
		}
		this.params_.waveGenerator.oceanSet.add( params.guiParams.ocean, "wireframe" ).onChange( () => {
			this.material_.wireframe = params.guiParams.ocean.wireframe;
		} );

	}

	Destroy() {
		if ( this.chunks_ != null ) {
			for ( const entry of Object.values( this.chunks_ ) ) {
				entry.chunk?.Destroy?.();
			}
			this.chunks_ = {};
		}

		if ( this.builder_?.old_ != null ) {
			for ( const entry of this.builder_.old_ ) {
				entry.chunk?.Destroy?.();
			}
			this.builder_.old_ = [];
		}

		this.material_?.dispose?.();
		this.cubeRenderTarget?.dispose?.();

		if ( this.group?.parent != null ) {
			this.group.parent.remove( this.group );
		}
	}

	SetSunDirection(direction) {
		if (!direction) {
			return;
		}
		this.sun.copy(direction);
	}


	CreateOceanChunk( group, groupTransform, offset, width, resolution, lod ) {

		const params = {
			group: group,
			transform: groupTransform,
			width: width,
			offset: offset,
			resolution: resolution,
			lod: lod,
			layer: this.params_.layer,
			material: this.material_
		};

		return this.builder_.AllocateChunk( params );

	}


	Update_(_) {

		const cameraPosition = new THREE.Vector3();
		const scenePosition = new THREE.Vector3();
		this.params_.camera.updateMatrixWorld?.();
		this.params_.scene.updateMatrixWorld?.( true, false );
		this.params_.camera.getWorldPosition( cameraPosition );
		this.params_.scene.getWorldPosition( scenePosition );
		const relativeCameraPosition = cameraPosition.clone();
		if ( this.params_.scene.worldToLocal ) {
			this.params_.scene.worldToLocal( relativeCameraPosition );
		} else {
			relativeCameraPosition.sub( scenePosition );
		}

		this.cubeCamera.update( this.params_.renderer, this.params_.scene );


		this.builder_.Update();

		if ( !this.builder_.Busy ) {
			for (let k in this.chunks_) {
				this.chunks_[ k ].chunk.Show();
			}
			const chunkCountBefore = Object.keys(this.chunks_).length;
			this.UpdateVisibleChunks_Quadtree_( relativeCameraPosition );
			const chunkCountAfter = Object.keys(this.chunks_).length;
			if (chunkCountAfter > chunkCountBefore && !this._loggedChunkCreation) {
				console.log(`Ocean: Created ${chunkCountAfter - chunkCountBefore} new chunks (total: ${chunkCountAfter})`);
				this._loggedChunkCreation = true;
			}
		} else {
			if (!this._loggedBusy) {
				console.log('Ocean: Builder is busy, waiting for workers...');
				this._loggedBusy = true;
			}
		}
			
		for ( let k in this.chunks_ ) {
			this.chunks_[ k ].chunk.Update( relativeCameraPosition );

			this.chunks_[ k ].chunk.mesh_.material.wireframe = this.params_.guiParams.ocean.wireframe;
		}
		for ( let c of this.builder_.old_ ) {
			c.chunk.Update( relativeCameraPosition );
		}



		// cameraPosition is a shared uniform node referenced by both the WGSL
		// vertex and fragment stages, so updating it via positionNode.parameters
		// is sufficient — the fragment stage sees the same value automatically.
		// The TSL contact-foam path uses three/tsl built-ins (cameraNear/cameraFar/
		// screenUV/positionView) which read from the renderer's active camera, so
		// no per-frame uniform updates are needed for the depth-based foam.
		// Materials that don't expose a wgslFn-style positionNode (e.g. plain
		// MeshBasicNodeMaterial used for diagnostics) skip this update.
		const positionParams = this.material_.positionNode?.parameters;
		if ( positionParams?.cameraPosition != null ) {
			positionParams.cameraPosition.value = relativeCameraPosition;
		}

	}//end Update



	Key( c ) {

		return c.position[0] + '/' + c.position[1] + ' [' + c.size + ']';

	}


	UpdateVisibleChunks_Quadtree_( cameraPosition ) {

		this.quadTree.Insert( cameraPosition );

		const sides = this.quadTree.GetChildren();

		let newOceanChunks = {};
		const center = new THREE.Vector3();
		const dimensions = new THREE.Vector3();

		const _Child = (c) => {
			c.bounds.getCenter(center);
			c.bounds.getSize(dimensions);

			const child = {
				group: this.group,
				transform: sides.transform,
				position: [ center.x, center.y, center.z ],
				bounds: c.bounds,
				size: dimensions.x,
				lod: c.lod,
			};
			return child;
		};


			for ( let c of sides.children ) {
				const child = _Child( c );
				const k = this.Key( child );
					
				newOceanChunks[ k ] = child;
			}


		const intersection = utils.DictIntersection( this.chunks_, newOceanChunks );
		const difference = utils.DictDifference( newOceanChunks, this.chunks_ );
		const recycle = Object.values(utils.DictDifference( this.chunks_, newOceanChunks ) );


		this.builder_.RetireChunks( recycle );

		newOceanChunks = intersection;
			

		for ( let k in difference ) {

			const [ xp, yp, zp ] = difference[ k ].position;

			const offset = new THREE.Vector3( xp, yp, zp );
				
			newOceanChunks[ k ] = {
				position: [ xp, zp ],
				chunk: this.CreateOceanChunk(
					difference[ k ].group, 
					difference[ k ].transform,
					offset, 
					difference[ k ].size,
					ocean_constants.QT_OCEAN_MIN_CELL_RESOLUTION,
					difference[ k ].lod,
				),
			};

		}

		this.chunks_ = newOceanChunks;

	}
 
}//end class


export default OceanChunkManager;
