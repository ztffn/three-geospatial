import { THREE } from '../three-defs.js';
import { entity } from '../entity.js';
import { ocean_constants } from './ocean-constants.js';
import { ocean_builder_threaded } from './ocean-builder-threaded.js';
import { quadtree } from './quadtree.js';
import { utils } from './utils.js';
import { OceanMaterial } from './ocean-material.js';
import { SphericalMapping } from '../coordinates/SphericalMapping.ts';

/**
 * Spherical Ocean Chunk Manager - extends the existing ocean system to work on a sphere
 * This maintains the existing quadtree LOD system while mapping chunks to spherical coordinates
 */
class SphericalOceanChunkManager extends entity.Component {

	constructor(params) {
		super();
		this.params_ = params;
		this.radius = params.radius || SphericalMapping.OCEAN_RADIUS;
		this.maskProvider = params.maskProvider || null;
	}

	async Init(params) {
		this.params_ = { ...this.params_, ...params };
		
		// Initialize builder (same as existing system)
		this.builder_ = new ocean_builder_threaded.OceanChunkRebuilder_Threaded();

		// Sun position for lighting
		this.sun = new THREE.Vector3();

		// Environment cube camera (same as existing)
		this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(256);
		this.cubeRenderTarget.texture.format = THREE.RGBAFormat;
		this.cubeRenderTarget.texture.type = THREE.HalfFloatType;
		this.cubeRenderTarget.texture.minFilter = THREE.LinearMipMapLinearFilter;
		this.cubeRenderTarget.texture.magFilter = THREE.LinearFilter;
		this.cubeRenderTarget.texture.generateMipmaps = true;
		this.cubeCamera = new THREE.CubeCamera(1, 1000000, this.cubeRenderTarget);
		this.cubeCamera.rotation.z = Math.PI/2;
		this.cubeCamera.layers.set(2);

		// Ocean material data (enhanced with mask provider)
		const oceanDatas = {
			...params,
			lodScale: this.params_.waveGenerator.lodScale,
			cascades: this.params_.waveGenerator.cascades,
			foamStrength: this.params_.waveGenerator.foamStrength,
			foamThreshold: this.params_.waveGenerator.foamThreshold,
			ifftResolution: this.params_.waveGenerator.size,
			depthTexture: this.params_.depthTexture || null,
			mySampler: this.params_.mySampler || null,
			environment: this.cubeRenderTarget.texture,
			sunPosition: this.sun,
			// Add mask provider for Sebastian Lague integration
			maskProvider: this.maskProvider
		}
			
		// Create spherical ocean material
		this.material_ = new OceanMaterial(oceanDatas).oceanMaterial;

		this.InitOcean(params);

		// Quadtree for LOD (same system as existing ocean chunks)
		this.quadTree = new quadtree.Root({
			size: ocean_constants.OCEAN_SIZE,
			min_lod_radius: ocean_constants.QT_OCEAN_MIN_LOD_RADIUS,
			lod_layers: ocean_constants.QT_OCEAN_MIN_NUM_LAYERS,
			min_node_size: ocean_constants.QT_OCEAN_MIN_CELL_SIZE,
		});
	}

	InitOcean(params) {
		this.group = new THREE.Group();
		this.group.name = 'spherical-ocean-chunks';
		params.scene.add(this.group);
		this.chunks_ = {};

		// GUI parameters (same as existing)
		params.guiParams.ocean = {
			wireframe: false,
		}
		
		if (this.params_.waveGenerator.oceanSet) {
			this.params_.waveGenerator.oceanSet.add(params.guiParams.ocean, "wireframe").onChange(() => {
				this.material_.wireframe = params.guiParams.ocean.wireframe;
			});
		}
	}

	SetSunDirection(direction) {
		if (!direction) {
			return;
		}
		this.sun.copy(direction);
	}

	/**
	 * Create spherical ocean chunk - this is the key modification
	 * Instead of creating flat chunks, we create spherical tile patches
	 */
	CreateOceanChunk(group, groupTransform, offset, width, resolution, lod) {
		// Convert flat ocean chunk coordinates to spherical tile coordinates
		const tileCoords = SphericalMapping.offsetToTileCoords(
			offset, 
			lod,
			width,
			new THREE.Vector3(0, 0, 0) // world center
		);

		console.log(`Creating chunk: offset=${offset.x},${offset.z} lod=${lod} -> tile=${tileCoords.x},${tileCoords.y},${tileCoords.z}`);

		const bounds = SphericalMapping.tileToGeographicBounds(
			tileCoords.x,
			tileCoords.y, 
			tileCoords.z
		);

		// Check if this tile should contain water using mask provider
		if (this.maskProvider && !this.shouldCreateOceanTile(bounds)) {
			return null; // Skip this tile - no water here according to masks
		}

		// Create spherical geometry instead of flat plane
		const geometry = SphericalMapping.createSphericalTileGeometry(
			bounds, 
			resolution,
			this.radius
		);

		// Add custom attributes for IFFT ocean shader
		this.addOceanAttributes(geometry, offset, width, lod, resolution);

		// Create mesh with existing ocean material
		const mesh = new THREE.Mesh(geometry, this.material_);
		mesh.frustumCulled = true;
		mesh.castShadow = false;
		mesh.receiveShadow = true;

		// Position mesh (for existing quadtree system compatibility)
		mesh.position.copy(offset);
		mesh.updateMatrix();

		const params = {
			group: group,
			transform: groupTransform,
			width: width,
			offset: offset,
			resolution: resolution,
			lod: lod,
			layer: this.params_.layer,
			material: this.material_,
			mesh: mesh,
			bounds: bounds,
			tileCoords: tileCoords
		};

		// Add to group
		group.add(mesh);

		return params;
	}

	/**
	 * Check if ocean tile should be created based on Sebastian Lague masks
	 */
	shouldCreateOceanTile(bounds) {
		if (!this.maskProvider) {
			return true; // No masks available, create all tiles
		}

		// Sample mask at several points in the tile to check for water
		const samplePoints = [
			{ lon: bounds.lonLeft, lat: bounds.latTop },
			{ lon: bounds.lonRight, lat: bounds.latTop },
			{ lon: bounds.lonLeft, lat: bounds.latBottom },
			{ lon: bounds.lonRight, lat: bounds.latBottom },
			{ lon: (bounds.lonLeft + bounds.lonRight) / 2, lat: (bounds.latTop + bounds.latBottom) / 2 }
		];

		// If any sample point has water, create the tile
		// This ensures we don't miss small islands or coastal features
		return samplePoints.some(point => {
			return this.maskProvider.hasWaterAtLocation(point.lon, point.lat);
		});
	}

	/**
	 * Add ocean-specific attributes needed for IFFT shader
	 */
	addOceanAttributes(geometry, offset, width, lod, resolution) {
		const vertexCount = geometry.attributes.position.count;
		
		// Vertex index attribute (needed for morphing in existing shader)
		const vindex = new Float32Array(vertexCount);
		for (let i = 0; i < vertexCount; i++) {
			vindex[i] = i;
		}
		geometry.setAttribute('vindex', new THREE.BufferAttribute(vindex, 1));

		// Width attribute (for LOD morphing)
		const widthArray = new Float32Array(vertexCount);
		widthArray.fill(width);
		geometry.setAttribute('width', new THREE.BufferAttribute(widthArray, 1));

		// LOD attribute
		const lodArray = new Float32Array(vertexCount);
		lodArray.fill(lod);
		geometry.setAttribute('lod', new THREE.BufferAttribute(lodArray, 1));

		return geometry;
	}

	/**
	 * Update method - adapted for quadtree system
	 */
	Update_(deltaTime) {
		if (!this.quadTree) {
			console.log('No quadtree available');
			return;
		}

		// Update quadtree based on camera position
		const camera = this.params_.camera;
		if (camera) {
			console.log(`Camera position: ${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}`);
			
			// Insert camera position to update quadtree LOD
			this.quadTree.Insert(camera.position);
			
			// Update ocean chunks based on quadtree
			this.updateOceanChunks();
		}

		// Update wave generator
		if (this.params_.waveGenerator.Update_) {
			this.params_.waveGenerator.Update_(deltaTime);
		}
	}

	/**
	 * Update ocean chunks based on quadtree LOD
	 */
	updateOceanChunks() {
		const children = this.quadTree.GetChildren();
		const currentChunkIds = new Set();

		console.log('updateOceanChunks called - children:', children?.children?.length || 0);

		// Process quadtree children
		if (children && children.children) {
			children.children.forEach(node => {
				this.processQuadTreeNode(node, currentChunkIds, children.transform);
			});
		}

		// Remove chunks that are no longer needed
		Object.keys(this.chunks_).forEach(chunkId => {
			if (!currentChunkIds.has(chunkId)) {
				const chunk = this.chunks_[chunkId];
				if (chunk && chunk.mesh) {
					this.group.remove(chunk.mesh);
					chunk.mesh.geometry.dispose();
				}
				delete this.chunks_[chunkId];
			}
		});
	}

	/**
	 * Process a single quadtree node and create ocean chunks
	 */
	processQuadTreeNode(node, currentChunkIds, parentTransform) {
		if (!node) return;

		// Create chunk ID based on node properties
		const chunkId = `${node.size}_${node.bounds ? node.bounds.min.x + '_' + node.bounds.min.z : 'unknown'}`;
		currentChunkIds.add(chunkId);

		if (!this.chunks_[chunkId] && node.size && node.bounds) {
			// Calculate chunk parameters from quadtree node
			const offset = new THREE.Vector3(
				(node.bounds.min.x + node.bounds.max.x) / 2,
				0,
				(node.bounds.min.z + node.bounds.max.z) / 2
			);

			// Create new ocean chunk
			const chunk = this.CreateOceanChunk(
				this.group,
				parentTransform,
				offset,
				node.size,
				ocean_constants.QT_OCEAN_MIN_CELL_RESOLUTION,
				Math.log2(node.size) // Simple LOD based on size
			);

			if (chunk) {
				this.chunks_[chunkId] = chunk;
			}
		}

		// Process children recursively
		if (node.children) {
			node.children.forEach(child => {
				this.processQuadTreeNode(child, currentChunkIds, parentTransform);
			});
		}
	}

	/**
	 * Cleanup method
	 */
	Destroy() {
		// Cleanup all chunks
		Object.values(this.chunks_).forEach(chunk => {
			if (chunk && chunk.mesh) {
				this.group.remove(chunk.mesh);
				chunk.mesh.geometry.dispose();
			}
		});
		this.chunks_ = {};

		// Cleanup other resources
		if (this.group && this.group.parent) {
			this.group.parent.remove(this.group);
		}

		if (this.cubeRenderTarget) {
			this.cubeRenderTarget.dispose();
		}

		if (this.builder_) {
			this.builder_.Destroy?.();
		}
	}
}

export default SphericalOceanChunkManager;