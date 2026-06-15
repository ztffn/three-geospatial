// Phase + load-telemetry data for the offshore wind-turbine installation rig
// (hregg_pivot.glb), ported from the original standalone viewer
// (hregg_pivot_full_sequence_3d_v30.html). Maps each animation clip to its
// human label, narrative/capability text, and winch/beam-ram/guy-ram loads for
// the Installation panel gauges. Static-phase loads are verbatim from the
// source; the three dynamic phases (rams/winch lift) use representative values
// the source computes continuously — flagged inline.

// Safe working loads from the source viewer (t).
export const WINCH_SWL = 240 // per drum
export const RAM_SWL = 300 // per beam ram, and the guy ram

// Ordered one-shot install-phase clips (play these in sequence), then settle
// into the looping Operating state. anim10 ("Operating" one-shot) is unused —
// the operating_spin loop is the Operating state, so the rotor keeps turning.
export const INSTALL_CLIPS = [
  'anim1',
  'anim2',
  'anim3',
  'anim4',
  'anim5',
  'anim6',
  'anim7',
  'anim8',
  'anim9'
] as const
export const IDLE_CLIP = 'operating_spin'
// All clips shown as phase buttons: the 9 one-shot install phases, then the
// looping Operating state. Clicking Operating loops the rotor (no clamp).
export const PHASE_CLIPS = [...INSTALL_CLIPS, IDLE_CLIP] as const

export interface RigPhase {
  label: string
  narrative: string
  capability: string
  // Loads in tonnes. winch ×3 drums (SWL 240 ea), beam ×3 rams (SWL 300 ea),
  // guy ram (SWL 300). 0 = slack / not engaged this phase.
  winch: [number, number, number]
  beam: [number, number, number]
  guy: number
}

export const RIG_PHASES: Record<string, RigPhase> = {
  anim1: {
    label: 'Fleet arrives',
    narrative: 'The whole fleet sails in together, in formation.',
    capability:
      'Winch floater, base, beams and the three blades motor in from shore.',
    winch: [0, 0, 0],
    beam: [0, 0, 0],
    guy: 0
  },
  anim2: {
    label: 'Guy pole up',
    narrative: 'Guy pole raised by the inner-floater guy ram; winches finish.',
    capability: 'Three winches haul the guy pole up over its sheaves.',
    winch: [14, 12, 15],
    beam: [0, 0, 0],
    guy: 225 // peak guy-ram force at the start of the lift
  },
  anim3: {
    label: 'Blades line up',
    narrative: 'Blades line up colinear with their hub sockets.',
    capability: 'Each blade squares up on its ram floaters, on its mount side.',
    winch: [0, 0, 0],
    beam: [0, 0, 0],
    guy: 0
  },
  anim4: {
    label: 'Blades mount',
    narrative: 'Floater rams lift each blade and feed it into the hub.',
    capability: 'The floaters carry the blade onto the hub, then retract.',
    winch: [1.5, 1.2, 1.8],
    beam: [0, 0, 0],
    guy: 0
  },
  anim5: {
    label: 'Rams lift 15°',
    narrative: 'Three beam rams drive the beam off horizontal.',
    capability: 'Per-ram ≈ 180 t ×3 · guy lines sharing the lift.',
    winch: [35, 32, 38], // representative — source ramps winch load through the phase
    beam: [180, 180, 180],
    guy: 0
  },
  anim6: {
    label: 'Winches raise',
    narrative: 'Winches carry the arc as the beam swings up.',
    capability: 'Winches haul the beam through the arc · rams retracting.',
    winch: [165, 155, 175], // representative — source computes T/6 per drum continuously
    beam: [90, 90, 90], // representative — rams retracting
    guy: 0
  },
  anim7: {
    label: 'Near vertical',
    narrative: 'Approaching vertical.',
    capability: 'Near-vertical · total line force peaks on the winches.',
    winch: [205, 195, 215], // representative — peak winch load near vertical
    beam: [0, 0, 0],
    guy: 0
  },
  anim8: {
    label: 'Insert 5 m',
    narrative: 'Beam driven 5 m into the socket; haul lines transfer to the mast.',
    capability: '5 m inserted · winch cables released to the pole.',
    winch: [20, 18, 22],
    beam: [0, 0, 0],
    guy: 0
  },
  anim9: {
    label: 'Secure & home',
    narrative: 'Guy pole folds to the mast; lines secured; floaters home.',
    capability: 'Stays transfer onto the mast so nothing fouls the rotor.',
    winch: [6, 5, 6.5],
    beam: [0, 0, 0],
    guy: 0
  },
  operating_spin: {
    label: 'Operating',
    narrative: 'Operating — rotor at speed.',
    capability: 'Guy pole and stays clamped to the mast; rig live for service.',
    winch: [4, 3.5, 4.5],
    beam: [0, 0, 0],
    guy: 0
  }
}

// Bar colour by load ratio (load / SWL), matching the source viewer.
export function loadColor(ratio: number): string {
  if (ratio < 0.6) return '#2BA37D' // green
  if (ratio < 0.85) return '#E0A23C' // amber
  return '#C9542C' // red
}
