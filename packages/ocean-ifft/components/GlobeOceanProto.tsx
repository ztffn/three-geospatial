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
  useRef,
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

const heading = 180;
const pitch = -20;
const distance = 3500;
const globalTerrainAssetId = 1;
const japanRegionalTerrainAssetId = 2767062;

const locationPresets = {
  Tokyo: { longitude: 139.7671, latitude: 35.6812, height: 20 },
  Oslo: { longitude: 10.7522, latitude: 59.9139, height: 20 },
  'New York': { longitude: -74.006, latitude: 40.7128, height: 20 },
  'Cape Town': { longitude: 18.4241, latitude: -33.9249, height: 20 },
  Sydney: { longitude: 151.2093, latitude: -33.8688, height: 20 },
  Reykjavik: { longitude: -21.9426, latitude: 64.1466, height: 20 },
} satisfies Record<
  string,
  { longitude: number; latitude: number; height: number }
>;

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

function getLocalDate(
  longitudeDegrees: number,
  dayOfYear: number,
  timeOfDay: number,
  year: number
): Date {
  const epoch = Date.UTC(year, 0, 1, 0, 0, 0, 0);
  const offset = longitudeDegrees / 15;
  return new Date(epoch + ((dayOfYear - 1) * 24 + timeOfDay - offset) * 3600000);
}

function isInsideJapanRegionalTerrain(longitudeDegrees: number, latitudeDegrees: number): boolean {
  return (
    longitudeDegrees >= 122 &&
    longitudeDegrees <= 154 &&
    latitudeDegrees >= 20 &&
    latitudeDegrees <= 46
  );
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

function useTargetECEF(
  longitudeDegrees: number,
  latitudeDegrees: number,
  targetHeight: number
): THREE.Vector3 {
  return useMemo(
    () =>
      new Geodetic(
        radians(longitudeDegrees),
        radians(latitudeDegrees),
        targetHeight
      ).toECEF(),
    [latitudeDegrees, longitudeDegrees, targetHeight]
  );
}

const OceanSurface: FC<{
  target: THREE.Vector3;
  atmosphereContext: AtmosphereContextNode;
  onWaveGeneratorReady: (waveGenerator: any) => void;
  onOceanManagerReady: (oceanManager: any) => void;
}> = ({
  target,
  atmosphereContext,
  onWaveGeneratorReady,
  onOceanManagerReady,
}) => {
  const [waveGenerator, setWaveGenerator] = useState<any>(null);
  const [oceanParent, setOceanParent] = useState<THREE.Group | null>(null);
  const { seaLevelOffset, oceanScale } = useControls('Globe Ocean', {
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
  }, [matrix, oceanParent]);

  return (
    <>
      <WaveGeneratorComponent
        onInitialized={waveGenerator => {
          setWaveGenerator(waveGenerator);
          onWaveGeneratorReady(waveGenerator);
        }}
      />
      <group ref={handleOceanParent} matrixAutoUpdate={false} />
      {oceanParent != null && waveGenerator != null ? (
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

const CameraFlyTo: FC<{ target: THREE.Vector3 }> = ({ target }) => {
  const camera = useThree(({ camera }) => camera);
  const controls = useThree(({ controls }) => controls as any);
  const initialized = useRef(false);
  const flight = useMemo(
    () => ({
      active: false,
      progress: 1,
      fromPosition: new THREE.Vector3(),
      toPosition: new THREE.Vector3(),
      fromTarget: new THREE.Vector3(),
      toTarget: new THREE.Vector3(),
      fromQuaternion: new THREE.Quaternion(),
      toQuaternion: new THREE.Quaternion(),
      fromUp: new THREE.Vector3(),
      toUp: new THREE.Vector3(),
    }),
    []
  );

  useLayoutEffect(() => {
    const nextCamera = new THREE.PerspectiveCamera();
    new PointOfView(distance, radians(heading), radians(pitch)).decompose(
      target,
      nextCamera.position,
      nextCamera.quaternion,
      nextCamera.up
    );

    if (!initialized.current) {
      initialized.current = true;
      camera.position.copy(nextCamera.position);
      camera.quaternion.copy(nextCamera.quaternion);
      camera.up.copy(nextCamera.up);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      if (controls?.target != null) {
        controls.target.copy(target);
        controls.update?.();
      }
      return;
    }

    flight.active = true;
    flight.progress = 0;
    flight.fromPosition.copy(camera.position);
    flight.toPosition.copy(nextCamera.position);
    flight.fromTarget.copy(controls?.target ?? target);
    flight.toTarget.copy(target);
    flight.fromQuaternion.copy(camera.quaternion);
    flight.toQuaternion.copy(nextCamera.quaternion);
    flight.fromUp.copy(camera.up);
    flight.toUp.copy(nextCamera.up);
  }, [camera, controls, flight, target]);

  useFrame((_, delta) => {
    if (!flight.active) return;
    flight.progress = Math.min(flight.progress + delta / 2.5, 1);
    const t = flight.progress * flight.progress * (3 - 2 * flight.progress);

    camera.position.lerpVectors(flight.fromPosition, flight.toPosition, t);
    camera.quaternion.slerpQuaternions(
      flight.fromQuaternion,
      flight.toQuaternion,
      t
    );
    camera.up.lerpVectors(flight.fromUp, flight.toUp, t).normalize();
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    if (controls?.target != null) {
      controls.target.lerpVectors(flight.fromTarget, flight.toTarget, t);
      controls.update?.();
    }

    if (flight.progress >= 1) {
      flight.active = false;
    }
  });

  return null;
};

const Content: FC = () => {
  const renderer = useThree<THREE.Renderer>(({ gl }) => gl as any);
  const scene = useThree(({ scene }) => scene);
  const camera = useThree(({ camera }) => camera);
  const [waveGenerator, setWaveGenerator] = useState<any>(null);
  const [oceanManager, setOceanManager] = useState<any>(null);
  const [loadedPresets, setLoadedPresets] = useState<Record<string, OceanPreset>>({});
  const overlayScene = useMemo(() => new Scene(), []);
  const context = useMemo(() => new AtmosphereContextNode(), []);
  const locationControls = useControls('Location', {
    preset: {
      value: 'Tokyo',
      options: [...Object.keys(locationPresets), 'Custom'],
      label: 'Fly to',
    },
    longitude: {
      value: locationPresets.Tokyo.longitude,
      min: -180,
      max: 180,
      step: 0.0001,
    },
    latitude: {
      value: locationPresets.Tokyo.latitude,
      min: -90,
      max: 90,
      step: 0.0001,
    },
    height: {
      value: locationPresets.Tokyo.height,
      min: -500,
      max: 5000,
      step: 1,
    },
  });
  const activeLocation =
    locationControls.preset === 'Custom'
      ? locationControls
      : locationPresets[locationControls.preset as keyof typeof locationPresets] ??
        locationPresets.Tokyo;
  const target = useTargetECEF(
    activeLocation.longitude,
    activeLocation.latitude,
    activeLocation.height
  );
  const atmosphereControls = useControls('Atmosphere Controls', {
    exposure: { value: 10, min: 0, max: 30, step: 0.25 },
    dayOfYear: { value: 152, min: 0, max: 364, step: 1 },
    timeOfDay: { value: 12, min: 0, max: 24, step: 0.1, label: 'Local time' },
    year: { value: 2025, min: 2000, max: 2050, step: 1 },
    showGround: { value: true },
    showSun: { value: true },
    showMoon: { value: true },
    showStars: { value: true },
    moonIntensity: { value: 25, min: 0, max: 100, step: 1 },
    starsIntensity: { value: 20, min: 0, max: 100, step: 1 },
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
    return getLocalDate(
      activeLocation.longitude,
      atmosphereControls.dayOfYear,
      atmosphereControls.timeOfDay,
      atmosphereControls.year
    );
  }, [
    activeLocation.longitude,
    atmosphereControls.dayOfYear,
    atmosphereControls.timeOfDay,
    atmosphereControls.year,
  ]);
  const terrainControls = useControls('Terrain', {
    source: {
      value: 'Auto',
      options: ['Auto', 'Global', 'Japan Regional'],
    },
  });
  const terrainAssetId =
    terrainControls.source === 'Japan Regional' ||
    (terrainControls.source === 'Auto' &&
      isInsideJapanRegionalTerrain(
        activeLocation.longitude,
        activeLocation.latitude
      ))
      ? japanRegionalTerrainAssetId
      : globalTerrainAssetId;

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
    getSunDirectionECI(atmosphereDate, context.sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF
    );
    getMoonDirectionECI(atmosphereDate, context.moonDirectionECEF.value).applyMatrix4(
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
        enableDamping
        minDistance={500}
        maxDistance={100000}
      />
      <CameraFlyTo target={target} />
      {/* Depth-foam probe — capsule at the fly-to target so the depth pre-pass
          has visible geometry for the ocean material to sample. Layer 0 (default)
          so it's included in the depth pre-pass. Sized in world units (meters). */}
      <mesh position={target.toArray()}>
        <capsuleGeometry args={[80, 600, 8, 24]} />
        <meshBasicMaterial color='#ff6b3d' />
      </mesh>
      <TilesRenderer key={terrainAssetId}>
        <TilesPlugin
          plugin={CesiumIonAuthPlugin}
          args={{
            apiToken: ionToken,
            assetId: terrainAssetId,
            autoRefreshToken: true,
          }}
        />
        <TilesPlugin plugin={TileMaterialReplacementPlugin} />
      </TilesRenderer>
      <OceanSurface
        target={target}
        atmosphereContext={context}
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
