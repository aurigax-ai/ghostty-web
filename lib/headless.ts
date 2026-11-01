import { BufferNamespace } from './buffer';
import { type CsiHandler, type CsiIdentifier, CsiObserver } from './csi-observer';
import { EventEmitter } from './event-emitter';
import type { Ghostty, GhosttyTerminal, MouseTrackingMode, SemanticPromptEvent } from './ghostty';
import type { IBufferNamespace, IDisposable, IEvent } from './interfaces';
import { type IMarker, Marker } from './marker';

export interface HeadlessTerminalOptions {
  ghostty: Ghostty;
  cols?: number;
  rows?: number;
  /**
   * Lines kept above the screen. Ghostty frees whole pages, never single rows,
   * so at 80 columns it can hold about half of this, and a
   * narrow screen, whose page holds more rows, can hold more than this.
   */
  scrollback?: number;
}

export type OscHandler = (data: string) => boolean | Promise<boolean>;

export interface HeadlessParser {
  /** Runs `handler` with the OSC payload after its number; its result is ignored. */
  registerOscHandler(ident: number, handler: OscHandler): IDisposable;
  /** Observes a CSI sequence just before the terminal applies it; its result is ignored. */
  registerCsiHandler(id: CsiIdentifier, handler: CsiHandler): IDisposable;
}

const PROMPT_MARKS: Record<SemanticPromptEvent['kind'], string> = {
  'prompt-start': 'A',
  'input-start': 'B',
  'output-start': 'C',
  'command-end': 'D',
};

const LINE_FEED = 0x0a;
const LINES_PER_SLICE = 128;

function unknownOsc(content: string): { ident: number; data: string } | null {
  const sep = content.indexOf(';');
  const ident = Number(sep === -1 ? content : content.slice(0, sep));
  if (!Number.isInteger(ident) || ident < 0) return null;
  return { ident, data: sep === -1 ? '' : content.slice(sep + 1) };
}

/**
 * A terminal with no DOM, canvas or renderer: it parses bytes and keeps the
 * screen, scrollback, markers and OSC/CSI hooks, with the xterm.js names that
 * `Terminal` uses. Writes are synchronous; the write callback runs in a
 * microtask. Replies the terminal would send to the program are dropped.
 */
export class HeadlessTerminal implements IDisposable {
  readonly buffer: IBufferNamespace;
  readonly parser: HeadlessParser;
  readonly onScroll: IEvent<number>;
  readonly onWriteParsed: IEvent<void>;
  readonly onTitleChange: IEvent<string>;

  cols: number;
  rows: number;
  wasmTerm: GhosttyTerminal | undefined;
  readonly viewportY = 0;

  private readonly scrollEmitter = new EventEmitter<number>();
  private readonly writeParsedEmitter = new EventEmitter<void>();
  private readonly titleEmitter = new EventEmitter<string>();
  private readonly oscRoutes = new Map<number, Set<OscHandler>>();
  private readonly csi = new CsiObserver();
  private readonly markers = new Set<Marker>();
  private readonly subscriptions: IDisposable[];
  private readonly encoder = new TextEncoder();
  private lastAlternate = false;
  private lastBase = 0;
  private disposed = false;

  constructor(options: HeadlessTerminalOptions) {
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    const engine = options.ghostty.createTerminal(this.cols, this.rows, {
      scrollbackLimit: options.scrollback ?? 10000,
    });
    this.wasmTerm = engine;
    this.buffer = new BufferNamespace(this);
    this.onScroll = this.scrollEmitter.event;
    this.onWriteParsed = this.writeParsedEmitter.event;
    this.onTitleChange = this.titleEmitter.event;
    this.parser = {
      registerOscHandler: (ident, handler) => this.addOsc(ident, handler),
      registerCsiHandler: (id, handler) => this.csi.register(id, handler),
    };
    this.subscriptions = [
      engine.onSemanticPrompt((event) => {
        const mark = PROMPT_MARKS[event.kind];
        const data =
          event.kind === 'command-end' && event.exitCode !== undefined
            ? `${mark};${event.exitCode}`
            : mark;
        this.fireOsc(133, data);
      }),
      engine.onPwdChange((pwd) => this.fireOsc(7, pwd)),
      engine.onTitleChange((title) => this.titleEmitter.fire(title)),
      engine.onUnknownOsc((content) => {
        const parsed = unknownOsc(content);
        if (parsed) this.fireOsc(parsed.ident, parsed.data);
      }),
    ];
    this.lastAlternate = engine.isAlternateScreen();
  }

  get modes(): { bracketedPasteMode: boolean; mouseTrackingMode: MouseTrackingMode } {
    return {
      bracketedPasteMode: this.wasmTerm?.hasBracketedPaste() ?? false,
      mouseTrackingMode: this.wasmTerm?.mouseTrackingMode() ?? 'none',
    };
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    const engine = this.wasmTerm;
    if (!engine || this.disposed) {
      if (callback) queueMicrotask(callback);
      return;
    }
    const bytes = typeof data === 'string' ? this.encoder.encode(data) : data;
    let written = 0;
    let lines = 0;
    const flushTo = (end: number): void => {
      if (end <= written) return;
      engine.write(bytes.subarray(written, end));
      written = end;
      this.afterChunk();
    };
    const watching = this.csi.active;
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      if (watching) this.csi.step(byte, i, flushTo);
      if (byte === LINE_FEED && ++lines % LINES_PER_SLICE === 0) flushTo(i + 1);
      if (this.disposed) return;
    }
    flushTo(bytes.length);
    this.writeParsedEmitter.fire();
    if (callback) queueMicrotask(callback);
  }

  resize(cols: number, rows: number): void {
    const engine = this.wasmTerm;
    if (!engine || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols;
    this.rows = rows;
    engine.resize(cols, rows);
    this.refreshMarkers(engine.rowsDiscarded());
  }

  /**
   * The logical lines of the rows `from` to `to` (0 is the oldest scrollback
   * row) of the screen that is showing, each with its colours and styles as
   * escape sequences. A wrapped line is one line, so the count is the number
   * of rows that do not continue the row before them, empty rows at the end
   * included. Costs one call into the engine, not one per row or cell.
   */
  serialize(range: { from: number; to: number }): string[] {
    const engine = this.wasmTerm;
    if (!engine || range.to < range.from) return [];
    const text = engine.formatRows(range.from, range.to);
    const lines = text === '' ? [] : text.split('\r\n');
    const scrollback = engine.isAlternateScreen() ? 0 : engine.getScrollbackLength();
    let expected = 1;
    for (let y = range.from + 1; y <= range.to; y++) {
      const wrapped =
        y < scrollback ? engine.isScrollbackRowWrapped(y) : engine.isRowWrapped(y - scrollback);
      if (!wrapped) expected++;
    }
    while (lines.length < expected) lines.push('');
    return lines;
  }

  registerMarker(cursorYOffset = 0): IMarker | undefined {
    const engine = this.wasmTerm;
    if (!engine) return undefined;
    const y = engine.cursorPosition().y + cursorYOffset;
    if (y < 0 || y >= this.rows) return undefined;
    if (engine.rowsDiscarded()) this.refreshMarkers(true);
    const row = engine.trackRow(y);
    if (!row) return undefined;
    const marker = new Marker(row);
    this.markers.add(marker);
    marker.onDispose(() => this.markers.delete(marker));
    return marker;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sub of this.subscriptions) sub.dispose();
    for (const marker of [...this.markers]) marker.dispose();
    this.markers.clear();
    this.oscRoutes.clear();
    this.scrollEmitter.dispose();
    this.writeParsedEmitter.dispose();
    this.titleEmitter.dispose();
    this.wasmTerm?.free();
    this.wasmTerm = undefined;
  }

  private addOsc(ident: number, handler: OscHandler): IDisposable {
    const set = this.oscRoutes.get(ident) ?? new Set<OscHandler>();
    set.add(handler);
    this.oscRoutes.set(ident, set);
    return { dispose: () => set.delete(handler) };
  }

  private fireOsc(ident: number, data: string): void {
    for (const handler of [...(this.oscRoutes.get(ident) ?? [])]) void handler(data);
  }

  private afterChunk(): void {
    const engine = this.wasmTerm;
    if (!engine) return;
    while (engine.hasResponse()) engine.readResponse();
    const alternate = engine.isAlternateScreen();
    const switched = alternate !== this.lastAlternate;
    this.lastAlternate = alternate;
    if (switched) {
      (this.buffer as BufferNamespace)._fireBufferChange(this.buffer.active);
    }
    const discarded = engine.rowsDiscarded();
    this.refreshMarkers(switched || discarded);
    const base = engine.getScrollbackLength();
    if (!alternate && (base !== this.lastBase || discarded)) {
      this.lastBase = base;
      this.scrollEmitter.fire(base);
    }
  }

  private refreshMarkers(needed: boolean): void {
    if (!needed) return;
    for (const marker of [...this.markers]) marker.refresh();
  }
}
