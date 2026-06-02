// Physics model deriving offshore-wind-turbine telemetry from real forecast
// wind — there is no public live SCADA feed, so RPM / power / pitch / yaw are
// MODELLED (clearly labelled as such in the UI, never presented as measured).
// Reference machine: a generic ~8 MW Class-I offshore turbine (V164-class):
// 164 m rotor, cut-in 3.5, rated 13, cut-out 25 m/s, ~10.5 rpm rated.

export interface TurbineSpec {
  ratedPowerMW: number
  rotorDiameter: number // m
  cutInWind: number // m/s
  ratedWind: number // m/s
  cutOutWind: number // m/s
  minRpm: number // rotor speed at cut-in (variable-speed region floor)
  ratedRpm: number // rotor speed at and above rated wind
  maxPitchDeg: number // blade pitch near cut-out (power shedding)
}

// Generic 8 MW Class-I offshore reference turbine.
export const DEFAULT_TURBINE: TurbineSpec = {
  ratedPowerMW: 8.0,
  rotorDiameter: 164,
  cutInWind: 3.5,
  ratedWind: 13,
  cutOutWind: 25,
  minRpm: 4.8,
  ratedRpm: 10.5,
  maxPitchDeg: 22
}

export type TurbineStatus =
  | 'No data'
  | 'Parked' // below cut-in: rotor idle/feathered
  | 'Generating' // region 2: cut-in..rated, power tracks ~v^3
  | 'Rated' // region 3: rated..cut-out, power held at rated by pitching
  | 'Cut-out' // above cut-out: shut down for protection

export interface TurbineTelemetry {
  status: TurbineStatus
  powerMW: number | null // electrical output
  capacityFactor: number | null // powerMW / ratedPowerMW (0..1)
  rpm: number | null // rotor speed
  pitchDeg: number | null // blade pitch angle
  yawHeading: number | null // compass deg the rotor faces (into the wind)
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f

// Map a forecast wind sample to modelled turbine telemetry. windFromDirection
// is meteorological (direction the wind blows FROM); an upwind-rotor turbine
// yaws to face that direction, so the rotor heading equals it.
export function modelTurbine(
  windSpeed: number | null,
  windFromDirection: number | null,
  spec: TurbineSpec = DEFAULT_TURBINE
): TurbineTelemetry {
  const yawHeading = windFromDirection // rotor faces into the wind

  if (windSpeed == null) {
    return {
      status: 'No data',
      powerMW: null,
      capacityFactor: null,
      rpm: null,
      pitchDeg: null,
      yawHeading
    }
  }

  const { cutInWind, ratedWind, cutOutWind, ratedPowerMW, minRpm, ratedRpm } =
    spec
  const v = windSpeed

  // Below cut-in: parked, blades feathered (~90°), no rotation/output.
  if (v < cutInWind) {
    return {
      status: 'Parked',
      powerMW: 0,
      capacityFactor: 0,
      rpm: 0,
      pitchDeg: 90,
      yawHeading
    }
  }

  // Above cut-out: emergency shutdown, feathered, no output.
  if (v >= cutOutWind) {
    return {
      status: 'Cut-out',
      powerMW: 0,
      capacityFactor: 0,
      rpm: 0,
      pitchDeg: 90,
      yawHeading
    }
  }

  // Region 2 (cut-in..rated): variable speed at fine pitch, power rises with
  // the cube of wind speed (simplified power curve). Rotor speed ramps to hold
  // optimal tip-speed-ratio.
  if (v < ratedWind) {
    const f =
      (v ** 3 - cutInWind ** 3) / (ratedWind ** 3 - cutInWind ** 3)
    const powerMW = ratedPowerMW * f
    const rpm = lerp(minRpm, ratedRpm, (v - cutInWind) / (ratedWind - cutInWind))
    return {
      status: 'Generating',
      powerMW,
      capacityFactor: powerMW / ratedPowerMW,
      rpm,
      pitchDeg: 0, // fine pitch maximises capture below rated
      yawHeading
    }
  }

  // Region 3 (rated..cut-out): hold rated power by pitching blades; rotor speed
  // held at rated. Pitch ramps from 0 at rated wind to maxPitch near cut-out.
  const pitchDeg =
    spec.maxPitchDeg * ((v - ratedWind) / (cutOutWind - ratedWind))
  return {
    status: 'Rated',
    powerMW: ratedPowerMW,
    capacityFactor: 1,
    rpm: ratedRpm,
    pitchDeg,
    yawHeading
  }
}
