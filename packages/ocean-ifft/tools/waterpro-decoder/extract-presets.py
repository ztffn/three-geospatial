#!/usr/bin/env python3
"""
Three.js Water Pro preset extractor.

Locates the preset config table inside the bundle (declared as `const uD = {
arctic: {...}, choppy: {...}, ... }`) and resolves all `__0dlfn0ei(N)` string
references back to their plaintext values using decode.py.

Output is a single JSON file with one top-level object per preset name. Values
that were color literals (`new li(0xRRGGBB)` or hex strings) come through as
raw strings; numeric tuning values are preserved as JS literals where
possible.

Usage
-----
  python3 extract-presets.py /path/to/main-XXXX.js > presets.json

Note: this works against the May 2026 build (main-BFhFKOiM.js). If the bundle
ships a new build, the symbol names (`uD`, `__0dlfn0ei`, etc.) may change but
the technique is stable — re-find the `applyPreset` method and trace from
there.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from decode import build_table  # noqa: E402


def beautify(src: str) -> str:
    """Insert newlines around braces and semicolons so we can grep usefully."""
    return src.replace(";", ";\n").replace("{", "{\n").replace("}", "\n}\n")


def locate_preset_table(src: str) -> tuple[int, int]:
    """Find the start/end byte offsets of the `const uD = {...}` declaration."""
    m = re.search(r"const\s+uD\s*=\s*\{", src)
    if not m:
        raise RuntimeError("could not find `const uD = {` preset table")
    start = m.end() - 1  # position of opening '{'
    depth = 0
    for i in range(start, len(src)):
        ch = src[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1
    raise RuntimeError("unterminated preset table")


def parse_presets(blob: str, table: list[str]) -> dict:
    """Resolve __0dlfn0ei(N) refs, then eval the JS-like literal as JSON.

    The preset table is JS-with-quirks: unquoted keys, !0 / !1 for true/false,
    string refs as __0dlfn0ei(N). We rewrite each form, then strip trailing
    commas, then json.loads.
    """
    # Resolve __0dlfn0ei(N) → JSON-quoted string
    def resolve(m: re.Match) -> str:
        idx = int(m.group(1))
        if idx < 0 or idx >= len(table):
            return json.dumps(f"<missing string #{idx}>")
        return json.dumps(table[idx])

    blob = re.sub(r"__0dlfn0ei\(\s*(\d+)\s*\)", resolve, blob)

    # !0 → true, !1 → false  (no \b since ! is non-word)
    blob = re.sub(r"!0(?![\d])", "true", blob)
    blob = re.sub(r"!1(?![\d])", "false", blob)

    # Quote bare identifier keys (foo: → "foo":)
    blob = re.sub(r'([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:', r'\1"\2":', blob)

    # JS allows leading-decimal numbers like .35 — JSON does not. Prefix with 0.
    # Apply after key quoting so .35 in values gets fixed but property names
    # (which are now quoted) don't.
    blob = re.sub(r"(?<![\w.])(-?)\.(\d)", r"\g<1>0.\g<2>", blob)

    # Strip trailing commas before } and ]
    blob = re.sub(r",(\s*[}\]])", r"\1", blob)

    try:
        return json.loads(blob)
    except json.JSONDecodeError as e:
        # Dump the cleaned blob so the user can see what went wrong
        sys.stderr.write(f"JSON decode failed: {e}\n")
        sys.stderr.write("--- cleaned blob (first 4000 chars) ---\n")
        sys.stderr.write(blob[:4000] + "\n")
        raise


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle", help="path to main-*.js")
    ap.add_argument(
        "--preset",
        help="only output a single preset by name (e.g. arctic, choppy, tropical)",
    )
    ap.add_argument(
        "--indent",
        type=int,
        default=2,
        help="json indent (default 2)",
    )
    args = ap.parse_args()

    src = Path(args.bundle).read_text(encoding="utf-8")
    table = build_table(args.bundle)

    start, end = locate_preset_table(src)
    blob = src[start:end]

    presets = parse_presets(blob, table)
    if args.preset:
        if args.preset not in presets:
            sys.stderr.write(
                f"preset {args.preset!r} not found. Available: {', '.join(presets.keys())}\n"
            )
            return 2
        json.dump(presets[args.preset], sys.stdout, indent=args.indent, sort_keys=True)
    else:
        json.dump(presets, sys.stdout, indent=args.indent, sort_keys=True)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
