import { FileLoader, Loader } from 'three'
import invariant from 'tiny-invariant'

import {
  validateGaussianSplatData,
  type GaussianSplatData
} from './GaussianSplatData'

// Zeroth-order spherical harmonics basis constant. The DC term stored in the
// `f_dc_*` PLY properties is converted to base color via `0.5 + SH_C0 * f_dc`.
const SH_C0 = 0.28209479177387814

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

// Byte size of each PLY scalar property type.
const TYPE_SIZE: Record<string, number> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8
}

interface PLYProperty {
  name: string
  type: string
  offset: number
}

interface PLYHeader {
  count: number
  properties: PLYProperty[]
  stride: number
  headerLength: number
  littleEndian: boolean
}

function parseHeader(bytes: Uint8Array): PLYHeader {
  // The header is ASCII and terminated by a line containing "end_header".
  const marker = 'end_header\n'
  const decoder = new TextDecoder('ascii')
  // Decode a bounded prefix; PLY headers are small.
  const prefix = decoder.decode(bytes.subarray(0, Math.min(bytes.length, 8192)))
  const markerIndex = prefix.indexOf(marker)
  invariant(markerIndex !== -1, 'PLY header terminator not found')
  const headerLength = markerIndex + marker.length
  const headerText = prefix.substring(0, markerIndex)

  const lines = headerText.split('\n')
  invariant(lines[0].trim() === 'ply', 'Not a PLY file')

  let count = 0
  let littleEndian = true
  let inVertexElement = false
  const properties: PLYProperty[] = []
  let offset = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('format')) {
      littleEndian = !line.includes('binary_big_endian')
      invariant(
        line.includes('binary'),
        'Only binary PLY splat files are supported'
      )
    } else if (line.startsWith('element')) {
      const [, name, value] = line.split(/\s+/)
      inVertexElement = name === 'vertex'
      if (inVertexElement) {
        count = parseInt(value, 10)
      }
    } else if (line.startsWith('property') && inVertexElement) {
      const parts = line.split(/\s+/)
      const type = parts[1]
      const name = parts[parts.length - 1]
      invariant(
        type in TYPE_SIZE,
        `Unsupported PLY property type: ${type} (list properties are not supported)`
      )
      properties.push({ name, type, offset })
      offset += TYPE_SIZE[type]
    }
  }

  return { count, properties, stride: offset, headerLength, littleEndian }
}

function readScalar(
  view: DataView,
  byteOffset: number,
  type: string,
  littleEndian: boolean
): number {
  switch (type) {
    case 'float':
    case 'float32':
      return view.getFloat32(byteOffset, littleEndian)
    case 'double':
    case 'float64':
      return view.getFloat64(byteOffset, littleEndian)
    case 'uchar':
    case 'uint8':
      return view.getUint8(byteOffset)
    case 'char':
    case 'int8':
      return view.getInt8(byteOffset)
    case 'short':
    case 'int16':
      return view.getInt16(byteOffset, littleEndian)
    case 'ushort':
    case 'uint16':
      return view.getUint16(byteOffset, littleEndian)
    case 'int':
    case 'int32':
      return view.getInt32(byteOffset, littleEndian)
    case 'uint':
    case 'uint32':
      return view.getUint32(byteOffset, littleEndian)
    default:
      throw new Error(`Unsupported PLY property type: ${type}`)
  }
}

/**
 * Parses a binary 3D Gaussian Splatting PLY buffer into {@link GaussianSplatData}.
 *
 * Supports the de-facto community layout produced by the original
 * "3D Gaussian Splatting for Real-Time Radiance Field Rendering" training code
 * and its derivatives (Polycam, Postshot, Nerfstudio): `x, y, z`, `f_dc_0..2`,
 * optional `f_rest_*`, `opacity`, `scale_0..2`, `rot_0..3`.
 */
export function parsePLYSplat(buffer: ArrayBuffer): GaussianSplatData {
  const bytes = new Uint8Array(buffer)
  const header = parseHeader(bytes)
  const { count, properties, stride, headerLength, littleEndian } = header
  invariant(count > 0, 'PLY file contains no vertices')

  const byName = new Map(properties.map(property => [property.name, property]))
  const require = (name: string): PLYProperty => {
    const property = byName.get(name)
    invariant(property != null, `PLY file is missing required property: ${name}`)
    return property
  }

  const px = require('x')
  const py = require('y')
  const pz = require('z')
  const fdc0 = require('f_dc_0')
  const fdc1 = require('f_dc_1')
  const fdc2 = require('f_dc_2')
  const opacity = require('opacity')
  const scale0 = require('scale_0')
  const scale1 = require('scale_1')
  const scale2 = require('scale_2')
  const rot0 = require('rot_0')
  const rot1 = require('rot_1')
  const rot2 = require('rot_2')
  const rot3 = require('rot_3')

  const positions = new Float32Array(count * 3)
  const scales = new Float32Array(count * 3)
  const rotations = new Float32Array(count * 4)
  const colors = new Uint8Array(count * 4)

  const view = new DataView(buffer, headerLength)
  const read = (base: number, property: PLYProperty): number =>
    readScalar(view, base + property.offset, property.type, littleEndian)

  for (let i = 0; i < count; ++i) {
    const base = i * stride

    positions[i * 3] = read(base, px)
    positions[i * 3 + 1] = read(base, py)
    positions[i * 3 + 2] = read(base, pz)

    // Scales are stored in log space; preserve them as-is.
    scales[i * 3] = read(base, scale0)
    scales[i * 3 + 1] = read(base, scale1)
    scales[i * 3 + 2] = read(base, scale2)

    // Quaternion in WXYZ order, normalized to guard against drift.
    const w = read(base, rot0)
    const x = read(base, rot1)
    const y = read(base, rot2)
    const z = read(base, rot3)
    const length = Math.hypot(w, x, y, z)
    const inv = length > 0 ? 1 / length : 1
    rotations[i * 4] = w * inv
    rotations[i * 4 + 1] = x * inv
    rotations[i * 4 + 2] = y * inv
    rotations[i * 4 + 3] = z * inv

    // Resolve the SH DC term and opacity sigmoid into final RGBA bytes.
    const r = clamp01(0.5 + SH_C0 * read(base, fdc0))
    const g = clamp01(0.5 + SH_C0 * read(base, fdc1))
    const b = clamp01(0.5 + SH_C0 * read(base, fdc2))
    const a = clamp01(sigmoid(read(base, opacity)))
    colors[i * 4] = Math.round(r * 255)
    colors[i * 4 + 1] = Math.round(g * 255)
    colors[i * 4 + 2] = Math.round(b * 255)
    colors[i * 4 + 3] = Math.round(a * 255)
  }

  const data: GaussianSplatData = {
    count,
    positions,
    scales,
    rotations,
    colors
  }
  validateGaussianSplatData(data)
  return data
}

/** Three.js {@link Loader} wrapper around {@link parsePLYSplat}. */
export class PLYSplatLoader extends Loader<GaussianSplatData> {
  override load(
    url: string,
    onLoad: (data: GaussianSplatData) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void
  ): void {
    const loader = new FileLoader(this.manager)
    loader.setPath(this.path)
    loader.setResponseType('arraybuffer')
    loader.setRequestHeader(this.requestHeader)
    loader.setWithCredentials(this.withCredentials)
    loader.load(
      url,
      buffer => {
        try {
          onLoad(parsePLYSplat(buffer as ArrayBuffer))
        } catch (error) {
          if (onError != null) {
            onError(error)
          } else {
            console.error(error)
          }
          this.manager.itemError(url)
        }
      },
      onProgress,
      onError
    )
  }
}
