import { useFrame, useLoader } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type FC } from 'react'
import { TextureLoader, type Color } from 'three'

import {
  createFishSchoolSystem,
  type FishSchoolSystem,
  type FishSchoolValues
} from './createFishSchoolSystem'

export interface FishSchoolProps extends Partial<FishSchoolValues> {
  textureUrl: string
  /** Optional OpenGL tangent-space normal map (same canvas/frames as textureUrl). */
  normalUrl?: string
  textureFrames?: number
  maxCount?: number
  fishLength?: number
  fishHeight?: number
  fishWidthSegments?: number
  color?: Color | string | number
  seed?: number
  position?: [number, number, number]
}

export const FishSchool: FC<FishSchoolProps> = props => {
  const initialValuesRef = useRef(props)
  const {
    textureUrl,
    normalUrl,
    textureFrames,
    maxCount,
    fishLength,
    fishHeight,
    fishWidthSegments,
    color,
    seed,
    position = [0, 0, 0]
  } = props

  const texture = useLoader(TextureLoader, textureUrl)

  const system = useMemo(
    () =>
      createFishSchoolSystem({
        texture,
        normalUrl,
        textureFrames,
        maxCount,
        fishLength,
        fishHeight,
        fishWidthSegments,
        color,
        seed,
        count: initialValuesRef.current.count,
        radiusX: initialValuesRef.current.radiusX,
        radiusZ: initialValuesRef.current.radiusZ,
        depth: initialValuesRef.current.depth,
        size: initialValuesRef.current.size,
        speed: initialValuesRef.current.speed,
        wander: initialValuesRef.current.wander,
        turnRate: initialValuesRef.current.turnRate,
        opacity: initialValuesRef.current.opacity,
        currentX: initialValuesRef.current.currentX,
        currentZ: initialValuesRef.current.currentZ,
        flock: initialValuesRef.current.flock,
        flockScale: initialValuesRef.current.flockScale,
        flockGroups: initialValuesRef.current.flockGroups,
        metalness: initialValuesRef.current.metalness,
        roughness: initialValuesRef.current.roughness,
        brightness: initialValuesRef.current.brightness,
        tailBeat: initialValuesRef.current.tailBeat,
        tailAmplitude: initialValuesRef.current.tailAmplitude
      }),
    [
      color,
      fishHeight,
      fishLength,
      fishWidthSegments,
      maxCount,
      normalUrl,
      seed,
      texture,
      textureFrames
    ]
  )

  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    return () => {
      system.dispose()
    }
  }, [system])

  useEffect(() => {
    system.object3D.position.set(...position)
  }, [position, system])

  useFrame((_, delta) => {
    system.sync(propsRef.current)
    system.update(delta)
  })

  return <primitive object={system.object3D} />
}

export type { FishSchoolSystem, FishSchoolValues }
