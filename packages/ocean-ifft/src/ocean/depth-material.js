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
