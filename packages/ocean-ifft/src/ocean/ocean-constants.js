import {THREE} from '../three-defs.js';


export const ocean_constants = (() => {
  	return {
		QT_OCEAN_MIN_LOD_RADIUS: 1000, // Increased for debugging
		QT_OCEAN_MIN_NUM_LAYERS: 15,	
		QT_OCEAN_MIN_CELL_RESOLUTION: 36,	//even numbers only
		QT_OCEAN_MIN_CELL_SIZE: 500, // Minimum cell size for quadtree
		OCEAN_SIZE: 500000,
  	}
	
})();
