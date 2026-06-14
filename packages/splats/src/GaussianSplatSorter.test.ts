import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import { CPUSplatSorter, SortTrigger } from './GaussianSplatSorter'

describe('CPUSplatSorter', () => {
  it('orders splats back-to-front (farthest first)', () => {
    // Three splats along +X at increasing distance from a camera at the origin.
    const positions = new Float32Array([1, 0, 0, 5, 0, 0, 3, 0, 0])
    const sorter = new CPUSplatSorter(1024)
    const order = sorter.sort(positions, new Vector3(0, 0, 0), 3)
    // Farthest (index 1, x=5) first; nearest (index 0, x=1) last.
    expect(Array.from(order)).toEqual([1, 2, 0])
  })

  it('reflects camera position when ordering', () => {
    const positions = new Float32Array([1, 0, 0, 5, 0, 0, 3, 0, 0])
    const sorter = new CPUSplatSorter(1024)
    // Camera beyond the far splat: ordering reverses.
    const order = sorter.sort(positions, new Vector3(10, 0, 0), 3)
    expect(Array.from(order)).toEqual([0, 2, 1])
  })

  it('handles a degenerate single-distance set without throwing', () => {
    const positions = new Float32Array([2, 0, 0, 2, 0, 0])
    const sorter = new CPUSplatSorter(1024)
    const order = sorter.sort(positions, new Vector3(0, 0, 0), 2)
    expect(order.length).toBe(2)
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1])
  })
})

describe('SortTrigger', () => {
  const centroid = new Vector3(0, 0, 0)

  it('requests a sort on first evaluation', () => {
    const trigger = new SortTrigger(0.5)
    expect(trigger.shouldSort(new Vector3(0, 0, 10), centroid)).toBe(true)
  })

  it('suppresses sorts below the angle threshold', () => {
    const trigger = new SortTrigger(0.5)
    const a = new Vector3(0, 0, 10)
    trigger.markSorted(a, centroid)
    // A tiny lateral nudge stays under 0.5 degrees.
    expect(trigger.shouldSort(new Vector3(0.01, 0, 10), centroid)).toBe(false)
  })

  it('requests a sort once the camera rotates past the threshold', () => {
    const trigger = new SortTrigger(0.5)
    trigger.markSorted(new Vector3(0, 0, 10), centroid)
    // 90 degrees around the centroid is well past threshold.
    expect(trigger.shouldSort(new Vector3(10, 0, 0), centroid)).toBe(true)
  })
})
