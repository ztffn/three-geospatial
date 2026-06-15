// Contract test for the WGSL↔CPU Gerstner mirror: gerstner-cpu.ts promises to
// stay math-identical to gerstner.wgsl.js, but the coupling is otherwise only
// enforced by comments. This extracts the numeric literals from the WGSL
// template string and asserts they match the exported CPU constants, so a
// retune on either side fails loudly instead of silently desyncing buoyancy.

import { describe, expect, it } from 'vitest'

// @ts-expect-error untyped JS module (WGSL template string)
import { gerstnerWGSL } from '../../resources/shader/ocean/fragments/gerstner.wgsl.js'
import {
  GERSTNER_GRAVITY,
  GERSTNER_SLOT_PHASES,
  GERSTNER_TWO_PI,
} from './gerstner-cpu'

const wgsl = gerstnerWGSL as string

describe('gerstner-cpu constants mirror gerstner.wgsl.js', () => {
  it('per-slot phases match the gerstnerSum call literals', () => {
    // gerstnerSum passes the phase as the last argument of each
    // gerstnerSingle(worldXZ, t, ..., <phase>) call.
    const phases = [...wgsl.matchAll(/gerstnerSingle\(worldXZ[^)]*?,\s*([\d.]+)\)/g)]
      .map(m => Number(m[1]))
    expect(phases).toEqual([...GERSTNER_SLOT_PHASES])
  })

  it('gravity matches', () => {
    const m = wgsl.match(/let g = ([\d.]+);/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(GERSTNER_GRAVITY)
  })

  it('two-pi wave-number constant matches', () => {
    const m = wgsl.match(/([\d.]+) \/ max\(wavelength/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(GERSTNER_TWO_PI)
  })
})
