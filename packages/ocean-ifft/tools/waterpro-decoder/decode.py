#!/usr/bin/env python3
"""
Three.js Water Pro bundle string decoder.

The Three.js Water Pro demo bundle (main-*.js) ships with all string literals
XOR-encrypted against per-string key arrays. Two top-level arrays drive the
scheme:

  __58qlrttp = [[ciphertext bytes for string 0], [...], ...]
  __w9m84cyw = [[key bytes for string 0], [...], ...]

The decoder function (declared in the bundle as __0dlfn0ei) is:

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

We just port that to Python so we can resolve any __0dlfn0ei(N) reference
seen inside the (otherwise obfuscated) preset configs, GUI labels, etc.

Usage
-----
  python3 decode.py /path/to/main-XXXX.js                 # dump all strings, one per line: "<idx>\t<value>"
  python3 decode.py /path/to/main-XXXX.js 2007            # decode a single index
  python3 decode.py /path/to/main-XXXX.js --search arctic # case-insensitive substring search across all decoded strings

To extract preset configs, see extract-presets.py in this directory.
"""
import argparse
import re
import sys


def extract_byte_arrays(src: str, name: str) -> list[list[int]]:
    """Pull out a top-level nested array literal like `name = [[...],[...]]`."""
    m = re.search(re.escape(name) + r"\s*=\s*\[", src)
    if not m:
        raise RuntimeError(f"could not find {name} declaration")
    start = m.end() - 1  # position of opening '['
    depth = 0
    end = -1
    for i in range(start, len(src)):
        ch = src[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end < 0:
        raise RuntimeError(f"unterminated {name} array")

    arrays: list[list[int]] = []
    cur: list[int] = []
    in_inner = False
    num = ""
    inner_depth = 0
    for ch in src[start:end]:
        if ch == "[":
            inner_depth += 1
            if inner_depth == 2:
                in_inner = True
                cur = []
                num = ""
        elif ch == "]":
            if inner_depth == 2:
                if num:
                    cur.append(int(num))
                arrays.append(cur)
                num = ""
                in_inner = False
            inner_depth -= 1
        elif in_inner:
            if ch == ",":
                if num:
                    cur.append(int(num))
                num = ""
            elif ch.isdigit() or ch == "-":
                num += ch
    return arrays


def decode(cipher: list[int], key: list[int]) -> str:
    if not key:
        return ""
    return "".join(chr(cipher[j] ^ key[j % len(key)]) for j in range(len(cipher)))


def build_table(bundle_path: str) -> list[str]:
    with open(bundle_path, "r", encoding="utf-8") as f:
        src = f.read()
    cipher = extract_byte_arrays(src, "__58qlrttp")
    key = extract_byte_arrays(src, "__w9m84cyw")
    if len(cipher) != len(key):
        print(
            f"warning: cipher ({len(cipher)}) and key ({len(key)}) lengths differ",
            file=sys.stderr,
        )
    table = []
    for c, k in zip(cipher, key):
        table.append(decode(c, k))
    return table


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle", help="path to main-*.js")
    ap.add_argument("index", type=int, nargs="?", help="single index to decode")
    ap.add_argument("--search", help="substring search (case-insensitive)")
    ap.add_argument("--all-printable", action="store_true", help="only dump printable strings")
    args = ap.parse_args()

    table = build_table(args.bundle)

    if args.index is not None:
        print(table[args.index])
        return 0
    if args.search:
        needle = args.search.lower()
        for i, s in enumerate(table):
            if needle in s.lower():
                print(f"{i}\t{s}")
        return 0
    for i, s in enumerate(table):
        if args.all_printable and not all(32 <= ord(c) < 127 or c in "\n\t" for c in s):
            continue
        print(f"{i}\t{s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
