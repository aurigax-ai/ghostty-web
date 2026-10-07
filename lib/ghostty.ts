/**
 * TypeScript wrapper for the official, unpatched libghostty-vt WASM API.
 *
 * The public classes keep the shape the renderer, selection manager and input
 * handler were written against; underneath they use Ghostty's render state,
 * grid references and key encoder through `Abi`.
 */

import {
  Abi,
  GHOSTTY_NO_VALUE,
  GHOSTTY_OUT_OF_SPACE,
  GHOSTTY_SUCCESS,
  GhosttyCallError,
  type VtExports,
} from './abi';
import { EventEmitter } from './event-emitter';
import type { IEvent } from './interfaces';
import {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type KeyEvent,
  type KittyKeyFlags,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
} from './types';

// Re-export types for convenience
export {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
};

/**
 * Main Ghostty WASM wrapper class
 */
export class Ghostty {
  readonly abi: Abi;

  constructor(wasmInstance: WebAssembly.Instance) {
    this.abi = new Abi(wasmInstance.exports as unknown as VtExports);
  }

  createKeyEncoder(): KeyEncoder {
    return new KeyEncoder(this.abi);
  }

  createTerminal(
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ): GhosttyTerminal {
    return new GhosttyTerminal(this.abi, cols, rows, config);
  }

  static async fromBytes(bytes: BufferSource | WebAssembly.Module): Promise<Ghostty> {
    const module = bytes instanceof WebAssembly.Module ? bytes : await WebAssembly.compile(bytes);
    return new Ghostty(await WebAssembly.instantiate(module, {}));
  }

  static async load(wasmPath?: string): Promise<Ghostty> {
    if (wasmPath) return Ghostty.loadFromPath(wasmPath);
    const moduleUrl = new URL('../ghostty-vt.wasm', import.meta.url);
    const defaultPaths: string[] = [];
    if (moduleUrl.protocol === 'file:') {
      let filePath = moduleUrl.pathname;
      if (filePath.match(/^\/[A-Za-z]:\//)) filePath = filePath.slice(1);
      defaultPaths.push(filePath);
    }
    defaultPaths.push(moduleUrl.href, './ghostty-vt.wasm', '/ghostty-vt.wasm');
    let lastError: Error | null = null;
    for (const path of defaultPaths) {
      try {
        return await Ghostty.loadFromPath(path);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError || new Error('Failed to load Ghostty WASM');
  }

  private static async loadFromPath(path: string): Promise<Ghostty> {
    let wasmBytes: ArrayBuffer | undefined;
    if (!path.startsWith('http:') && !path.startsWith('https:')) {
      try {
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(path);
        wasmBytes = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        ) as ArrayBuffer;
      } catch {
        wasmBytes = undefined;
      }
    }
    if (!wasmBytes) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }
      wasmBytes = await response.arrayBuffer();
      if (wasmBytes.byteLength === 0) {
        throw new Error(`WASM file is empty (0 bytes). Check path: ${path}`);
      }
    }
    return Ghostty.fromBytes(wasmBytes);
  }
}

/**
 * Key Encoder - converts keyboard events into terminal escape sequences
 */
export class KeyEncoder {
  private encoder: number;

  constructor(private readonly abi: Abi) {
    this.encoder = abi.newHandle('ghostty_key_encoder_new', (slot) =>
      abi.call('ghostty_key_encoder_new', 0, slot)
    );
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    this.abi.with(4, (ptr) => {
      this.abi.view().setUint8(ptr, typeof value === 'boolean' ? (value ? 1 : 0) : value);
      this.abi.call('ghostty_key_encoder_setopt', this.encoder, option, ptr);
    });
  }

  setKittyFlags(flags: KittyKeyFlags): void {
    this.setOption(KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags);
  }

  encode(event: KeyEvent): Uint8Array {
    const abi = this.abi;
    const eventPtr = abi.newHandle('ghostty_key_event_new', (slot) =>
      abi.call('ghostty_key_event_new', 0, slot)
    );
    try {
      abi.call('ghostty_key_event_set_action', eventPtr, event.action);
      abi.call('ghostty_key_event_set_key', eventPtr, event.key);
      abi.call('ghostty_key_event_set_mods', eventPtr, event.mods);
      if (event.consumedMods !== undefined) {
        abi.call('ghostty_key_event_set_consumed_mods', eventPtr, event.consumedMods);
      }
      if (event.composing !== undefined) {
        abi.call('ghostty_key_event_set_composing', eventPtr, event.composing ? 1 : 0);
      }
      if (event.unshiftedCodepoint !== undefined) {
        abi.call('ghostty_key_event_set_unshifted_codepoint', eventPtr, event.unshiftedCodepoint);
      }
      const encode = (): Uint8Array => {
        const capacity = 128;
        return abi.with(capacity + 8, (buf) => {
          const written = buf + capacity;
          const result = abi.call(
            'ghostty_key_encoder_encode',
            this.encoder,
            eventPtr,
            buf,
            capacity,
            written
          );
          if (result !== GHOSTTY_SUCCESS) throw new Error(`Failed to encode key: ${result}`);
          const len = abi.view().getUint32(written, true);
          return abi.bytes().slice(buf, buf + len);
        });
      };
      if (!event.utf8) return encode();
      const utf8 = new TextEncoder().encode(event.utf8);
      return abi.withBytes(utf8, (ptr, len) => {
        abi.call('ghostty_key_event_set_utf8', eventPtr, ptr, len);
        return encode();
      });
    } finally {
      abi.call('ghostty_key_event_free', eventPtr);
    }
  }

  dispose(): void {
    if (this.encoder) {
      this.abi.call('ghostty_key_encoder_free', this.encoder);
      this.encoder = 0;
    }
  }
}

export type SemanticPromptKind = 'prompt-start' | 'input-start' | 'output-start' | 'command-end';

export interface SemanticPromptEvent {
  kind: SemanticPromptKind;
  exitCode?: number;
  command: string;
}

export interface DesktopNotificationEvent {
  title: string;
  body: string;
}

const PROMPT_KINDS: Record<string, SemanticPromptKind> = {
  PROMPT_START: 'prompt-start',
  INPUT_START: 'input-start',
  OUTPUT_START: 'output-start',
  COMMAND_END: 'command-end',
};

const UNKNOWN_SEQUENCE_MAX_BYTES = 4096;

export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/** A row the terminal keeps track of as output scrolls, reflows or is pruned. */
export interface TrackedRow {
  /** The row's line in the screen (scrollback first), or null once it no longer exists. */
  line(): number | null;
  free(): void;
}

const POINT_ACTIVE = 'ACTIVE';
const POINT_HISTORY = 'HISTORY';
type PointSpace = typeof POINT_ACTIVE | typeof POINT_HISTORY;

const GRAPHEME_CAP = 16;
const GRAPHEME_CLUSTER_MODE = 2027;
const HYPERLINK_CAPS = [2048, 8192, 32768];

function rgbAt(view: DataView, ptr: number): RGB {
  return { r: view.getUint8(ptr), g: view.getUint8(ptr + 1), b: view.getUint8(ptr + 2) };
}

interface CellLayout {
  styleSize: number;
  fgColor: number;
  bgColor: number;
  bold: number;
  italic: number;
  faint: number;
  blink: number;
  inverse: number;
  invisible: number;
  strikethrough: number;
  underline: number;
  colorTag: number;
  colorValue: number;
  colorPalette: number;
  colorRgb: number;
  tagCodepoint: number;
  tagGrapheme: number;
  tagBgPalette: number;
  tagBgRgb: number;
  wideWide: number;
  wideSpacerTail: number;
  rowIteratorData: number;
  rowDirtyData: number;
  rowCellsData: number;
  rowIteratorNext: (iterator: number) => number;
  rowGet: (iterator: number, key: number, out: number) => number;
  rowCellsNext: (cells: number) => number;
  rowCellsGetMulti: (
    cells: number,
    count: number,
    keys: number,
    values: number,
    written: number
  ) => number;
}

const EXPECTED_CELL_BITS: Record<string, [number, number]> = {
  content_tag: [0, 2],
  content: [2, 24],
  style_id: [26, 16],
  wide: [42, 2],
  hyperlink: [45, 1],
};

const cellLayouts = new WeakMap<Abi, CellLayout>();

function cellLayout(abi: Abi): CellLayout {
  const cached = cellLayouts.get(abi);
  if (cached) return cached;
  for (const [field, [lsb, width]] of Object.entries(EXPECTED_CELL_BITS)) {
    const bits = abi.bits('GhosttyCell', field);
    if (bits.lsb !== lsb || bits.width !== width) {
      throw new Error(`libghostty-vt GhosttyCell.${field} moved to ${bits.lsb}+${bits.width}`);
    }
  }
  const style = (f: string) => abi.offset('GhosttyStyle', f);
  const tags = 'GhosttyCellContentTag';
  const fn = <T>(name: string) => abi.fn(name) as unknown as T;
  const layout: CellLayout = {
    styleSize: abi.sizeOf('GhosttyStyle'),
    fgColor: style('fg_color'),
    bgColor: style('bg_color'),
    bold: style('bold'),
    italic: style('italic'),
    faint: style('faint'),
    blink: style('blink'),
    inverse: style('inverse'),
    invisible: style('invisible'),
    strikethrough: style('strikethrough'),
    underline: style('underline'),
    colorTag: abi.offset('GhosttyStyleColor', 'tag'),
    colorValue: abi.offset('GhosttyStyleColor', 'value'),
    colorPalette: abi.enumValue('GhosttyStyleColorTag', 'PALETTE'),
    colorRgb: abi.enumValue('GhosttyStyleColorTag', 'RGB'),
    tagCodepoint: abi.enumValue(tags, 'CODEPOINT'),
    tagGrapheme: abi.enumValue(tags, 'CODEPOINT_GRAPHEME'),
    tagBgPalette: abi.enumValue(tags, 'BG_COLOR_PALETTE'),
    tagBgRgb: abi.enumValue(tags, 'BG_COLOR_RGB'),
    wideWide: abi.enumValue('GhosttyCellWide', 'WIDE'),
    wideSpacerTail: abi.enumValue('GhosttyCellWide', 'SPACER_TAIL'),
    rowIteratorData: abi.enumValue('GhosttyRenderStateData', 'ROW_ITERATOR'),
    rowDirtyData: abi.enumValue('GhosttyRenderStateRowData', 'DIRTY'),
    rowCellsData: abi.enumValue('GhosttyRenderStateRowData', 'CELLS'),
    rowIteratorNext: fn('ghostty_render_state_row_iterator_next'),
    rowGet: fn('ghostty_render_state_row_get'),
    rowCellsNext: fn('ghostty_render_state_row_cells_next'),
    rowCellsGetMulti: fn('ghostty_render_state_row_cells_get_multi'),
  };
  cellLayouts.set(abi, layout);
  return layout;
}

interface ExtractScratch {
  base: number;
  size: number;
  slot: number;
  flag: number;
  keys: number;
  values: number;
  raw: number;
  len: number;
  style: number;
  written: number;
}

function allocScratch(abi: Abi, layout: CellLayout): ExtractScratch {
  const size = 8 + 8 + 12 + 12 + 8 + 8 + layout.styleSize + 8;
  const base = abi.alloc(size);
  const scratch: ExtractScratch = {
    base,
    size,
    slot: base,
    flag: base + 8,
    keys: base + 16,
    values: base + 28,
    raw: base + 40,
    len: base + 48,
    style: base + 56,
    written: base + 56 + layout.styleSize,
  };
  const view = abi.view();
  const cells = 'GhosttyRenderStateRowCellsData';
  view.setInt32(scratch.keys, abi.enumValue(cells, 'RAW'), true);
  view.setInt32(scratch.keys + 4, abi.enumValue(cells, 'GRAPHEMES_LEN'), true);
  view.setInt32(scratch.keys + 8, abi.enumValue(cells, 'STYLE'), true);
  view.setUint32(scratch.values, scratch.raw, true);
  view.setUint32(scratch.values + 4, scratch.len, true);
  view.setUint32(scratch.values + 8, scratch.style, true);
  return scratch;
}

/**
 * GhosttyTerminal - a terminal backed by libghostty-vt's render state.
 *
 * `update()` syncs the render state and copies the dirty rows of the viewport
 * into a reusable cell pool; the renderer then reads cells from the pool.
 * Scrollback, graphemes, hyperlinks and wrap flags are read through grid
 * references on demand.
 */
/** A match in screen coordinates: columns, and rows counted from the top of the scrollback. */
export interface SearchMatch {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * A search of one terminal's screen and scrollback with libghostty-vt's
 * search: case-insensitive for ASCII letters, kept in sync with the terminal
 * by `run()` after writes. It never scrolls; the caller shows the selected
 * match. "Next" moves toward older output (up), as in Ghostty.
 */
export class TerminalSearch {
  private handle: number;

  constructor(
    private readonly abi: Abi,
    private readonly terminal: number
  ) {
    this.handle = abi.newHandle('ghostty_search_new', (slot) =>
      abi.call('ghostty_search_new', 0, slot, terminal)
    );
    abi.with(4, (ptr) => {
      abi.view().setInt32(ptr, abi.enumValue('GhosttySearchScroll', 'NONE'), true);
      abi.check('ghostty_search_set', this.handle, this.option('SELECT_SCROLL'), ptr);
    });
  }

  private option(name: string): number {
    return this.abi.enumValue('GhosttySearchOption', name);
  }

  private data(name: string): number {
    return this.abi.enumValue('GhosttySearchData', name);
  }

  /** Starts a search for `text`, or stops searching when it is empty. */
  setNeedle(text: string): void {
    const abi = this.abi;
    if (!text) {
      abi.check('ghostty_search_set', this.handle, this.option('NEEDLE'), 0);
      return;
    }
    const bytes = new TextEncoder().encode(text);
    abi.withBytes(bytes, (ptr, len) =>
      abi.with(abi.sizeOf('GhosttyString'), (str) => {
        const view = abi.view();
        view.setUint32(str + abi.offset('GhosttyString', 'ptr'), ptr, true);
        view.setUint32(str + abi.offset('GhosttyString', 'len'), len, true);
        abi.check('ghostty_search_set', this.handle, this.option('NEEDLE'), str);
      })
    );
  }

  /** Catches up with everything written to the terminal since the last run. */
  run(): void {
    this.abi.check('ghostty_search_run', this.handle);
  }

  /** Selects the next older (`older`) or newer match, wrapping; false when there are none. */
  select(older: boolean): boolean {
    const result = this.abi.call(
      'ghostty_search_set',
      this.handle,
      this.option(older ? 'SELECT_NEXT' : 'SELECT_PREV'),
      0
    );
    if (result === GHOSTTY_NO_VALUE) return false;
    if (result !== GHOSTTY_SUCCESS) throw new GhosttyCallError('ghostty_search_set', result);
    return true;
  }

  total(): number {
    return this.readU32('TOTAL_MATCHES') ?? 0;
  }

  /** Index of the selected match, newest first (0 is the newest), or null. */
  selectedIndex(): number | null {
    return this.readU32('SELECTED_INDEX');
  }

  private readU32(name: string): number | null {
    const abi = this.abi;
    return abi.with(8, (ptr) => {
      const result = abi.call('ghostty_search_get', this.handle, this.data(name), ptr);
      if (result === GHOSTTY_NO_VALUE) return null;
      if (result !== GHOSTTY_SUCCESS) throw new GhosttyCallError('ghostty_search_get', result);
      return abi.view().getUint32(ptr, true);
    });
  }

  selected(): SearchMatch | null {
    const abi = this.abi;
    return abi.withSized('GhosttySelection', (sel) => {
      const result = abi.call('ghostty_search_get', this.handle, this.data('SELECTED_MATCH'), sel);
      if (result === GHOSTTY_NO_VALUE) return null;
      if (result !== GHOSTTY_SUCCESS) throw new GhosttyCallError('ghostty_search_get', result);
      return this.toMatch(sel);
    });
  }

  /** Every match, newest first, read right after `run()` and before the next write. */
  matches(): SearchMatch[] {
    const abi = this.abi;
    const selSize = abi.sizeOf('GhosttySelection');
    const bufSize = abi.sizeOf('GhosttySelectionBuffer');
    const at = (buf: number, field: string) => buf + abi.offset('GhosttySelectionBuffer', field);
    return abi.with(bufSize, (buf) => {
      const query = abi.call('ghostty_search_get', this.handle, this.data('MATCHES'), buf);
      if (query === GHOSTTY_SUCCESS) return [];
      if (query !== GHOSTTY_OUT_OF_SPACE) {
        if (query === GHOSTTY_NO_VALUE) return [];
        throw new GhosttyCallError('ghostty_search_get', query);
      }
      const count = abi.view().getUint32(at(buf, 'len'), true);
      return abi.with(count * selSize, (items) => {
        for (let i = 0; i < count; i++) {
          abi.view().setUint32(items + i * selSize, selSize, true);
        }
        const view = abi.view();
        view.setUint32(at(buf, 'ptr'), items, true);
        view.setUint32(at(buf, 'cap'), count, true);
        abi.check('ghostty_search_get', this.handle, this.data('MATCHES'), buf);
        const len = abi.view().getUint32(at(buf, 'len'), true);
        const out: SearchMatch[] = [];
        for (let i = 0; i < len; i++) {
          const match = this.toMatch(items + i * selSize);
          if (match) out.push(match);
        }
        return out;
      });
    });
  }

  private toMatch(sel: number): SearchMatch | null {
    const abi = this.abi;
    const start = this.screenPoint(sel + abi.offset('GhosttySelection', 'start'));
    const end = this.screenPoint(sel + abi.offset('GhosttySelection', 'end'));
    if (!start || !end) return null;
    return { startX: start.x, startY: start.y, endX: end.x, endY: end.y };
  }

  private screenPoint(ref: number): { x: number; y: number } | null {
    const abi = this.abi;
    return abi.with(abi.sizeOf('GhosttyPointCoordinate'), (out) => {
      const result = abi.call(
        'ghostty_terminal_point_from_grid_ref',
        this.terminal,
        ref,
        abi.enumValue('GhosttyPointTag', 'SCREEN'),
        out
      );
      if (result !== GHOSTTY_SUCCESS) return null;
      const view = abi.view();
      return {
        x: view.getUint16(out + abi.offset('GhosttyPointCoordinate', 'x'), true),
        y: view.getUint32(out + abi.offset('GhosttyPointCoordinate', 'y'), true),
      };
    });
  }

  free(): void {
    if (!this.handle) return;
    this.abi.call('ghostty_search_free', this.handle);
    this.handle = 0;
  }
}

export class GhosttyTerminal {
  private handle: number;
  private renderState: number;
  private rowIterator: number;
  private rowCells: number;
  private _cols: number;
  private _rows: number;

  private readonly layout: CellLayout;
  private readonly scratch: ExtractScratch;
  private cellPool: GhosttyCell[] = [];
  private rowDirty: boolean[] = [];
  private dirty: DirtyState = DirtyState.FULL;
  private changed = true;
  private colors: { background: RGB; foreground: RGB; cursor: RGB | null; palette: RGB[] } = {
    background: { r: 0, g: 0, b: 0 },
    foreground: { r: 204, g: 204, b: 204 },
    cursor: null,
    palette: [],
  };
  private responses: string[] = [];
  private callbacks: number[] = [];

  private readonly bellEmitter = new EventEmitter<void>();
  private readonly titleEmitter = new EventEmitter<string>();
  private readonly pwdEmitter = new EventEmitter<string>();
  private readonly promptEmitter = new EventEmitter<SemanticPromptEvent>();
  private readonly notificationEmitter = new EventEmitter<DesktopNotificationEvent>();
  private readonly unknownOscEmitter = new EventEmitter<string>();

  /** BEL from the program (Ghostty's own bell, not a guess from the byte stream). */
  readonly onBell: IEvent<void> = this.bellEmitter.event;
  /** OSC 0/2 title, read from the terminal after Ghostty applied it. */
  readonly onTitleChange: IEvent<string> = this.titleEmitter.event;
  /** OSC 7 (or OSC 9 / 1337 CurrentDir) as the shell sent it: for OSC 7 the raw file:// URI with its host. */
  readonly onPwdChange: IEvent<string> = this.pwdEmitter.event;
  /** OSC 133 prompt marks, delivered at their exact position in the stream. */
  readonly onSemanticPrompt: IEvent<SemanticPromptEvent> = this.promptEmitter.event;
  /** OSC 9 / OSC 777 desktop notifications. */
  readonly onDesktopNotification: IEvent<DesktopNotificationEvent> = this.notificationEmitter.event;
  /** The content of an OSC libghostty-vt does not implement, e.g. `633;E;...`. */
  readonly onUnknownOsc: IEvent<string> = this.unknownOscEmitter.event;
  /**
   * Decides an OSC 52 clipboard write synchronously: return true to allow it.
   * Without a handler every write is denied. Clipboard reads are never answered.
   */
  clipboardWriteHandler: ((text: string) => boolean) | null = null;

  constructor(
    private readonly abi: Abi,
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ) {
    this._cols = cols;
    this._rows = rows;
    this.layout = cellLayout(abi);
    this.scratch = allocScratch(abi, this.layout);
    this.handle = abi.newHandle('ghostty_terminal_new', (slot) =>
      abi.call('ghostty_terminal_new', 0, slot, cols, rows)
    );
    this.renderState = abi.newHandle('ghostty_render_state_new', (slot) =>
      abi.call('ghostty_render_state_new', 0, slot)
    );
    this.rowIterator = abi.newHandle('ghostty_render_state_row_iterator_new', (slot) =>
      abi.call('ghostty_render_state_row_iterator_new', 0, slot)
    );
    this.rowCells = abi.newHandle('ghostty_render_state_row_cells_new', (slot) =>
      abi.call('ghostty_render_state_row_cells_new', 0, slot)
    );
    const writePty = abi.addCallback(['i32', 'i32', 'i32', 'i32'], null, (_t, _u, ptr, len) => {
      this.responses.push(abi.string(ptr, len));
    });
    this.callbacks.push(writePty);
    this.setOption('WRITE_PTY', writePty);
    this.installHooks();
    this.setModeDefault(GRAPHEME_CLUSTER_MODE, true);
    if (config) this.configure(config);
    this.initCellPool();
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  /** A new search of this terminal; free it before or after the terminal. */
  createSearch(): TerminalSearch {
    return new TerminalSearch(this.abi, this.handle);
  }

  /** The raw libghostty-vt terminal handle, for APIs this class does not wrap yet. */
  get rawHandle(): number {
    return this.handle;
  }

  /** Sets a terminal option whose value is passed directly (a callback or pointer). */
  setOption(option: string, value: number): void {
    const opt = this.abi.enumValue('GhosttyTerminalOption', option);
    this.abi.check('ghostty_terminal_set', this.handle, opt, value);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.abi.withBytes(bytes, (ptr, len) =>
      this.abi.call('ghostty_terminal_vt_write', this.handle, ptr, len)
    );
    this.changed = true;
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this.abi.check('ghostty_terminal_resize', this.handle, cols, rows, 0, 0);
    this.initCellPool();
    this.changed = true;
  }

  free(): void {
    const abi = this.abi;
    if (!this.handle) return;
    abi.call('ghostty_render_state_row_cells_free', this.rowCells);
    abi.call('ghostty_render_state_row_iterator_free', this.rowIterator);
    abi.call('ghostty_render_state_free', this.renderState);
    abi.free(this.scratch.base, this.scratch.size);
    abi.call('ghostty_terminal_free', this.handle);
    for (const index of this.callbacks) abi.removeCallback(index);
    this.callbacks = [];
    for (const emitter of [
      this.bellEmitter,
      this.titleEmitter,
      this.pwdEmitter,
      this.promptEmitter,
      this.notificationEmitter,
      this.unknownOscEmitter,
    ]) {
      emitter.dispose();
    }
    this.handle = 0;
  }

  // ==========================================================================
  // RenderState API
  // ==========================================================================

  /**
   * Sync the render state with the terminal and copy dirty rows into the cell
   * pool. Safe to call several times per frame: it only does work after a
   * write or resize, and dirty state persists until markClean().
   */
  update(): DirtyState {
    if (!this.changed) return this.dirty;
    this.changed = false;
    const abi = this.abi;
    abi.check('ghostty_render_state_update', this.renderState, this.handle);
    const dirty = this.readRenderU32('DIRTY') as DirtyState;
    if (dirty > this.dirty || this.dirty === DirtyState.NONE) this.dirty = dirty;
    this.readColors();
    this.extractRows(this.dirty === DirtyState.FULL);
    return this.dirty;
  }

  getCursor(): RenderStateCursor {
    this.update();
    const abi = this.abi;
    return abi.withSized('GhosttyRenderStateCursor', (ptr) => {
      abi.check(
        'ghostty_render_state_get',
        this.renderState,
        abi.enumValue('GhosttyRenderStateData', 'CURSOR'),
        ptr
      );
      const view = abi.view();
      const at = (f: string) => ptr + abi.offset('GhosttyRenderStateCursor', f);
      const inViewport = view.getUint8(at('viewport_has_value')) !== 0;
      const x = inViewport ? view.getUint16(at('viewport_x'), true) : -1;
      const y = inViewport ? view.getUint16(at('viewport_y'), true) : -1;
      const style = view.getInt32(at('visual_style'), true);
      const styles = 'GhosttyRenderStateCursorVisualStyle';
      return {
        x,
        y,
        viewportX: x,
        viewportY: y,
        visible: inViewport && view.getUint8(at('visible')) !== 0,
        blinking: view.getUint8(at('blinking')) !== 0,
        style:
          style === abi.enumValue(styles, 'BAR')
            ? 'bar'
            : style === abi.enumValue(styles, 'UNDERLINE')
              ? 'underline'
              : 'block',
      };
    });
  }

  /**
   * The cursor in the active area, read from the terminal itself rather than
   * the render state, so it is exact inside a callback that runs mid-write.
   */
  cursorPosition(): { x: number; y: number } {
    return { x: this.readTerminalU16('CURSOR_X'), y: this.readTerminalU16('CURSOR_Y') };
  }

  getColors(): RenderStateColors {
    this.update();
    return {
      background: { ...this.colors.background },
      foreground: { ...this.colors.foreground },
      cursor: this.colors.cursor ? { ...this.colors.cursor } : null,
    };
  }

  isRowDirty(y: number): boolean {
    this.update();
    return this.dirty === DirtyState.FULL || this.rowDirty[y] === true;
  }

  markClean(): void {
    this.abi.check('ghostty_render_state_clean', this.renderState);
    this.dirty = DirtyState.NONE;
    this.rowDirty.fill(false);
  }

  getViewport(): GhosttyCell[] {
    this.update();
    return this.cellPool;
  }

  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    this.update();
    const start = y * this._cols;
    return this.cellPool.slice(start, start + this._cols).map((cell) => ({ ...cell }));
  }

  isDirty(): boolean {
    return this.update() !== DirtyState.NONE;
  }

  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  clearDirty(): void {
    this.markClean();
  }

  // ==========================================================================
  // Terminal modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    return (
      this.readTerminalU32('ACTIVE_SCREEN') ===
      this.abi.enumValue('GhosttyTerminalScreen', 'ALTERNATE')
    );
  }

  hasBracketedPaste(): boolean {
    return this.getMode(2004, false);
  }

  hasFocusEvents(): boolean {
    return this.getMode(1004, false);
  }

  mouseTrackingMode(): MouseTrackingMode {
    if (this.getMode(1003)) return 'any';
    if (this.getMode(1002)) return 'drag';
    if (this.getMode(1000)) return 'vt200';
    if (this.getMode(9)) return 'x10';
    return 'none';
  }

  /** Tracks the start of a row of the active area. */
  trackRow(activeY: number): TrackedRow | null {
    const abi = this.abi;
    const ref = abi.with(abi.sizeOf('GhosttyPoint'), (point) => {
      const view = abi.view();
      view.setInt32(point, abi.enumValue('GhosttyPointTag', POINT_ACTIVE), true);
      const coord = point + abi.offset('GhosttyPoint', 'value');
      view.setUint16(coord + abi.offset('GhosttyPointCoordinate', 'x'), 0, true);
      view.setUint32(coord + abi.offset('GhosttyPointCoordinate', 'y'), activeY, true);
      const slot = abi.call('ghostty_wasm_alloc_opaque');
      try {
        const result = abi.call('ghostty_terminal_grid_ref_track', this.handle, point, slot);
        return result === GHOSTTY_SUCCESS ? abi.call('ghostty_wasm_take_opaque', slot) : 0;
      } finally {
        abi.call('ghostty_wasm_free_opaque', slot);
      }
    });
    if (!ref) return null;
    let freed = false;
    return {
      line: () => {
        if (freed) return null;
        return abi.with(abi.sizeOf('GhosttyPointCoordinate'), (out) => {
          const result = abi.call(
            'ghostty_tracked_grid_ref_point',
            ref,
            abi.enumValue('GhosttyPointTag', 'SCREEN'),
            out
          );
          if (result !== GHOSTTY_SUCCESS) return null;
          return abi.view().getUint32(out + abi.offset('GhosttyPointCoordinate', 'y'), true);
        });
      },
      free: () => {
        if (freed) return;
        freed = true;
        abi.call('ghostty_tracked_grid_ref_free', ref);
      },
    };
  }

  hasMouseTracking(): boolean {
    return this.readTerminalU32('MOUSE_TRACKING') !== 0;
  }

  getMode(mode: number, isAnsi: boolean = false): boolean {
    const abi = this.abi;
    return abi.with(abi.sizeOf('GhosttyTerminalModeConfig'), (ptr) => {
      const view = abi.view();
      view.setUint16(
        ptr + abi.offset('GhosttyTerminalModeConfig', 'mode'),
        (mode & 0x7fff) | (isAnsi ? 0x8000 : 0),
        true
      );
      const result = abi.call(
        'ghostty_terminal_get',
        this.handle,
        abi.enumValue('GhosttyTerminalData', 'MODE'),
        ptr
      );
      if (result !== GHOSTTY_SUCCESS) return false;
      return abi.view().getUint8(ptr + abi.offset('GhosttyTerminalModeConfig', 'value')) !== 0;
    });
  }

  // ==========================================================================
  // Extended API (scrollback, graphemes, hyperlinks)
  // ==========================================================================

  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  /** Number of scrollback lines (history, not including the active screen). */
  getScrollbackLength(): number {
    return this.readTerminalU32('SCROLLBACK_ROWS');
  }

  /** A line of scrollback; offset 0 is the oldest line. */
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (offset < 0 || offset >= this.getScrollbackLength()) return null;
    this.update();
    const cells: GhosttyCell[] = [];
    let hyperlinkRun = 0;
    let previousLinked = false;
    for (let x = 0; x < this._cols; x++) {
      const cell = this.gridRef(POINT_HISTORY, x, offset, (ref) => this.cellAt(ref));
      if (!cell) return cells.length > 0 ? cells : null;
      if (cell.hyperlink_id) {
        if (!previousLinked) hyperlinkRun++;
        cell.hyperlink_id = hyperlinkRun;
      }
      previousLinked = cell.hyperlink_id !== 0;
      cells.push(cell);
    }
    return cells;
  }

  isRowWrapped(row: number): boolean {
    return this.rowContinues(POINT_ACTIVE, row);
  }

  /** Whether a scrollback line continues the one before it; offset 0 is the oldest line. */
  isScrollbackRowWrapped(offset: number): boolean {
    if (offset < 0 || offset >= this.getScrollbackLength()) return false;
    return this.rowContinues(POINT_HISTORY, offset);
  }

  private rowContinues(point: PointSpace, row: number): boolean {
    const abi = this.abi;
    return (
      this.gridRef(point, 0, row, (ref) =>
        abi.with(8, (rowPtr) => {
          if (abi.call('ghostty_grid_ref_row', ref, rowPtr) !== GHOSTTY_SUCCESS) return false;
          const raw = abi.view().getBigUint64(rowPtr, true);
          return abi.with(4, (out) => {
            const result = abi.call(
              'ghostty_row_get',
              raw,
              abi.enumValue('GhosttyRowData', 'WRAP_CONTINUATION'),
              out
            );
            return result === GHOSTTY_SUCCESS && abi.view().getUint8(out) !== 0;
          });
        })
      ) ?? false
    );
  }

  getHyperlinkUri(row: number, col: number): string | null {
    return this.gridRef(POINT_ACTIVE, col, row, (ref) => this.hyperlinkAt(ref)) ?? null;
  }

  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    return this.gridRef(POINT_HISTORY, col, offset, (ref) => this.hyperlinkAt(ref)) ?? null;
  }

  hasResponse(): boolean {
    return this.responses.length > 0;
  }

  readResponse(): string | null {
    if (this.responses.length === 0) return null;
    const out = this.responses.join('');
    this.responses = [];
    return out;
  }

  getGrapheme(row: number, col: number): number[] | null {
    return this.gridRef(POINT_ACTIVE, col, row, (ref) => this.graphemesAt(ref)) ?? null;
  }

  getGraphemeString(row: number, col: number): string {
    const codepoints = this.getGrapheme(row, col);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  getScrollbackGrapheme(offset: number, col: number): number[] | null {
    return this.gridRef(POINT_HISTORY, col, offset, (ref) => this.graphemesAt(ref)) ?? null;
  }

  getScrollbackGraphemeString(offset: number, col: number): string {
    const codepoints = this.getScrollbackGrapheme(offset, col);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Applies scrollback and color settings. Colors take effect on the whole
   * screen at the next update; programs can still change them (OSC 4/10/11).
   */
  configure(config: GhosttyTerminalConfig): void {
    const abi = this.abi;
    if (config.scrollbackLimit !== undefined) {
      this.setOption('SCROLLBACK_MAX_BYTES', 0);
      abi.with(4, (ptr) => {
        abi.view().setUint32(ptr, config.scrollbackLimit!, true);
        this.setOption('SCROLLBACK_MAX_LINES', ptr);
      });
    }
    const setRgb = (option: string, color: number | undefined) => {
      if (color === undefined) return;
      abi.with(4, (ptr) => {
        const view = abi.view();
        view.setUint8(ptr, (color >> 16) & 0xff);
        view.setUint8(ptr + 1, (color >> 8) & 0xff);
        view.setUint8(ptr + 2, color & 0xff);
        this.setOption(option, ptr);
      });
    };
    setRgb('COLOR_FOREGROUND', config.fgColor);
    setRgb('COLOR_BACKGROUND', config.bgColor);
    setRgb('COLOR_CURSOR', config.cursorColor);
    if (config.palette?.some((c) => c !== undefined)) {
      const size = 256 * 3;
      abi.with(size, (ptr) => {
        abi.check(
          'ghostty_terminal_get',
          this.handle,
          abi.enumValue('GhosttyTerminalData', 'COLOR_PALETTE_DEFAULT'),
          ptr
        );
        const view = abi.view();
        config.palette!.slice(0, 16).forEach((color, i) => {
          if (color === undefined) return;
          view.setUint8(ptr + i * 3, (color >> 16) & 0xff);
          view.setUint8(ptr + i * 3 + 1, (color >> 8) & 0xff);
          view.setUint8(ptr + i * 3 + 2, color & 0xff);
        });
        this.setOption('COLOR_PALETTE', ptr);
      });
    }
    this.changed = true;
    this.dirty = DirtyState.FULL;
  }

  private installHooks(): void {
    const abi = this.abi;
    const hook = (option: string, params: number, fn: (...args: number[]) => void) => {
      const index = abi.addCallback(Array(params).fill('i32'), null, fn);
      this.callbacks.push(index);
      this.setOption(option, index);
    };
    hook('BELL', 2, () => this.bellEmitter.fire());
    hook('TITLE_CHANGED', 2, () => this.titleEmitter.fire(this.readTerminalString('TITLE')));
    hook('PWD_CHANGED', 2, () => this.pwdEmitter.fire(this.readTerminalString('PWD')));
    hook('SEMANTIC_PROMPT', 3, (_t, _u, event) => {
      const type = 'GhosttyTerminalSemanticPrompt';
      const view = abi.view();
      const kindValue = view.getInt32(event + abi.offset(type, 'kind'), true);
      const kindName = Object.keys(PROMPT_KINDS).find(
        (k) => abi.enumValue('GhosttySemanticPromptKind', k) === kindValue
      );
      if (!kindName) return;
      const hasExit = view.getUint8(event + abi.offset(type, 'has_exit_code')) !== 0;
      const command = event + abi.offset(type, 'command');
      this.promptEmitter.fire({
        kind: PROMPT_KINDS[kindName],
        exitCode: hasExit ? view.getInt32(event + abi.offset(type, 'exit_code'), true) : undefined,
        command: this.stringAt(command),
      });
    });
    hook('DESKTOP_NOTIFICATION', 3, (_t, _u, n) => {
      const type = 'GhosttyTerminalDesktopNotification';
      this.notificationEmitter.fire({
        title: this.stringAt(n + abi.offset(type, 'title')),
        body: this.stringAt(n + abi.offset(type, 'body')),
      });
    });
    hook('UNKNOWN_SEQUENCE', 3, (_t, _u, seq) => {
      const view = abi.view();
      const type = 'GhosttyTerminalUnknownSequence';
      const tag = view.getInt32(seq + abi.offset(type, 'tag'), true);
      if (tag !== abi.enumValue('GhosttyTerminalUnknownSequenceTag', 'OSC')) return;
      const osc = seq + abi.offset(type, 'value');
      const oscType = 'GhosttyTerminalUnknownOscSequence';
      if (view.getUint8(osc + abi.offset(oscType, 'truncated')) !== 0) return;
      this.unknownOscEmitter.fire(this.stringAt(osc + abi.offset(oscType, 'content')));
    });
    abi.with(4, (ptr) => {
      abi.view().setUint32(ptr, UNKNOWN_SEQUENCE_MAX_BYTES, true);
      this.setOption('UNKNOWN_MAX_BYTES', ptr);
    });
    hook('CLIPBOARD_WRITE', 3, (_t, _u, write) => this.answerClipboardWrite(write));
  }

  private answerClipboardWrite(write: number): void {
    const abi = this.abi;
    const type = 'GhosttyClipboardWrite';
    const view = abi.view();
    const contents = view.getUint32(write + abi.offset(type, 'contents'), true);
    const count = view.getUint32(write + abi.offset(type, 'contents_len'), true);
    const entry = abi.sizeOf('GhosttyClipboardContent');
    let text: string | null = null;
    for (let i = 0; i < count; i++) {
      const at = contents + i * entry;
      const mime = this.stringAt(at + abi.offset('GhosttyClipboardContent', 'mime'));
      if (text === null || mime.startsWith('text/plain')) {
        text = this.stringAt(at + abi.offset('GhosttyClipboardContent', 'data'));
      }
    }
    const allowed = text !== null && this.clipboardWriteHandler?.(text) === true;
    const results = 'GhosttyClipboardWriteResult';
    const reply = abi.exports.__indirect_function_table.get(
      view.getUint32(write + abi.offset(type, 'reply'), true)
    ) as ((write: number, reply: number) => void) | null;
    abi.withSized('GhosttyClipboardWriteReply', (ptr) => {
      abi
        .view()
        .setInt32(
          ptr + abi.offset('GhosttyClipboardWriteReply', 'result'),
          abi.enumValue(results, allowed ? 'SUCCESS' : 'DENIED'),
          true
        );
      reply?.(write, ptr);
    });
  }

  private stringAt(ptr: number): string {
    const view = this.abi.view();
    const data = view.getUint32(ptr + this.abi.offset('GhosttyString', 'ptr'), true);
    const len = view.getUint32(ptr + this.abi.offset('GhosttyString', 'len'), true);
    return this.abi.string(data, len);
  }

  private readTerminalString(data: string): string {
    const abi = this.abi;
    return abi.with(abi.sizeOf('GhosttyString'), (out) => {
      const result = abi.call(
        'ghostty_terminal_get',
        this.handle,
        abi.enumValue('GhosttyTerminalData', data),
        out
      );
      return result === GHOSTTY_SUCCESS ? this.stringAt(out) : '';
    });
  }

  private setModeDefault(mode: number, value: boolean, isAnsi: boolean = false): void {
    const abi = this.abi;
    abi.with(abi.sizeOf('GhosttyTerminalModeConfig'), (ptr) => {
      const view = abi.view();
      view.setUint16(
        ptr + abi.offset('GhosttyTerminalModeConfig', 'mode'),
        (mode & 0x7fff) | (isAnsi ? 0x8000 : 0),
        true
      );
      view.setUint8(ptr + abi.offset('GhosttyTerminalModeConfig', 'value'), value ? 1 : 0);
      this.setOption('MODE_DEFAULT', ptr);
    });
  }

  private readTerminalU32(data: string): number {
    const abi = this.abi;
    return abi.with(8, (out) => {
      abi.check(
        'ghostty_terminal_get',
        this.handle,
        abi.enumValue('GhosttyTerminalData', data),
        out
      );
      return abi.view().getUint32(out, true);
    });
  }

  private readTerminalU16(data: string): number {
    const abi = this.abi;
    return abi.with(8, (out) => {
      abi.check(
        'ghostty_terminal_get',
        this.handle,
        abi.enumValue('GhosttyTerminalData', data),
        out
      );
      return abi.view().getUint16(out, true);
    });
  }

  private readRenderU32(data: string): number {
    const abi = this.abi;
    return abi.with(8, (out) => {
      abi.check(
        'ghostty_render_state_get',
        this.renderState,
        abi.enumValue('GhosttyRenderStateData', data),
        out
      );
      return abi.view().getUint32(out, true);
    });
  }

  private readColors(): void {
    const abi = this.abi;
    abi.withSized('GhosttyRenderStateColors', (ptr) => {
      abi.check(
        'ghostty_render_state_get',
        this.renderState,
        abi.enumValue('GhosttyRenderStateData', 'COLORS'),
        ptr
      );
      const view = abi.view();
      const at = (f: string) => ptr + abi.offset('GhosttyRenderStateColors', f);
      const palette: RGB[] = [];
      for (let i = 0; i < 256; i++) palette.push(rgbAt(view, at('palette') + i * 3));
      this.colors = {
        background: rgbAt(view, at('background')),
        foreground: rgbAt(view, at('foreground')),
        cursor: view.getUint8(at('cursor_has_value')) ? rgbAt(view, at('cursor')) : null,
        palette,
      };
    });
    this.readTerminalColors();
  }

  /**
   * The render state does not pick up default colors set with
   * ghostty_terminal_set, so the effective colors (a program's OSC override,
   * else the default) are read from the terminal itself.
   */
  private readTerminalColors(): void {
    const abi = this.abi;
    const data = (name: string) => abi.enumValue('GhosttyTerminalData', name);
    const rgb = (name: string): RGB | null =>
      abi.with(4, (ptr) =>
        abi.call('ghostty_terminal_get', this.handle, data(name), ptr) === GHOSTTY_SUCCESS
          ? rgbAt(abi.view(), ptr)
          : null
      );
    this.colors.background = rgb('COLOR_BACKGROUND') ?? this.colors.background;
    this.colors.foreground = rgb('COLOR_FOREGROUND') ?? this.colors.foreground;
    this.colors.cursor = rgb('COLOR_CURSOR') ?? this.colors.cursor;
    abi.with(256 * 3, (ptr) => {
      if (
        abi.call('ghostty_terminal_get', this.handle, data('COLOR_PALETTE'), ptr) !==
        GHOSTTY_SUCCESS
      ) {
        return;
      }
      const view = abi.view();
      for (let i = 0; i < 256; i++) this.colors.palette[i] = rgbAt(view, ptr + i * 3);
    });
  }

  private extractRows(all: boolean): void {
    const abi = this.abi;
    const layout = this.layout;
    const rowGet = layout.rowGet;
    const iteratorNext = layout.rowIteratorNext;
    const scratch = this.scratch;
    const view = abi.view();
    view.setUint32(scratch.slot, this.rowIterator, true);
    abi.check('ghostty_render_state_get', this.renderState, layout.rowIteratorData, scratch.slot);
    let y = 0;
    while (y < this._rows && iteratorNext(this.rowIterator)) {
      const v = abi.view();
      v.setUint32(scratch.slot, this.rowCells, true);
      let rowDirty = all;
      if (!rowDirty) {
        rowGet(this.rowIterator, layout.rowDirtyData, scratch.flag);
        rowDirty = abi.view().getUint8(scratch.flag) !== 0;
      }
      if (rowDirty) {
        this.rowDirty[y] = true;
        const result = rowGet(this.rowIterator, layout.rowCellsData, scratch.slot);
        if (result !== GHOSTTY_SUCCESS)
          throw new GhosttyCallError('ghostty_render_state_row_get', result);
        this.extractCells(y);
      }
      y++;
    }
  }

  private extractCells(y: number): void {
    const abi = this.abi;
    const layout = this.layout;
    const scratch = this.scratch;
    const cellsNext = layout.rowCellsNext;
    const getMulti = layout.rowCellsGetMulti;
    const pool = this.cellPool;
    const cols = this._cols;
    const rowStart = y * cols;
    let view = abi.view();
    let x = 0;
    let hyperlinkRun = 0;
    let previousLinked = false;
    while (x < cols && cellsNext(this.rowCells)) {
      if (view.buffer !== abi.exports.memory.buffer) view = abi.view();
      view.setUint32(scratch.style, layout.styleSize, true);
      const result = getMulti(this.rowCells, 3, scratch.keys, scratch.values, scratch.written);
      if (result !== GHOSTTY_SUCCESS) {
        throw new GhosttyCallError('ghostty_render_state_row_cells_get_multi', result);
      }
      if (view.buffer !== abi.exports.memory.buffer) view = abi.view();
      const cell = pool[rowStart + x];
      this.fillCellFrom(
        cell,
        view,
        view.getUint32(scratch.raw, true),
        view.getUint32(scratch.raw + 4, true),
        scratch.style,
        view.getUint32(scratch.len, true)
      );
      if (cell.hyperlink_id) {
        if (!previousLinked) hyperlinkRun++;
        cell.hyperlink_id = hyperlinkRun;
      }
      previousLinked = cell.hyperlink_id !== 0;
      x++;
    }
  }

  private fillCell(cell: GhosttyCell, raw: bigint, stylePtr: number, graphemeLen: number): void {
    this.fillCellFrom(
      cell,
      this.abi.view(),
      Number(raw & 0xffffffffn),
      Number(raw >> 32n),
      stylePtr,
      graphemeLen
    );
  }

  private fillCellFrom(
    cell: GhosttyCell,
    view: DataView,
    lo: number,
    hi: number,
    stylePtr: number,
    graphemeLen: number
  ): void {
    const L = this.layout;
    const tag = lo & 0x3;
    const contentBits = (lo >>> 2) & 0xffffff;
    cell.codepoint = tag === L.tagCodepoint || tag === L.tagGrapheme ? contentBits & 0x1fffff : 0;
    cell.grapheme_len = graphemeLen > 1 ? graphemeLen - 1 : 0;

    const styleId = ((lo >>> 26) | (hi << 6)) & 0xffff;
    let fg = this.colors.foreground;
    let bg = this.colors.background;
    let flags = 0;
    if (styleId !== 0) {
      fg = this.styleColor(view, stylePtr + L.fgColor) ?? fg;
      bg = this.styleColor(view, stylePtr + L.bgColor) ?? bg;
      if (view.getUint8(stylePtr + L.bold)) flags |= CellFlags.BOLD;
      if (view.getUint8(stylePtr + L.italic)) flags |= CellFlags.ITALIC;
      if (view.getInt32(stylePtr + L.underline, true) !== 0) flags |= CellFlags.UNDERLINE;
      if (view.getUint8(stylePtr + L.strikethrough)) flags |= CellFlags.STRIKETHROUGH;
      if (view.getUint8(stylePtr + L.inverse)) flags |= CellFlags.INVERSE;
      if (view.getUint8(stylePtr + L.invisible)) flags |= CellFlags.INVISIBLE;
      if (view.getUint8(stylePtr + L.blink)) flags |= CellFlags.BLINK;
      if (view.getUint8(stylePtr + L.faint)) flags |= CellFlags.FAINT;
    }
    if (tag === L.tagBgPalette) {
      bg = this.colors.palette[contentBits & 0xff] ?? bg;
    } else if (tag === L.tagBgRgb) {
      bg = { r: contentBits & 0xff, g: (contentBits >> 8) & 0xff, b: (contentBits >> 16) & 0xff };
    }
    cell.fg_r = fg.r;
    cell.fg_g = fg.g;
    cell.fg_b = fg.b;
    cell.bg_r = bg.r;
    cell.bg_g = bg.g;
    cell.bg_b = bg.b;
    cell.flags = flags;

    const wide = (hi >>> 10) & 0x3;
    cell.width = wide === L.wideWide ? 2 : wide === L.wideSpacerTail ? 0 : 1;
    cell.hyperlink_id = (hi >>> 13) & 0x1;
  }

  private styleColor(view: DataView, ptr: number): RGB | null {
    const L = this.layout;
    const tag = view.getInt32(ptr + L.colorTag, true);
    if (tag === L.colorPalette)
      return this.colors.palette[view.getUint8(ptr + L.colorValue)] ?? null;
    if (tag === L.colorRgb) return rgbAt(view, ptr + L.colorValue);
    return null;
  }

  private gridRef<T>(space: PointSpace, x: number, y: number, use: (ref: number) => T): T | null {
    const abi = this.abi;
    return abi.with(abi.sizeOf('GhosttyPoint'), (point) => {
      const view = abi.view();
      view.setInt32(point, abi.enumValue('GhosttyPointTag', space), true);
      const coord = point + abi.offset('GhosttyPoint', 'value');
      view.setUint16(coord + abi.offset('GhosttyPointCoordinate', 'x'), x, true);
      view.setUint32(coord + abi.offset('GhosttyPointCoordinate', 'y'), y, true);
      return abi.withSized('GhosttyGridRef', (ref) => {
        const result = abi.call('ghostty_terminal_grid_ref', this.handle, point, ref);
        return result === GHOSTTY_SUCCESS ? use(ref) : null;
      });
    });
  }

  private cellAt(ref: number): GhosttyCell | null {
    const abi = this.abi;
    const styleSize = abi.sizeOf('GhosttyStyle');
    return abi.with(8 + styleSize, (rawPtr) => {
      if (abi.call('ghostty_grid_ref_cell', ref, rawPtr) !== GHOSTTY_SUCCESS) return null;
      const stylePtr = rawPtr + 8;
      abi.view().setUint32(stylePtr, styleSize, true);
      if (abi.call('ghostty_grid_ref_style', ref, stylePtr) !== GHOSTTY_SUCCESS) return null;
      const graphemes = this.graphemesAt(ref);
      const cell = GhosttyTerminal.emptyCell();
      this.fillCell(cell, abi.view().getBigUint64(rawPtr, true), stylePtr, graphemes?.length ?? 0);
      return cell;
    });
  }

  private graphemesAt(ref: number): number[] | null {
    const abi = this.abi;
    return abi.with(GRAPHEME_CAP * 4 + 8, (buf) => {
      const outLen = buf + GRAPHEME_CAP * 4;
      const result = abi.call('ghostty_grid_ref_graphemes', ref, buf, GRAPHEME_CAP, outLen);
      if (result !== GHOSTTY_SUCCESS) return null;
      const n = Math.min(abi.view().getUint32(outLen, true), GRAPHEME_CAP);
      const view = abi.view();
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(view.getUint32(buf + i * 4, true));
      return out;
    });
  }

  private hyperlinkAt(ref: number): string | null {
    const abi = this.abi;
    for (const cap of HYPERLINK_CAPS) {
      const uri = abi.with(cap + 8, (buf) => {
        const outLen = buf + cap;
        const result = abi.call('ghostty_grid_ref_hyperlink_uri', ref, buf, cap, outLen);
        if (result === GHOSTTY_SUCCESS) {
          const len = abi.view().getUint32(outLen, true);
          return len === 0 ? null : abi.string(buf, len);
        }
        return result;
      });
      if (typeof uri === 'string' || uri === null) return uri;
    }
    return null;
  }

  private static emptyCell(): GhosttyCell {
    return {
      codepoint: 0,
      fg_r: 204,
      fg_g: 204,
      fg_b: 204,
      bg_r: 0,
      bg_g: 0,
      bg_b: 0,
      flags: 0,
      width: 1,
      hyperlink_id: 0,
      grapheme_len: 0,
    };
  }

  private initCellPool(): void {
    const total = this._cols * this._rows;
    while (this.cellPool.length < total) this.cellPool.push(GhosttyTerminal.emptyCell());
    this.cellPool.length = total;
    this.rowDirty = new Array(this._rows).fill(true);
    this.dirty = DirtyState.FULL;
  }
}
