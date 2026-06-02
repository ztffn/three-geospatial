// Phase A refactor — jacobian-based foam mask for the ocean surface.
// Takes the summed jacobian determinants across cascades and turns negative
// values (compressed wave regions = breaking) into a 0..1 foam factor.
// Phase B will layer surface/turbulent noise on top; this stays the base.

export const foamWGSL = `

    fn jacobianToFoam(jakobian: f32, foamStrength: f32, foamThreshold: f32) -> f32 {
        return min(1.0, max(0.0, (-jakobian + foamThreshold) * foamStrength));
    }

`;
