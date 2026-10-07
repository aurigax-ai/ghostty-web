/**
 * Low-level access to the official libghostty-vt WebAssembly ABI.
 *
 * Struct layouts are read from `ghostty_type_json()` at load time instead of
 * being hard-coded, so a Ghostty upgrade that moves a field fails loudly in
 * `Abi.offset` rather than reading garbage.
 */

export const GHOSTTY_SUCCESS = 0;
export const GHOSTTY_INVALID_VALUE = -2;
export const GHOSTTY_OUT_OF_SPACE = -3;
export const GHOSTTY_NO_VALUE = -4;

type Fn = (...args: any[]) => any;

export interface VtExports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  [name: string]: Fn | WebAssembly.Memory | WebAssembly.Table;
}

interface FieldLayout {
  offset: number;
  size: number;
}

interface TypeLayout {
  kind: string;
  size: number;
  fields?: Record<string, FieldLayout>;
  bits?: Record<string, { lsb: number; width: number }>;
  values?: Record<string, number>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const I32 = 0x7f;
const I64 = 0x7e;

function leb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function section(id: number, body: number[]): number[] {
  return [id, ...leb(body.length), ...body];
}

/**
 * The bytes of a tiny module that imports one host function and re-exports it,
 * which turns a JavaScript function into a WebAssembly function that can be
 * placed in libghostty-vt's (growable) function table.
 */
export function trampolineBytes(
  params: ('i32' | 'i64')[],
  result: 'i32' | null
): Uint8Array<ArrayBuffer> {
  const name = [1, 0x66];
  const type = [
    1,
    0x60,
    params.length,
    ...params.map((p) => (p === 'i64' ? I64 : I32)),
    ...(result ? [1, I32] : [0]),
  ];
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, type),
    ...section(2, [1, 1, 0x65, ...name, 0x00, 0]),
    ...section(7, [1, ...name, 0x00, 0]),
  ]);
}

export class GhosttyCallError extends Error {
  constructor(
    readonly call: string,
    readonly result: number
  ) {
    super(`${call} failed with result ${result}`);
  }
}

export class Abi {
  private readonly types: Record<string, TypeLayout>;
  private readonly freeSlots: number[] = [];
  private scratchPtr = 0;
  private scratchLen = 0;
  private readonly input = { ptr: 0, len: 0, busy: false };

  constructor(readonly exports: VtExports) {
    const ptr = this.fn('ghostty_type_json')() as number;
    const bytes = new Uint8Array(exports.memory.buffer);
    let end = ptr;
    while (bytes[end] !== 0) end++;
    this.types = JSON.parse(decoder.decode(bytes.subarray(ptr, end))).types;
  }

  fn(name: string): Fn {
    const f = this.exports[name];
    if (typeof f !== 'function') throw new Error(`libghostty-vt has no export ${name}`);
    return f as Fn;
  }

  call(name: string, ...args: unknown[]): number {
    return this.fn(name)(...args) as number;
  }

  check(name: string, ...args: unknown[]): void {
    const result = this.call(name, ...args);
    if (result !== GHOSTTY_SUCCESS) throw new GhosttyCallError(name, result);
  }

  sizeOf(type: string): number {
    const layout = this.types[type];
    if (!layout) throw new Error(`libghostty-vt has no type ${type}`);
    return layout.size;
  }

  offset(type: string, field: string): number {
    const f = this.types[type]?.fields?.[field];
    if (!f) throw new Error(`libghostty-vt type ${type} has no field ${field}`);
    return f.offset;
  }

  bits(type: string, field: string): { lsb: number; width: number } {
    const b = this.types[type]?.bits?.[field];
    if (!b) throw new Error(`libghostty-vt type ${type} has no bit field ${field}`);
    return b;
  }

  enumValue(type: string, key: string): number {
    const v = this.types[type]?.values?.[key];
    if (v === undefined) throw new Error(`libghostty-vt enum ${type} has no value ${key}`);
    return v;
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer);
  }

  view(): DataView {
    return new DataView(this.exports.memory.buffer);
  }

  alloc(len: number): number {
    const ptr = this.call('ghostty_wasm_alloc', len);
    if (ptr === 0) throw new GhosttyCallError('ghostty_wasm_alloc', -1);
    this.bytes().fill(0, ptr, ptr + len);
    return ptr;
  }

  free(ptr: number, len: number): void {
    this.call('ghostty_wasm_free', ptr, len);
  }

  with<T>(len: number, use: (ptr: number) => T): T {
    const ptr = this.alloc(len);
    try {
      return use(ptr);
    } finally {
      this.free(ptr, len);
    }
  }

  /** Allocates a sized struct (its leading `size` field set), as GHOSTTY_INIT_SIZED does. */
  withSized<T>(type: string, use: (ptr: number) => T): T {
    const size = this.sizeOf(type);
    return this.with(size, (ptr) => {
      this.view().setUint32(ptr, size, true);
      return use(ptr);
    });
  }

  withBytes<T>(data: Uint8Array, use: (ptr: number, len: number) => T): T {
    if (data.length === 0) return use(0, 0);
    return this.with(data.length, (ptr) => {
      this.bytes().set(data, ptr);
      return use(ptr, data.length);
    });
  }

  /**
   * A zeroed buffer of at least `len` bytes, the same one on every call, for a
   * read that is done with it before anything else calls scratch().
   */
  scratch(len: number): number {
    if (len > this.scratchLen) {
      if (this.scratchPtr) this.free(this.scratchPtr, this.scratchLen);
      this.scratchPtr = 0;
      this.scratchLen = 0;
      const size = Math.max(len, 64);
      this.scratchPtr = this.alloc(size);
      this.scratchLen = size;
    } else {
      this.bytes().fill(0, this.scratchPtr, this.scratchPtr + len);
    }
    return this.scratchPtr;
  }

  /** scratch() holding a sized struct (its leading `size` field set), as GHOSTTY_INIT_SIZED does. */
  scratchSized(type: string): number {
    const size = this.sizeOf(type);
    const ptr = this.scratch(size);
    this.view().setUint32(ptr, size, true);
    return ptr;
  }

  /**
   * Runs `use` on text (as UTF-8) or bytes copied into a grow-only buffer kept
   * between calls. A call from inside `use` (a terminal written to from one of
   * the callbacks a write runs) gets a buffer of its own.
   */
  withInput<T>(data: string | Uint8Array, use: (ptr: number, len: number) => T): T {
    if (this.input.busy) {
      return this.withBytes(typeof data === 'string' ? encoder.encode(data) : data, use);
    }
    // UTF-8 takes at most 3 bytes per UTF-16 code unit.
    const max = typeof data === 'string' ? data.length * 3 : data.length;
    if (max === 0) return use(0, 0);
    const input = this.input;
    if (max > input.len) {
      if (input.ptr) this.free(input.ptr, input.len);
      input.ptr = 0;
      input.len = 0;
      const len = Math.max(max, 4096);
      input.ptr = this.call('ghostty_wasm_alloc', len);
      if (input.ptr === 0) throw new GhosttyCallError('ghostty_wasm_alloc', -1);
      input.len = len;
    }
    const bytes = this.bytes();
    let len = data.length;
    if (typeof data === 'string') {
      len = encoder.encodeInto(data, bytes.subarray(input.ptr, input.ptr + input.len)).written;
    } else {
      bytes.set(data, input.ptr);
    }
    input.busy = true;
    try {
      return use(input.ptr, len);
    } finally {
      input.busy = false;
    }
  }

  /** Runs a constructor that writes an opaque handle into an out slot and returns the handle. */
  newHandle(name: string, construct: (slot: number) => number): number {
    const slot = this.call('ghostty_wasm_alloc_opaque');
    if (slot === 0) throw new GhosttyCallError('ghostty_wasm_alloc_opaque', -1);
    try {
      const result = construct(slot);
      if (result !== GHOSTTY_SUCCESS) throw new GhosttyCallError(name, result);
      return this.call('ghostty_wasm_take_opaque', slot);
    } finally {
      this.call('ghostty_wasm_free_opaque', slot);
    }
  }

  string(ptr: number, len: number): string {
    if (len === 0) return '';
    return decoder.decode(this.bytes().subarray(ptr, ptr + len));
  }

  /** Registers a JavaScript callback in the function table and returns its index (the C function pointer). */
  addCallback(
    params: ('i32' | 'i64')[],
    result: 'i32' | null,
    fn: (...args: any[]) => unknown
  ): number {
    const module = new WebAssembly.Module(trampolineBytes(params, result));
    const instance = new WebAssembly.Instance(module, { e: { f: fn } });
    const table = this.exports.__indirect_function_table;
    const index = this.freeSlots.pop() ?? table.grow(1);
    table.set(index, instance.exports.f as any);
    return index;
  }

  removeCallback(index: number): void {
    this.exports.__indirect_function_table.set(index, null);
    this.freeSlots.push(index);
  }
}
