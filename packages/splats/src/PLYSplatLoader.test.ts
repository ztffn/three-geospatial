import { describe, expect, it } from 'vitest'

import { parsePLYSplat } from './PLYSplatLoader'

const PROPERTIES = [
  'x',
  'y',
  'z',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3'
]

function buildPLY(vertices: number[][]): ArrayBuffer {
  const header =
    `ply\n` +
    `format binary_little_endian 1.0\n` +
    `element vertex ${vertices.length}\n${ 
    PROPERTIES.map(name => `property float ${name}`).join('\n') 
    }\nend_header\n`
  const headerBytes = new TextEncoder().encode(header)
  const stride = PROPERTIES.length * 4
  const buffer = new ArrayBuffer(headerBytes.length + vertices.length * stride)
  new Uint8Array(buffer).set(headerBytes)
  const view = new DataView(buffer, headerBytes.length)
  vertices.forEach((vertex, i) => {
    vertex.forEach((value, j) => {
      view.setFloat32(i * stride + j * 4, value, true)
    })
  })
  return buffer
}

const SH_C0 = 0.28209479177387814

describe('parsePLYSplat', () => {
  it('parses positions, scales and rotations of a binary splat PLY', () => {
    const buffer = buildPLY([
      // x, y, z, f_dc(3), opacity, scale(3), rot(4: w,x,y,z)
      [1, 2, 3, 0, 0, 0, 0, -1, -2, -3, 1, 0, 0, 0],
      [4, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]
    ])
    const data = parsePLYSplat(buffer)

    expect(data.count).toBe(2)
    expect(Array.from(data.positions)).toEqual([1, 2, 3, 4, 5, 6])
    // Scales are preserved in log space.
    expect(Array.from(data.scales.subarray(0, 3))).toEqual([-1, -2, -3])
    // Quaternions are normalized WXYZ; an already-unit quat is unchanged.
    expect(Array.from(data.rotations.subarray(0, 4))).toEqual([1, 0, 0, 0])
    expect(Array.from(data.rotations.subarray(4, 8))).toEqual([0, 1, 0, 0])
  })

  it('resolves the SH DC term and opacity sigmoid into RGBA bytes', () => {
    // f_dc = 0 -> color 0.5 -> 128; opacity 0 -> sigmoid 0.5 -> 128.
    const buffer = buildPLY([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]])
    const data = parsePLYSplat(buffer)
    const expected = Math.round((0.5 + SH_C0 * 0) * 255)
    expect(data.colors[0]).toBe(expected)
    expect(data.colors[1]).toBe(expected)
    expect(data.colors[2]).toBe(expected)
    expect(data.colors[3]).toBe(128) // sigmoid(0) = 0.5
  })

  it('normalizes non-unit quaternions', () => {
    const buffer = buildPLY([[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 4]])
    const data = parsePLYSplat(buffer)
    const [w, x, y, z] = data.rotations
    expect(w).toBeCloseTo(0)
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(0.6)
    expect(z).toBeCloseTo(0.8)
  })

  it('throws on a non-PLY buffer', () => {
    const buffer = new TextEncoder().encode('not a ply file at all').buffer
    expect(() => parsePLYSplat(buffer)).toThrow()
  })
})
