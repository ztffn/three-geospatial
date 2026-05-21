'use client';

import { OrbitControls } from '@react-three/drei';
import {
  Canvas,
  extend,
  useFrame,
  useThree,
  type ThreeElement,
} from '@react-three/fiber';
import { TilesPlugin, TilesRenderer } from '3d-tiles-renderer/r3f';
import { CesiumIonAuthPlugin } from '3d-tiles-renderer/plugins';
import { useControls } from 'leva';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type FC,
} from 'react';
import { Mesh, Scene } from 'three';
import { pass, toneMapping, uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI,
} from '@takram/three-atmosphere';
import {
  aerialPerspective,
  AtmosphereContextNode,
  AtmosphereLight,
  AtmosphereLightNode,
  StarsNode,
} from '@takram/three-atmosphere/webgpu';
import { Ellipsoid, Geodetic, PointOfView, radians } from '@takram/three-geospatial';
import {
  dithering,
  lensFlare,
} from '@takram/three-geospatial/webgpu';
import OceanChunks from './OceanChunks';
import WaveGeneratorComponent from './WaveGenerator';
// @ts-expect-error - JS module
import { wave_constants } from '../src/waves/wave-constants.js';

extend({ AtmosphereLight });

declare module '@react-three/fiber' {
  interface ThreeElements {
    atmosphereLight: ThreeElement<typeof AtmosphereLight>;
  }
}

const longitude = 139.7671;
const latitude = 35.6812;
const height = 20;
const heading = 180;
const pitch = -20;
const distance = 3500;

interface OceanPreset {
  name: string;
  firstWave?: Record<string, number>;
  secondWave?: Record<string, number>;
  foam?: {
    strength?: number;
    threshold?: number;
  };
  ocean?: {
    lodScale?: number;
  };
}

function buildWaveControls(
  dataset: Record<string, { value: number }>,
  borders: Record<string, { min: number; max: number }>
): Record<string, { value: number; min: number; max: number; step: number }> {
  const controls: Record<
    string,
    { value: number; min: number; max: number; step: number }
  > = {};
  for (const param of Object.keys(dataset)) {
    const border = borders[param];
    if (border != null) {
      controls[param] = {
        value: dataset[param].value,
        min: border.min,
        max: border.max,
        step: 0.001,
      };
    }
  }
  return controls;
}

function applyOceanPreset(preset: OceanPreset): void {
  if (preset.firstWave != null) {
    for (const key in preset.firstWave) {
      if (wave_constants.FIRST_WAVE_DATASET[key] != null) {
        wave_constants.FIRST_WAVE_DATASET[key].value = preset.firstWave[key];
      }
    }
  }
  if (preset.secondWave != null) {
    for (const key in preset.secondWave) {
      if (wave_constants.SECOND_WAVE_DATASET[key] != null) {
        wave_constants.SECOND_WAVE_DATASET[key].value = preset.secondWave[key];
      }
    }
  }
  if (preset.foam?.strength != null) {
    wave_constants.FOAM_STRENGTH.value = preset.foam.strength;
  }
  if (preset.foam?.threshold != null) {
    wave_constants.FOAM_THRESHOLD.value = preset.foam.threshold;
  }
  if (preset.ocean?.lodScale != null) {
    wave_constants.LOD_SCALE.value = preset.ocean.lodScale;
  }
}

function updateWaveGenerator(waveGenerator: any): void {
  if (waveGenerator?.cascades == null) return;
  for (const cascade of waveGenerator.cascades) {
    cascade.initialSpectrum?.Update?.();
  }
}

interface TilesEventTarget {
  addEventListener: (type: string, listener: (event: { scene: THREE.Object3D }) => void) => void;
  removeEventListener: (type: string, listener: (event: { scene: THREE.Object3D }) => void) => void;
  group: THREE.Group;
}

class TileMaterialReplacementPlugin {
  private tiles?: TilesEventTarget;

  init(tiles: TilesEventTarget): void {
    this.tiles = tiles;
    tiles.group.traverse(object => {
      replaceMaterial(object);
    });
    tiles.addEventListener('load-model', this.handleLoadModel);
    tiles.addEventListener('dispose-model', this.handleDisposeModel);
  }

  dispose(): void {
    this.tiles?.removeEventListener('load-model', this.handleLoadModel);
    this.tiles?.removeEventListener('dispose-model', this.handleDisposeModel);
  }

  private readonly handleLoadModel = ({ scene }: { scene: THREE.Object3D }): void => {
    if (this.tiles == null) return;
    scene.traverse(object => {
      replaceMaterial(object);
    });
  };

  private readonly handleDisposeModel = ({ scene }: { scene: THREE.Object3D }): void => {
    if (this.tiles == null) return;
    scene.traverse(object => {
      if (object instanceof Mesh) {
        object.material.dispose();
      }
    });
  };
}

function replaceMaterial(object: THREE.Object3D): void {
  if (!(object instanceof Mesh)) return;
  const sourceMaterial = object.material;
  if (Array.isArray(sourceMaterial)) return;

  object.geometry.computeVertexNormals();

  const material = new THREE.MeshLambertNodeMaterial({
    color: '#6f7f68',
  });
  if ('map' in sourceMaterial && sourceMaterial.map != null) {
    material.map = sourceMaterial.map.clone();
  }
  object.material = material;
  sourceMaterial.dispose();
}

function usePointOfView(): THREE.Vector3 {
  const camera = useThree(({ camera }) => camera);
  const target = useMemo(
    () =>
      new Geodetic(radians(longitude), radians(latitude), height).toECEF(),
    []
  );

  useLayoutEffect(() => {
    new PointOfView(distance, radians(heading), radians(pitch)).decompose(
      target,
      camera.position,
      camera.quaternion,
      camera.up
    );
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }, [camera, target]);

  return target;
}

const OceanSurface: FC<{
  target: THREE.Vector3;
  atmosphereContext: AtmosphereContextNode;
  showOceanChunks: boolean;
  showOceanDebugPlane: boolean;
  showOceanMarker: boolean;
  onWaveGeneratorReady: (waveGenerator: any) => void;
  onOceanManagerReady: (oceanManager: any) => void;
}> = ({
  target,
  atmosphereContext,
  showOceanChunks,
  showOceanDebugPlane,
  showOceanMarker,
  onWaveGeneratorReady,
  onOceanManagerReady,
}) => {
  const [waveGenerator, setWaveGenerator] = useState<any>(null);
  const [oceanParent, setOceanParent] = useState<THREE.Group | null>(null);
  const { seaLevelOffset, oceanScale, debugPlaneSize } = useControls('Globe Ocean', {
    seaLevelOffset: {
      value: 50,
      min: -500,
      max: 5000,
      step: 1,
      label: 'Sea level offset',
    },
    oceanScale: {
      value: 1,
      min: 0.1,
      max: 5,
      step: 0.05,
      label: 'Ocean scale',
    },
    debugPlaneSize: {
      value: 20000,
      min: 1000,
      max: 200000,
      step: 1000,
      label: 'Debug plane size',
    },
  });
  const handleOceanParent = useCallback((group: THREE.Group | null) => {
    setOceanParent(group);
  }, []);
  const matrix = useMemo(() => {
    const east = new THREE.Vector3();
    const north = new THREE.Vector3();
    const up = new THREE.Vector3();
    Ellipsoid.WGS84.getEastNorthUpVectors(target, east, north, up);

    const result = new THREE.Matrix4().makeBasis(
      east.multiplyScalar(oceanScale),
      up,
      north.multiplyScalar(oceanScale)
    );
    result.setPosition(target.clone().addScaledVector(up, seaLevelOffset));
    return result;
  }, [oceanScale, seaLevelOffset, target]);

  useLayoutEffect(() => {
    if (oceanParent == null) return;
    oceanParent.matrix.copy(matrix);
    oceanParent.matrixWorldNeedsUpdate = true;
    oceanParent.updateMatrixWorld(true);
    console.info('[GlobeOcean] frame updated', {
      seaLevelOffset,
      oceanScale,
      debugPlaneSize,
    });
  }, [debugPlaneSize, matrix, oceanParent, oceanScale, seaLevelOffset]);

  return (
    <>
      <WaveGeneratorComponent
        onInitialized={waveGenerator => {
          setWaveGenerator(waveGenerator);
          onWaveGeneratorReady(waveGenerator);
        }}
      />
      <group ref={handleOceanParent} matrixAutoUpdate={false}>
        {showOceanDebugPlane ? (
          <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
            <planeGeometry args={[debugPlaneSize, debugPlaneSize]} />
            <meshBasicMaterial
              color="#00d5ff"
              depthWrite={false}
              opacity={0.35}
              side={THREE.DoubleSide}
              transparent
              wireframe
            />
          </mesh>
        ) : null}
        {showOceanMarker ? (
          <>
            <mesh position={[0, 0, 0]} renderOrder={11}>
              <sphereGeometry args={[120, 16, 16]} />
              <meshBasicMaterial color="#ffdd00" depthWrite={false} />
            </mesh>
            <mesh position={[0, 750, 0]} renderOrder={11}>
              <boxGeometry args={[80, 1500, 80]} />
              <meshBasicMaterial color="#ff3366" depthWrite={false} />
            </mesh>
          </>
        ) : null}
      </group>
      {showOceanChunks && oceanParent != null && waveGenerator != null ? (
        <OceanChunks
          waveGenerator={waveGenerator}
          parent={oceanParent}
          atmosphereContext={atmosphereContext}
          onOceanManagerReady={onOceanManagerReady}
        />
      ) : null}
    </>
  );
};

const Content: FC = () => {
  const renderer = useThree<THREE.Renderer>(({ gl }) => gl as any);
  const scene = useThree(({ scene }) => scene);
  const camera = useThree(({ camera }) => camera);
  const target = usePointOfView();
  const [waveGenerator, setWaveGenerator] = useState<any>(null);
  const [oceanManager, setOceanManager] = useState<any>(null);
  const [loadedPresets, setLoadedPresets] = useState<Record<string, OceanPreset>>({});
  const overlayScene = useMemo(() => new Scene(), []);
  const context = useMemo(() => new AtmosphereContextNode(), []);
  const atmosphereControls = useControls('Atmosphere Controls', {
    exposure: { value: 3, min: 0, max: 30, step: 0.25 },
    dayOfYear: { value: 152, min: 0, max: 364, step: 1 },
    timeOfDay: { value: 3, min: 0, max: 24, step: 0.1 },
    showGround: { value: true },
    showSun: { value: true },
    showMoon: { value: true },
    showStars: { value: true },
    moonIntensity: { value: 25, min: 0, max: 100, step: 1 },
    starsIntensity: { value: 20, min: 0, max: 100, step: 1 },
  });
  const {
    showTerrain,
    showOceanChunks,
    showOceanDebugPlane,
    showOceanMarker,
  } = useControls('Globe Debug', {
    showTerrain: {
      value: true,
      label: 'Terrain tiles',
    },
    showOceanChunks: {
      value: true,
      label: 'IFFT ocean chunks',
    },
    showOceanDebugPlane: {
      value: true,
      label: 'Ocean debug plane',
    },
    showOceanMarker: {
      value: true,
      label: 'Ocean frame marker',
    },
  });
  const firstWaveControls = useMemo(
    () =>
      buildWaveControls(
        wave_constants.FIRST_WAVE_DATASET,
        wave_constants.FIRST_WAVE_BORDERS
      ),
    []
  );
  const secondWaveControls = useMemo(
    () =>
      buildWaveControls(
        wave_constants.SECOND_WAVE_DATASET,
        wave_constants.SECOND_WAVE_BORDERS
      ),
    []
  );
  const firstWaveParams = useControls('First Wave Spectrum', firstWaveControls);
  const secondWaveParams = useControls('Second Wave Spectrum', secondWaveControls);
  const foamParams = useControls('Foam', {
    strength: {
      value: wave_constants.FOAM_STRENGTH.value,
      min: 0,
      max: 5,
      step: 0.1,
    },
    threshold: {
      value: wave_constants.FOAM_THRESHOLD.value,
      min: 0,
      max: 5,
      step: 0.1,
    },
  });
  const oceanMaterialParams = useControls('Ocean Material', {
    lodScale: {
      value: wave_constants.LOD_SCALE.value,
      min: 0,
      max: 20,
      step: 0.1,
    },
    wireframe: {
      value: false,
    },
  });
  const presetOptions = useMemo(() => Object.keys(loadedPresets), [loadedPresets]);
  const presetControls = useControls(
    'Ocean Presets',
    {
      preset: {
        value: presetOptions.includes('Average') ? 'Average' : presetOptions[0] ?? 'Loading...',
        options: presetOptions.length > 0 ? presetOptions : ['Loading...'],
      },
    },
    [presetOptions]
  );
  const postProcessingData = useMemo(() => {
    context.camera = camera;

    const passNode = pass(scene, camera, { samples: 0 });
    const colorNode = passNode.getTextureNode('output');
    const depthNode = passNode.getTextureNode('depth');

    const aerialNode = aerialPerspective(
      context,
      colorNode.mul(0.55),
      depthNode
    );
    const skyNode = (aerialNode as any).skyNode;
    if (skyNode != null) {
      skyNode.showSun = atmosphereControls.showSun;
      skyNode.showMoon = atmosphereControls.showMoon;
      if (skyNode.moonNode != null) {
        skyNode.moonNode.intensity.value = atmosphereControls.moonIntensity;
      }
      if (atmosphereControls.showStars) {
        const starsNode = new StarsNode(
          context,
          new URL('../public/atmosphere/stars.bin', import.meta.url).href
        );
        starsNode.intensity.value = atmosphereControls.starsIntensity;
        skyNode.starsNode = starsNode;
      }
    }
    const lensFlareNode = lensFlare(aerialNode);
    const toneMappingNode = toneMapping(
      THREE.AgXToneMapping,
      uniform(atmosphereControls.exposure),
      lensFlareNode
    );
    const overlayPassNode = pass(overlayScene, camera, {
      samples: 0,
      depthBuffer: false,
    });

    const result = new THREE.PostProcessing(renderer);
    result.outputNode = toneMappingNode
      .add(dithering)
      .mul(overlayPassNode.a.oneMinus())
      .add(overlayPassNode);
    return { postProcessing: result, skyNode };
  }, [
    atmosphereControls.exposure,
    atmosphereControls.moonIntensity,
    atmosphereControls.showMoon,
    atmosphereControls.showStars,
    atmosphereControls.showSun,
    atmosphereControls.starsIntensity,
    camera,
    context,
    overlayScene,
    renderer,
    scene,
  ]);
  const atmosphereDate = useMemo(() => {
    const date = new Date(Date.UTC(2025, 0, 1));
    date.setUTCDate(atmosphereControls.dayOfYear + 1);
    const hours = Math.floor(atmosphereControls.timeOfDay);
    const minutes = Math.round((atmosphereControls.timeOfDay - hours) * 60);
    date.setUTCHours(hours, minutes, 0, 0);
    return date;
  }, [atmosphereControls.dayOfYear, atmosphereControls.timeOfDay]);

  useEffect(() => {
    const loadPresets = async (): Promise<void> => {
      try {
        const indexResponse = await fetch(
          new URL('../presets/ocean/index.json', import.meta.url).href
        );
        const index = await indexResponse.json();
        const presets: Record<string, OceanPreset> = {};
        for (const presetInfo of index.presets) {
          const presetResponse = await fetch(
            new URL(`../presets/ocean/${presetInfo.file}`, import.meta.url).href
          );
          const preset = await presetResponse.json();
          presets[preset.name] = preset;
        }
        setLoadedPresets(presets);
      } catch (error) {
        console.error('Failed to load ocean presets:', error);
        setLoadedPresets({});
      }
    };

    void loadPresets();
  }, []);

  useEffect(() => {
    const preset = loadedPresets[presetControls.preset];
    if (preset == null) return;
    applyOceanPreset(preset);
    updateWaveGenerator(waveGenerator);
  }, [loadedPresets, presetControls.preset, waveGenerator]);

  useEffect(() => {
    if (waveGenerator == null) return;
    for (const param in firstWaveParams) {
      if (wave_constants.FIRST_WAVE_DATASET[param] != null) {
        wave_constants.FIRST_WAVE_DATASET[param].value = firstWaveParams[param];
      }
    }
    for (const param in secondWaveParams) {
      if (wave_constants.SECOND_WAVE_DATASET[param] != null) {
        wave_constants.SECOND_WAVE_DATASET[param].value = secondWaveParams[param];
      }
    }
    wave_constants.FOAM_STRENGTH.value = foamParams.strength;
    wave_constants.FOAM_THRESHOLD.value = foamParams.threshold;
    wave_constants.LOD_SCALE.value = oceanMaterialParams.lodScale;
    updateWaveGenerator(waveGenerator);
  }, [
    firstWaveParams,
    foamParams.strength,
    foamParams.threshold,
    oceanMaterialParams.lodScale,
    secondWaveParams,
    waveGenerator,
  ]);

  useEffect(() => {
    if (oceanManager?.material_ == null) return;
    oceanManager.material_.wireframe = oceanMaterialParams.wireframe;
  }, [oceanManager, oceanMaterialParams.wireframe]);

  useEffect(() => {
    context.showGround = atmosphereControls.showGround;
    postProcessingData.postProcessing.needsUpdate = true;
  }, [atmosphereControls.showGround, context, postProcessingData]);

  useEffect(() => {
    renderer.library.addLight(AtmosphereLightNode, AtmosphereLight);
    return () => {
      context.dispose();
    };
  }, [context, renderer]);

  useFrame(() => {
    camera.updateMatrixWorld();
    const matrixECIToECEF = getECIToECEFRotationMatrix(
      atmosphereDate,
      context.matrixECIToECEF.value
    );
    getSunDirectionECI(atmosphereDate, context.sunDirectionECEF.value, camera.position).applyMatrix4(
      matrixECIToECEF
    );
    getMoonDirectionECI(atmosphereDate, context.moonDirectionECEF.value, camera.position).applyMatrix4(
      matrixECIToECEF
    );
  });

  useFrame(() => {
    postProcessingData.postProcessing.render();
  }, 1);

  const ionToken =
    import.meta.env.STORYBOOK_ION_API_TOKEN ??
    import.meta.env.VITE_CESIUM_ION_TOKEN;

  return (
    <>
      <atmosphereLight args={[context]} />
      <OrbitControls
        makeDefault
        target={target.toArray()}
        enableDamping
        minDistance={500}
        maxDistance={100000}
      />
      {showTerrain ? (
        <TilesRenderer>
          <TilesPlugin
            plugin={CesiumIonAuthPlugin}
            args={{
              apiToken: ionToken,
              assetId: 2767062,
              autoRefreshToken: true,
            }}
          />
          <TilesPlugin plugin={TileMaterialReplacementPlugin} />
        </TilesRenderer>
      ) : null}
      <OceanSurface
        target={target}
        atmosphereContext={context}
        showOceanChunks={showOceanChunks}
        showOceanDebugPlane={showOceanDebugPlane}
        showOceanMarker={showOceanMarker}
        onWaveGeneratorReady={setWaveGenerator}
        onOceanManagerReady={setOceanManager}
      />
    </>
  );
};

const GlobeOceanProto: FC = () => (
  <Canvas
    camera={{ fov: 45, near: 1, far: 1e8 }}
    gl={async glProps => {
      const renderer = new THREE.WebGPURenderer({
        ...glProps,
        antialias: true,
        logarithmicDepthBuffer: true,
      } as any);
      renderer.highPrecision = true;
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      await renderer.init();
      return renderer;
    }}
    style={{ width: '100vw', height: '100vh', background: '#101820' }}
  >
    <Content />
  </Canvas>
);

export default GlobeOceanProto;
