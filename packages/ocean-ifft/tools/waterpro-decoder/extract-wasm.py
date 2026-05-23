#!/usr/bin/env python3
# Extracts the WaterPro WASM shader module from main-BFhFKOiM.js.
# The WASM is stored as atob(__0dlfn0ei(2080)), then XOR-decoded with
# oB[n%256] (256-byte key) and i[n%256] (256-byte LCG derived from length).
# Usage: python3 extract-wasm.py /path/to/main-BFhFKOiM.js
# Output: waterpro-shaders.wasm in the same directory as this script.

import sys
import re
import base64
import ctypes
import os

def extract_ob_array(src: str) -> list[int]:
    """Extract the oB[] key array from the bundle source."""
    m = re.search(r'\boB=\[([^\]]+)\]', src)
    if not m:
        raise RuntimeError("Could not find oB=[] in bundle")
    return [int(x.strip()) for x in m.group(1).split(',')]

def extract_byte_arrays(src: str, name: str) -> list[list[int]]:
    """Pull out a top-level nested array literal like `name = [[...],[...]]`."""
    m = re.search(re.escape(name) + r"\s*=\s*\[", src)
    if not m:
        raise RuntimeError(f"Could not find {name} declaration")
    start = m.end() - 1
    depth = 0
    end = -1
    for i in range(start, len(src)):
        ch = src[i]
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end < 0:
        raise RuntimeError(f"Unterminated {name} array")

    arrays: list[list[int]] = []
    cur: list[int] = []
    in_inner = False
    num = ""
    inner_depth = 0
    for ch in src[start:end]:
        if ch == '[':
            inner_depth += 1
            if inner_depth == 2:
                in_inner = True
                cur = []
                num = ""
        elif ch == ']':
            if inner_depth == 2:
                if num:
                    cur.append(int(num))
                arrays.append(cur)
                num = ""
                in_inner = False
            inner_depth -= 1
        elif in_inner:
            if ch == ',':
                if num:
                    cur.append(int(num))
                num = ""
            elif ch.isdigit() or ch == '-':
                num += ch
    return arrays

def decode_string(cipher: list[int], key: list[int]) -> str:
    if not key:
        return ""
    return "".join(chr(cipher[j] ^ key[j % len(key)]) for j in range(len(cipher)))

def lcg_key(length: int) -> list[int]:
    """Derive the 256-byte LCG key from WASM length (as done in the bundle)."""
    # Math.imul(r, 1103515245) + 12345 & 2147483647
    # Math.imul is 32-bit signed multiplication
    r = length
    result = []
    for _ in range(256):
        r = (ctypes.c_int32(ctypes.c_int32(r).value * 1103515245).value + 12345) & 0x7FFFFFFF
        result.append(r & 0xFF)
    return result

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} /path/to/main-BFhFKOiM.js", file=sys.stderr)
        sys.exit(1)

    bundle_path = sys.argv[1]
    print(f"Reading bundle: {bundle_path}")
    with open(bundle_path, 'r', encoding='utf-8') as f:
        src = f.read()

    # Extract oB key array
    ob = extract_ob_array(src)
    print(f"oB key array: {len(ob)} bytes")

    # Decode string index 2080 (the base64-encoded encrypted WASM)
    cipher_arrays = extract_byte_arrays(src, '__58qlrttp')
    key_arrays = extract_byte_arrays(src, '__w9m84cyw')
    if len(cipher_arrays) <= 2080 or len(key_arrays) <= 2080:
        raise RuntimeError(f"String table too short: cipher={len(cipher_arrays)}, key={len(key_arrays)}")

    encoded_b64 = decode_string(cipher_arrays[2080], key_arrays[2080])
    print(f"String[2080] length: {len(encoded_b64)} chars (base64)")

    # Base64 decode to get the XOR-obfuscated WASM bytes
    wasm_obfuscated = base64.b64decode(encoded_b64)
    t = len(wasm_obfuscated)
    print(f"Obfuscated WASM size: {t} bytes")

    # Derive LCG key from length
    lcg = lcg_key(t)

    # XOR decode
    decoded = bytearray(t)
    for n in range(t):
        decoded[n] = wasm_obfuscated[n] ^ ob[n % 256] ^ lcg[n % 256]

    # Validate WASM magic
    if decoded[:4] != b'\x00asm':
        print(f"WARNING: decoded bytes don't start with WASM magic. First 8 bytes: {list(decoded[:8])}")
        print("Attempting anyway...")
    else:
        print("WASM magic number confirmed: \\x00asm")

    wasm_version = int.from_bytes(decoded[4:8], 'little')
    print(f"WASM version: {wasm_version}")

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'waterpro-shaders.wasm')
    with open(out_path, 'wb') as f:
        f.write(decoded)
    print(f"Written: {out_path} ({len(decoded)} bytes)")

if __name__ == '__main__':
    main()
