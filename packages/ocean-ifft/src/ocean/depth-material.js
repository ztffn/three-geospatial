// Linear view-space depth encoding material for the ocean depth pre-pass.
// Encodes (-positionView.z - near) / (far - near) into the R channel of a
// HalfFloat RGBA render target. This approach (from WaterPro) avoids the
// Three.js WebGPU restriction that prevents sampling a bound DepthTexture.
// Imported by R3F components via this .js file so three/webgpu is used once.

import { THREE } from '../three-defs.js';
import { Fn, positionView, cameraNear, cameraFar, vec4, float } from 'three/tsl';

export function createLinearDepthMaterial() {
	const mat = new THREE.MeshBasicNodeMaterial();
	mat.side = THREE.DoubleSide;
	mat.colorNode = Fn(() => {
		const d = positionView.z.negate().sub(cameraNear).div(cameraFar.sub(cameraNear));
		return vec4(d, float(0), float(1), float(1));
	})();
	return mat;
}

// Variant for water-occluder volumes (e.g. ship hull interiors): same linear
// depth in R, but G=1 flags the pixel so the water shader can DISCARD the
// surface behind it instead of just suppressing foam. Normal geometry writes
// G=0; the white clear leaves G=1 on empty pixels but their R=far depth never
// satisfies the in-front comparison.
export function createLinearDepthOccluderMaterial() {
	const mat = new THREE.MeshBasicNodeMaterial();
	mat.side = THREE.DoubleSide;
	mat.colorNode = Fn(() => {
		const d = positionView.z.negate().sub(cameraNear).div(cameraFar.sub(cameraNear));
		return vec4(d, float(1), float(1), float(1));
	})();
	return mat;
}
