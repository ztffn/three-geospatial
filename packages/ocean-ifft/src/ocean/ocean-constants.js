import {THREE} from '../three-defs.js';


export const ocean_constants = (() => {
  	return {
		// Innermost CDLOD ring radius (metres). Every quadtree LOD ring is
		// derived from this, and the WGSL vertex stage's minLodRadius uniform
		// must carry the SAME value or `lod == n` never matches and the morph
		// silently disables (T-junction cracks at every tile boundary).
		// Consumers must import it — never re-derive it (ocean-material.js and
		// OceanChunksWaterpro.tsx both import).
		QT_OCEAN_MIN_LOD_RADIUS: 1000,
		QT_OCEAN_MIN_NUM_LAYERS: 15,	
		QT_OCEAN_MIN_CELL_RESOLUTION: 36,	//even numbers only
		QT_OCEAN_MIN_CELL_SIZE: 500, // Minimum cell size for quadtree
		OCEAN_SIZE: 500000,
  	}
	
})();
