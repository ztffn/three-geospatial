#!/usr/bin/env python3
# Decodes the WaterPro WASM operator table and translates WAT function bodies
# into readable TSL pseudocode. Uses the Section 12 DataView layout from
# full-shader-decoded.js to map opcode indices to TSL operations.
# Usage: python3 decode-opcodes.py waterpro-shaders.wasm waterpro-shaders.wat
# Output: prints TSL pseudocode for each wB program (0-12).

import sys
import struct
import re

# ── Section 12: DataView byte-offset → TSL operation name ────────────────────
# Extracted from full-shader-decoded.js Section 12.
# Format: (category, byte_offset, tsl_name)
# category: 'i'=iB (unary), 'r'=rB (binary), 'n'=nB (ternary), 'a'=aB (quaternary)
OPERATOR_TABLE_SPEC = [
    # iB unary ops
    ('i',   0, '.w'),
    ('i',   6, '.negate()'),
    ('i',  12, '.toVar()'),
    ('i',  18, '.z'),
    ('i',  24, '.oneMinus()'),
    ('i',  30, '.xyz'),
    ('i',  36, 'vec3(e)'),
    ('i',  42, 'sin(e)'),
    ('i',  48, 'length(e)'),
    ('i',  54, '.not()'),
    ('i',  60, 'vec3(e)_cast'),
    ('i',  66, 'floor(e)'),
    ('i',  72, '.negate()_2'),
    ('i',  78, 'vec2(e)'),
    ('i',  84, 'fract(e)'),
    ('i',  90, 'fract(e)_2'),
    ('i',  96, '.r'),
    ('i', 102, 'vec4(e)'),
    ('i', 108, '.negate()_3'),
    ('i', 114, 'abs(e)'),
    ('i', 120, 'abs(e)_2'),
    ('i', 126, '.x'),
    ('i', 132, 'normalize(e)'),
    ('i', 138, 'fract(e)_3'),
    ('i', 144, '.y'),
    ('i', 150, '.toInt()'),
    ('i', 156, '.xy'),
    ('i', 162, 'vec3(e)_3'),
    ('i', 168, 'reciprocal(e)'),
    ('i', 174, 'abs(e)_3'),
    # rB binary ops
    ('r', 180, '.and(b)'),
    ('r', 186, '.lessThan(b)'),
    ('r', 192, 'smoothstep(a,b)'),
    ('r', 198, '.lessThanEqual(b)'),
    ('r', 204, '.greaterThanEqual(b)'),
    ('r', 210, '.div(b)'),
    ('r', 216, 'dot(a,b)'),
    ('r', 222, '.greaterThan(b)'),
    ('r', 228, 'smoothstep(a,b)_2'),
    ('r', 234, 'step(a,b)'),
    ('r', 240, '.lessThan(b)_2'),
    ('r', 246, '.mod(b)'),
    ('r', 252, '.lessThanEqual(b)_2'),
    ('r', 258, '.add(b)'),
    ('r', 264, 'min(a,b)'),
    ('r', 270, '.mul(b)'),
    ('r', 276, '.greaterThanEqual(b)_2'),
    ('r', 282, 'dot(a,b)_2'),
    ('r', 288, '.greaterThan(b)_2'),
    ('r', 294, '.and(b)_2'),
    ('r', 300, '.div(b)_2'),
    ('r', 306, '.and(b)_3'),
    ('r', 312, '.sample(b)'),
    ('r', 318, '.add(b)_2'),
    ('r', 324, '.sub(b)'),
    ('r', 330, '.sub(b)_2'),
    ('r', 336, '.lessThan(b)_3'),
    ('r', 342, 'vec4(a,b)'),
    ('r', 348, 'max(a,b)'),
    ('r', 354, 'dot(a,b)_3'),
    ('r', 360, '.greaterThan(b)_3'),
    ('r', 366, '.sub(b)_3'),
    ('r', 372, 'min(a,b)_2'),
    ('r', 378, '.lessThanEqual(b)_3'),
    ('r', 384, '.mul(b)_2'),
    ('r', 390, '.greaterThanEqual(b)_3'),
    ('r', 396, 'max(a,b)_2'),
    ('r', 402, 'min(a,b)_3'),
    ('r', 408, '.element(b)'),
    ('r', 414, 'smoothstep(a,b)_3'),
    ('r', 420, '.add(b)_3'),
    ('r', 426, '.mul(b)_3'),
    ('r', 432, 'vec2(a,b)'),
    ('r', 438, 'max(a,b)_3'),
    ('r', 444, '.div(b)_3'),
    ('r', 450, 'texture(a,b)'),
    # nB ternary ops
    ('n', 456, 'vec3(a,b,c)'),
    ('n', 462, 'mix(a,b,c)'),
    ('n', 468, 'mix(a,b,c)_2'),
    ('n', 474, 'mix(a,b,c)_3'),
    ('n', 480, 'clamp(a,b,c)'),
    ('n', 486, 'clamp(a,b,c)_2'),
    ('n', 492, 'select(a,b,c)'),
    ('n', 498, 'step(a,b,c)'),
    ('n', 504, 'step(a,b,c)_2'),
    ('n', 510, 'clamp(a,b,c)_3'),
    ('n', 516, 'step(a,b,c)_3'),
    # aB quaternary ops
    ('a', 522, 'vec4(a,b,c,d)'),
]

# Clean canonical name for similar ops
OP_CANONICAL = {
    '.negate()': '.negate()',
    '.negate()_2': '.negate()',
    '.negate()_3': '.negate()',
    'vec3(e)': 'vec3(a)',
    'vec3(e)_cast': 'vec3(a)',
    'vec3(e)_3': 'vec3(a)',
    'abs(e)': 'abs(a)',
    'abs(e)_2': 'abs(a)',
    'abs(e)_3': 'abs(a)',
    'fract(e)': 'fract(a)',
    'fract(e)_2': 'fract(a)',
    'fract(e)_3': 'fract(a)',
    'dot(a,b)': 'dot(a,b)',
    'dot(a,b)_2': 'dot(a,b)',
    'dot(a,b)_3': 'dot(a,b)',
    'min(a,b)': 'min(a,b)',
    'min(a,b)_2': 'min(a,b)',
    'min(a,b)_3': 'min(a,b)',
    'max(a,b)': 'max(a,b)',
    'max(a,b)_2': 'max(a,b)',
    'max(a,b)_3': 'max(a,b)',
    'smoothstep(a,b)': 'smoothstep(a,b)',
    'smoothstep(a,b)_2': 'smoothstep(a,b)',
    'smoothstep(a,b)_3': 'smoothstep(a,b)',
    '.lessThan(b)': '.lessThan(b)',
    '.lessThan(b)_2': '.lessThan(b)',
    '.lessThan(b)_3': '.lessThan(b)',
    '.lessThanEqual(b)': '.lessThanEqual(b)',
    '.lessThanEqual(b)_2': '.lessThanEqual(b)',
    '.lessThanEqual(b)_3': '.lessThanEqual(b)',
    '.greaterThan(b)': '.greaterThan(b)',
    '.greaterThan(b)_2': '.greaterThan(b)',
    '.greaterThan(b)_3': '.greaterThan(b)',
    '.greaterThanEqual(b)': '.greaterThanEqual(b)',
    '.greaterThanEqual(b)_2': '.greaterThanEqual(b)',
    '.greaterThanEqual(b)_3': '.greaterThanEqual(b)',
    '.sub(b)': '.sub(b)',
    '.sub(b)_2': '.sub(b)',
    '.sub(b)_3': '.sub(b)',
    '.mul(b)': '.mul(b)',
    '.mul(b)_2': '.mul(b)',
    '.mul(b)_3': '.mul(b)',
    '.add(b)': '.add(b)',
    '.add(b)_2': '.add(b)',
    '.add(b)_3': '.add(b)',
    '.div(b)': '.div(b)',
    '.div(b)_2': '.div(b)',
    '.div(b)_3': '.div(b)',
    '.and(b)': '.and(b)',
    '.and(b)_2': '.and(b)',
    '.and(b)_3': '.and(b)',
    'mix(a,b,c)': 'mix(a,b,c)',
    'mix(a,b,c)_2': 'mix(a,b,c)',
    'mix(a,b,c)_3': 'mix(a,b,c)',
    'clamp(a,b,c)': 'clamp(a,b,c)',
    'clamp(a,b,c)_2': 'clamp(a,b,c)',
    'clamp(a,b,c)_3': 'clamp(a,b,c)',
    'step(a,b,c)': 'step(a,b,c)',
    'step(a,b,c)_2': 'step(a,b,c)',
    'step(a,b,c)_3': 'step(a,b,c)',
}


def load_wasm_memory(wasm_path: str) -> bytes:
    """Load the WASM file's linear memory initial segment."""
    with open(wasm_path, 'rb') as f:
        wasm = f.read()
    # Parse WASM binary to find data segment
    # We need the data section (section id 11)
    idx = 8  # skip magic + version
    data_bytes = None
    while idx < len(wasm):
        section_id = wasm[idx]
        idx += 1
        # read LEB128 section size
        size = 0
        shift = 0
        while True:
            b = wasm[idx]
            idx += 1
            size |= (b & 0x7F) << shift
            shift += 7
            if not (b & 0x80):
                break
        section_data = wasm[idx:idx + size]
        if section_id == 11:  # Data section
            data_bytes = section_data
            break
        idx += size
    if data_bytes is None:
        raise RuntimeError("No data section found in WASM")
    return data_bytes


def parse_data_segment(data_bytes: bytes) -> tuple[int, bytes]:
    """Parse the first data segment, return (offset, data)."""
    # count (LEB128)
    idx = 0
    count = 0
    shift = 0
    while True:
        b = data_bytes[idx]
        idx += 1
        count |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    # First segment: flags (LEB), offset expr, data
    flags = data_bytes[idx]; idx += 1
    # offset expr: i32.const <val> end
    assert data_bytes[idx] == 0x41, "expected i32.const"
    idx += 1
    offset = 0
    shift = 0
    while True:
        b = data_bytes[idx]
        idx += 1
        offset |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    assert data_bytes[idx] == 0x0B, "expected end"
    idx += 1
    # data size (LEB)
    dsize = 0
    shift = 0
    while True:
        b = data_bytes[idx]
        idx += 1
        dsize |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    data = data_bytes[idx:idx + dsize]
    return offset, data


def build_opcode_map(wasm_path: str) -> dict[int, tuple[str, str]]:
    """
    Returns dict: opcode_value -> (category, tsl_name)
    using mB.p()=32 as DataView base offset in memory.
    """
    data_bytes = load_wasm_memory(wasm_path)
    mem_offset, mem_data = parse_data_segment(data_bytes)
    # mB.p() = 32, DataView starts at memory offset 32
    dv_base = 32
    dv_mem_offset = dv_base - mem_offset  # index into mem_data
    opcode_map = {}
    for cat, byte_off, name in OPERATOR_TABLE_SPEC:
        abs_off = dv_mem_offset + byte_off
        if abs_off + 2 <= len(mem_data):
            val = struct.unpack_from('<H', mem_data, abs_off)[0]
            canonical = OP_CANONICAL.get(name, name)
            opcode_map[val] = (cat, canonical)
    return opcode_map


def build_global_op_map(wat_path: str, opcode_map: dict) -> dict[int, tuple[str, str]]:
    """
    Map global index -> (category, tsl_name) for globals 0-87
    (the pre-initialized opcode constants).
    """
    global_map = {}
    with open(wat_path, 'r') as f:
        wat = f.read()
    # Extract immutable globals with initial i32 constants
    pattern = re.compile(r'\(global \(;(\d+);\) i32 \(i32\.const (\d+)\)\)')
    for m in pattern.finditer(wat):
        gidx = int(m.group(1))
        val = int(m.group(2))
        if gidx <= 87 and val in opcode_map:
            global_map[gidx] = opcode_map[val]
    return global_map


# ── WAT function parser ───────────────────────────────────────────────────────
# Parses one function body from WAT into a list of instructions.

BRIDGE = {
    0: 'l',   # load param/uniform/builtin
    1: 'b',   # binary op
    2: 'f',   # float literal
    3: 'a',   # unary op
    4: 'c',   # ternary op
    5: 'i',   # if
    6: 'rn',  # return slot
    7: 'r',   # return single
    8: 'lb',  # loop
    9: 's',   # assign
    10: 'sa', # addAssign
    11: 'br', # break
    12: 'ie', # if-else
}

BUILTIN_NODES = ['positionWorld', 'cameraPosition', 'positionView', 'cameraNear', 'cameraFar',
                 'normalWorld', 'normalView', 'normalLocal', 'viewportUV']

def format_func(func_idx: int, prog_idx: int, wat_lines: list[str],
                global_op_map: dict, prog_names: dict) -> str:
    """Translate WAT function body to readable TSL pseudocode."""
    name = prog_names.get(prog_idx, f'program_{prog_idx}')
    lines = [f"// ── wB({prog_idx}) = {name} ──────────────────────────────────────────"]
    lines.append(f"// WAT func (;{func_idx};)")
    lines.append(f"const {name} = Fn((params, uniforms) => {{")

    slot_names = {}
    slot_counter = [0]
    param_counter = [0]
    uniform_counter = [0]
    stack = []
    indent = 1

    def new_slot(expr: str) -> str:
        n = f"s{slot_counter[0]}"
        slot_counter[0] += 1
        slot_names[len(slot_names)] = n
        lines.append("  " * indent + f"const {n} = {expr};")
        return n

    def gslot(g: int) -> str:
        return slot_names.get(g, f"g{g}")

    # collect instructions from the function body in WAT
    in_func = False
    instructions = []
    for line in wat_lines:
        s = line.strip()
        if re.match(r'\(func \(;' + str(func_idx) + r';\)', s):
            in_func = True
            continue
        if in_func:
            if s == ')' and not any(c in s[1:] for c in '()'):
                break
            instructions.append(s)

    # simple sequential instruction emitter
    i = 0
    arg_stack = []  # stack of pending args for next call

    while i < len(instructions):
        instr = instructions[i]
        if instr.startswith('global.get'):
            g = int(instr.split()[1])
            arg_stack.append(('global', g))
        elif instr.startswith('global.set'):
            g = int(instr.split()[1])
            # pop result from previous call
            if arg_stack and arg_stack[-1][0] == 'result':
                slot_names[g] = arg_stack.pop()[1]
            else:
                slot_names[g] = f"g{g}"
        elif instr.startswith('i32.const'):
            v = int(instr.split()[1])
            arg_stack.append(('i32', v))
        elif instr.startswith('f32.const'):
            # e.g. f32.const 0x1.8p+0 (;=1.5;)
            m = re.search(r'\(;=([^;]+);\)', instr)
            v = float(m.group(1)) if m else instr.split()[1]
            arg_stack.append(('f32', v))
        elif instr.startswith('call '):
            call_idx = int(instr.split()[1].rstrip(')'))
            bridge_name = BRIDGE.get(call_idx, f'call{call_idx}')

            if bridge_name == 'f':
                # float literal: f32 val → new slot
                f32_val = arg_stack.pop()[1] if arg_stack else '?'
                s = new_slot(f"float({f32_val})")
                arg_stack.append(('result', s))

            elif bridge_name == 'l':
                # load: (source, index) → new slot
                args = []
                for _ in range(2):
                    if arg_stack:
                        args.insert(0, arg_stack.pop())
                source = args[0][1] if args else '?'
                idx_val = args[1][1] if len(args) > 1 else '?'
                if source == 0:
                    s = new_slot(f"params[{idx_val}]")
                elif source == 1:
                    s = new_slot(f"uniforms[{idx_val}]")
                elif source == 2:
                    bname = BUILTIN_NODES[idx_val] if isinstance(idx_val, int) and idx_val < len(BUILTIN_NODES) else f"builtin[{idx_val}]"
                    s = new_slot(bname)
                else:
                    s = new_slot(f"load({source},{idx_val})")
                arg_stack.append(('result', s))

            elif bridge_name == 'a':
                # unary: (opcode_global, operand_slot)
                args = []
                for _ in range(2):
                    if arg_stack:
                        args.insert(0, arg_stack.pop())
                op_g = args[0][1] if args else '?'
                src = gslot(args[1][1]) if len(args) > 1 and args[1][0] == 'global' else str(args[1][1] if len(args) > 1 else '?')
                if isinstance(op_g, int) and op_g in global_op_map:
                    cat, opname = global_op_map[op_g]
                    if opname.startswith('.'):
                        expr = f"{src}{opname}"
                    else:
                        expr = opname.replace('a', src).replace('e', src)
                else:
                    expr = f"unary[g{op_g}]({src})"
                s = new_slot(expr)
                arg_stack.append(('result', s))

            elif bridge_name == 'b':
                # binary: (opcode_global, a_slot, b_slot)
                args = []
                for _ in range(3):
                    if arg_stack:
                        args.insert(0, arg_stack.pop())
                op_g = args[0][1] if args else '?'
                a = gslot(args[1][1]) if len(args) > 1 and args[1][0] == 'global' else str(args[1][1] if len(args) > 1 else '?')
                b = gslot(args[2][1]) if len(args) > 2 and args[2][0] == 'global' else str(args[2][1] if len(args) > 2 else '?')
                if isinstance(op_g, int) and op_g in global_op_map:
                    cat, opname = global_op_map[op_g]
                    if opname.startswith('.'):
                        expr = f"{a}{opname.replace('b', b)}"
                    else:
                        expr = opname.replace('a', a).replace('b', b)
                else:
                    expr = f"binary[g{op_g}]({a},{b})"
                s = new_slot(expr)
                arg_stack.append(('result', s))

            elif bridge_name == 'c':
                # ternary: (opcode_global, a, b, c)
                args = []
                for _ in range(4):
                    if arg_stack:
                        args.insert(0, arg_stack.pop())
                op_g = args[0][1] if args else '?'
                slots = []
                for a in args[1:]:
                    slots.append(gslot(a[1]) if a[0] == 'global' else str(a[1]))
                a, b, c = (slots + ['?','?','?'])[:3]
                if isinstance(op_g, int) and op_g in global_op_map:
                    cat, opname = global_op_map[op_g]
                    expr = opname.replace('a', a).replace('b', b).replace('c', c)
                else:
                    expr = f"ternary[g{op_g}]({a},{b},{c})"
                s = new_slot(expr)
                arg_stack.append(('result', s))

            elif bridge_name == 'rn':
                # return slot: (return_idx, slot)
                args = []
                for _ in range(2):
                    if arg_stack:
                        args.insert(0, arg_stack.pop())
                ret_idx = args[0][1] if args else '?'
                slot = gslot(args[1][1]) if len(args) > 1 and args[1][0] == 'global' else str(args[1][1] if len(args) > 1 else '?')
                lines.append("  " * indent + f"// return[{ret_idx}] = {slot}")

            elif bridge_name == 'r':
                args = []
                if arg_stack:
                    args.append(arg_stack.pop())
                slot = gslot(args[0][1]) if args and args[0][0] == 'global' else str(args[0][1] if args else '?')
                lines.append("  " * indent + f"return {slot};")

            elif bridge_name == 's':
                args = []
                for _ in range(2):
                    if arg_stack:
                        args.insert(0, arg_stack.pop())
                dst = gslot(args[0][1]) if args and args[0][0] == 'global' else str(args[0][1] if args else '?')
                src = gslot(args[1][1]) if len(args) > 1 and args[1][0] == 'global' else str(args[1][1] if len(args) > 1 else '?')
                lines.append("  " * indent + f"{dst}.assign({src});")

            elif bridge_name == 'sa':
                args = []
                for _ in range(2):
                    if arg_stack:
                        args.insert(0, arg_stack.pop())
                dst = gslot(args[0][1]) if args and args[0][0] == 'global' else str(args[0][1] if args else '?')
                src = gslot(args[1][1]) if len(args) > 1 and args[1][0] == 'global' else str(args[1][1] if len(args) > 1 else '?')
                lines.append("  " * indent + f"{dst}.addAssign({src});")

            elif bridge_name == 'i':
                args = []
                for _ in range(2):
                    if arg_stack:
                        args.insert(0, arg_stack.pop())
                cond = gslot(args[0][1]) if args and args[0][0] == 'global' else str(args[0][1] if args else '?')
                block = args[1][1] if len(args) > 1 else '?'
                lines.append("  " * indent + f"If({cond}, block_{block});")

            elif bridge_name == 'ie':
                args = []
                for _ in range(3):
                    if arg_stack:
                        args.insert(0, arg_stack.pop())
                cond = gslot(args[0][1]) if args and args[0][0] == 'global' else str(args[0][1] if args else '?')
                lines.append("  " * indent + f"If({cond}).Else(...);")

            else:
                lines.append("  " * indent + f"// {bridge_name}({', '.join(str(a[1]) for a in arg_stack)})")
                arg_stack.clear()
        i += 1

    lines.append("});")
    lines.append("")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} waterpro-shaders.wasm waterpro-shaders.wat", file=sys.stderr)
        sys.exit(1)

    wasm_path = sys.argv[1]
    wat_path = sys.argv[2]

    print("Building opcode map from WASM memory...")
    opcode_map = build_opcode_map(wasm_path)
    print(f"  {len(opcode_map)} opcodes decoded")

    print("Building global → operation map from WAT globals...")
    global_op_map = build_global_op_map(wat_path, opcode_map)
    print(f"  {len(global_op_map)} globals mapped")

    # Print the global op table for reference
    print("\n// Global opcode table (globals 0-87 → TSL ops):")
    for g in sorted(global_op_map.keys()):
        cat, name = global_op_map[g]
        print(f"//   global {g:2d} ({cat}): {name}")

    prog_names = {
        0:  'underwaterSurfaceGlow',
        1:  'sssGlowColor',
        2:  'fresnel',
        3:  'unknown_prog3',
        4:  'waterColorAndDepth',
        5:  'surfaceFoam',
        6:  'shorelineFoam',
        7:  'waveFoam',
        8:  'unknown_prog8',
        9:  'unknown_prog9',
        10: 'unknown_prog10',
        11: 'sparkleSSR',
        12: 'wakeFoam',
    }

    # wB program → WAT function index mapping
    prog_to_func = {
        0: 13, 1: 14, 2: 15, 3: 16, 4: 17, 5: 18,
        6: 19, 7: 20, 8: 21, 9: 22, 10: 23, 11: 24, 12: 25,
    }

    with open(wat_path, 'r') as f:
        wat_lines = f.readlines()

    # Translate programs 4 and 6 (most relevant for shoreline foam)
    for prog in [4, 6, 5, 7]:
        func_idx = prog_to_func[prog]
        result = format_func(func_idx, prog, wat_lines, global_op_map, prog_names)
        print(result)


if __name__ == '__main__':
    main()
