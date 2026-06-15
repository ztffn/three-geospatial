// Offshore wind-turbine installation rig: a single animated GLB anchored on the
// ENU tangent plane at a fixed geodetic point (static — no buoyancy, unlike
// ShipModel). An AnimationMixer plays one named clip at a time — the 10 install
// phases LoopOnce + clamped (hold the end pose), the operating idle LoopRepeat —
// driven by the `clip` prop; emits onClipFinished so the host can advance the
// install sequence. Placement math mirrors ShipModel/TurbineFarm.

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type FC } from 'react'
import {
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  Quaternion,
  Vector3,
  type AnimationAction,
  type Group,
} from 'three'

import { useGLTF } from '../hooks/useGLTF'
import { enuBasis } from './enu'

// The looping idle clip; every other clip is a one-shot install phase.
const IDLE_CLIP = 'operating_spin'

// The clips are baked fast; halve the native rate so the panel's 1× reads as a
// comfortable speed (i.e. slider 1× = half the clip's baked playback).
const BASE_TIMESCALE = 0.5

export const InstallationRig: FC<{
  url: string
  anchor: Vector3
  scale: number
  heightOffset: number
  eastOffset: number
  northOffset: number
  yawDeg: number
  /** Active animation clip name (one of the GLB's clips). */
  clip: string
  /** Playback speed multiplier applied to the active action. */
  timeScale: number
  /** Fired with the finished clip's name when a one-shot clip completes — the
   * host uses it to advance the install sequence. */
  onClipFinished?: (clip: string) => void
}> = ({
  url,
  anchor,
  scale,
  heightOffset,
  eastOffset,
  northOffset,
  yawDeg,
  clip,
  timeScale,
  onClipFinished,
}) => {
  const gltf = useGLTF(url)
  const groupRef = useRef<Group>(null)

  // Static ENU placement: local +Y aligned to the surface normal, then yaw,
  // positioned by east/north/height offsets from the anchor. Set once (no
  // per-frame buoyancy — the rig is fixed).
  const frame = useMemo(() => {
    const { east, north, up } = enuBasis(anchor)
    const yawQ = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      MathUtils.degToRad(yawDeg)
    )
    const alignQ = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up)
    const quaternion = alignQ.multiply(yawQ)
    const position = anchor
      .clone()
      .addScaledVector(east, eastOffset)
      .addScaledVector(north, northOffset)
      .addScaledVector(up, heightOffset)
    return { position, quaternion }
  }, [anchor, eastOffset, northOffset, heightOffset, yawDeg])

  useEffect(() => {
    const g = groupRef.current
    if (g == null) return
    g.position.copy(frame.position)
    g.quaternion.copy(frame.quaternion)
  }, [frame])

  const mixer = useMemo(() => new AnimationMixer(gltf.scene), [gltf.scene])

  // Latest callback in a ref so the once-bound mixer listener stays current.
  const finishedRef = useRef(onClipFinished)
  finishedRef.current = onClipFinished
  useEffect(() => {
    const onFinished = (event: { action: AnimationAction }): void => {
      finishedRef.current?.(event.action.getClip().name)
    }
    mixer.addEventListener('finished', onFinished)
    return () => {
      mixer.removeEventListener('finished', onFinished)
      mixer.stopAllAction()
    }
  }, [mixer])

  // Latest speed in a ref so changing it doesn't restart the active clip.
  const timeScaleRef = useRef(timeScale)
  timeScaleRef.current = timeScale
  const actionRef = useRef<AnimationAction | null>(null)

  // Switch clips: each clip fully poses the scene, so a hard cut is correct.
  useEffect(() => {
    const animClip = AnimationClip.findByName(gltf.animations, clip)
    if (animClip == null) return
    mixer.stopAllAction()
    const action = mixer.clipAction(animClip)
    action.setLoop(clip === IDLE_CLIP ? LoopRepeat : LoopOnce, Infinity)
    action.clampWhenFinished = clip !== IDLE_CLIP
    action.timeScale = timeScaleRef.current * BASE_TIMESCALE
    action.reset().play()
    actionRef.current = action
  }, [clip, mixer, gltf.animations])

  // Live speed changes without restarting the clip.
  useEffect(() => {
    if (actionRef.current != null) {
      actionRef.current.timeScale = timeScale * BASE_TIMESCALE
    }
  }, [timeScale])

  useFrame((_, delta) => {
    mixer.update(delta)
  })

  return (
    <group ref={groupRef} scale={scale}>
      <primitive object={gltf.scene} />
    </group>
  )
}
