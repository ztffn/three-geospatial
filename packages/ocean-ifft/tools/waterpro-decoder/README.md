# Three.js Water Pro decoder

Tools for extracting string literals and preset configurations from the
obfuscated Three.js Water Pro demo bundle (`main-*.js`). The product is
licensed; we use these tools to lift *tuning values* (preset configs — wave
heights, foam thresholds, colors, etc.) for parity testing, not source code.

## Files

- `decode.py` — Python port of the bundle's XOR string-decoder function
  (`__0dlfn0ei`). Dumps the full string table or searches it.
- `extract-presets.py` — Locates the preset table (`const uD = {arctic:{...}}`)
  inside the bundle, resolves all string references, normalizes JS-isms (`!0`,
  bare keys, leading-decimal numbers, trailing commas) to JSON, and prints the
  result.
- `extracted-presets.json` — Cached output of `extract-presets.py` against the
  May 2026 build (`main-BFhFKOiM.js`). All 10 presets: `arctic`, `choppy`,
  `foggy`, `hurricane`, `moonlit`, `seaOfThieves`, `storm`, `sunset`,
  `tranquil`, `tropical`. Each has 13 sections: `caustics`, `clipmap`,
  `color`, `foam`, `fog`, `fresnel`, `oceanFloor`, `postProcessing`, `sky`,
  `sparkle`, `ssr`, `sss`, `waves`.

## How the obfuscation works

The bundle ships two top-level arrays of byte arrays:

```js
var __58qlrttp = [[ciphertext bytes for string 0], [...], ...]
var __w9m84cyw = [[XOR key bytes for string 0], [...], ...]
```

The decoder is a closure-cached XOR function:

```js
__0dlfn0ei = (function() {
    const cache = {};
    return function(i) {
        if (cache[i] !== undefined) return cache[i];
        const e = __58qlrttp[i], k = __w9m84cyw[i];
        let s = "";
        for (let j = 0; j < e.length; j++)
            s += String.fromCharCode(e[j] ^ k[j % k.length]);
        return cache[i] = s;
    };
})();
```

All string literals — UI labels, error messages, preset color codes, texture
file names, WGSL function names — are replaced with `__0dlfn0ei(N)` calls.
Identifier minification is independent and not reversible without the original
source maps.

## Usage

```bash
# Dump every string in the table (idx<TAB>value, one per line)
python3 decode.py /path/to/main-*.js

# Decode a single index
python3 decode.py /path/to/main-*.js 2007              # → "choppy"

# Search the table (case-insensitive substring)
python3 decode.py /path/to/main-*.js --search foam

# Extract all presets as JSON
python3 extract-presets.py /path/to/main-*.js > extracted-presets.json

# Extract one preset by name
python3 extract-presets.py /path/to/main-*.js --preset choppy
```

## When the bundle gets re-built

If a new build of the demo ships (filename changes from `main-BFhFKOiM.js` to
something else), the bundler may rename obfuscated symbols. Recovery
checklist:

1. **Decoder function name**: search for `function(){var c={};return
   function(i){if(c[i]!==void 0)return c[i];var e=` to find the IIFE. The
   variable assigned to it is the new decoder name.
2. **Byte-array names**: read the decoder body — it references two top-level
   arrays. Update `extract_byte_arrays(src, "__58qlrttp")` /
   `"__w9m84cyw"` in `decode.py` accordingly.
3. **Preset table name**: search for `applyPreset(e){` and trace the call. In
   the May 2026 build it's `this.waterSystem.loadPreset(e); dD(this.params,
   e);` where `dD` calls `cD(t) → lD(uD[t])`. The variable `uD` is the preset
   table. Update `re.search(r"const\s+uD\s*=\s*\{", src)` in
   `extract-presets.py`.

## What's in each preset section (May 2026 build)

| Section | Notable keys |
|---|---|
| `waves.fft` | `amplitude`, `windSpeed`, `windDirection`, `choppiness`, `directionalSpreading`, `standingWaveRatio`, `cascades.{ripples,waves}` |
| `waves.gerstner` | `wavelength`, `amplitude`, `wavelengthSpread`, `directionalSpread` |
| `color` | `shallowWaterColor`, `deepWaterColor`, `transmissionColor`, `depthFalloff`, `alpha` |
| `foam.{surface,waves,shoreline,wake}` | per-layer `enabled`, `opacity`, `color`, `size`, `coverage`, `texture`, plus layer-specific knobs |
| `fresnel.{surface,underwater}` | `power`, `normalStrength`, `waterAbsorption`, `refractionIOR`, etc. |
| `sss` | `enabled`, `intensity`, `power` |
| `sparkle` | `enabled`, `intensity`, `power`, `fadeDistance`, `minDistance` |
| `caustics.surface` | `strength`, `scale`, `speed` |
| `sky.{atmosphere,clouds,sun}` | full sky setup — Rayleigh / Mie / cloud noise |
| `oceanFloor` | submerged-mesh displacement, caustics, surface glow |
| `postProcessing.{bloom,filmGrain,vignette,underwater,underwaterParticles}` | post-processing chain |
| `ssr` | screen-space reflection toggle + strength |
| `clipmap` | `levels`, `segments`, `baseSize` — their LOD mesh resolution |

## Mapping to our implementation

These are reference values, not directly applicable — our ocean uses different
parameter names and structures. To port a preset:

1. Pick a preset from `extracted-presets.json` (e.g. `choppy`).
2. Map the demo's `waves.fft.windSpeed`, `amplitude`, `choppiness`, etc. to
   our `wave-generator.js` config.
3. Map `color.{shallow,deep,transmission}` to our `_constants.wgsl.js` /
   surface optics uniforms.
4. Map `foam.surface.{opacity,size,coverage}` to our
   `foamStrength`/`foamThreshold`/`foamTextureScale`/`foamMix` uniforms.
5. Skip features we don't have yet (turbulentFoam, shorelineFoam beyond a
   stub, ssr, screenSpaceRefraction, wakeFoam) — leave their toggles in the
   preset definition for future wiring.

This is a one-way port — write our own preset file under
`packages/ocean-ifft/presets/` rather than loading their JSON at runtime.
