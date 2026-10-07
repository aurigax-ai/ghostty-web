/**
 * Terminal renderers.
 *
 * `TerminalRenderer` decides what changed in a frame (dirty rows, cursor,
 * selection, hovered links, scrolling) and owns the state every renderer
 * shares; `CanvasRenderer` draws with Canvas 2D and `WebglRenderer`
 * (webgl-renderer.ts) with WebGL 2. Both draw box drawing and block elements
 * from geometry (box-glyphs.ts) so they fill their cells.
 */

import { drawBoxGlyph, isBoxGlyph } from './box-glyphs';
import type { FontWeight, ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell } from './types';
import { CellFlags } from './types';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  /** A row's cells without a copy, read before the buffer next changes; getLine() when absent. */
  getLineView?(y: number): readonly GhosttyCell[] | null;
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

export const LINK_COLOR = '#4A90E2';
export const TEXT_STYLE_FLAGS = CellFlags.BOLD | CellFlags.ITALIC | CellFlags.FAINT;

export function isBlank(cell: GhosttyCell): boolean {
  return (cell.codepoint === 0 || cell.codepoint === 32) && cell.grapheme_len === 0;
}

function isPlainAscii(cell: GhosttyCell): boolean {
  return cell.width === 1 && cell.grapheme_len === 0 && cell.codepoint > 32 && cell.codepoint < 127;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
  fontWeight?: FontWeight; // Default: 'normal'
  fontWeightBold?: FontWeight; // Default: 'bold'
  lineHeight?: number; // Default: 1
  minimumContrastRatio?: number; // Default: 1 (off)
}

export interface FontOptions {
  fontWeight: FontWeight;
  fontWeightBold: FontWeight;
  lineHeight: number;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

// ============================================================================
// Default Theme
// ============================================================================

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

export type CursorStyle = 'block' | 'underline' | 'bar';

/** A search match drawn on one viewport row, columns inclusive. */
export interface SearchHighlight {
  row: number;
  start: number;
  end: number;
  active: boolean;
}

export interface SearchHighlightColors {
  match: string;
  active: string;
}

export interface LinkRange {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/** What a renderer draws over the rows once they are up to date. */
export interface FrameOverlay {
  cursorX: number;
  cursorY: number;
  /** Cursor shown: at the bottom of the scrollback, visible, and in the blink's on phase. */
  showCursor: boolean;
  /** The terminal has focus; an unfocused cursor is drawn as an outline and never blinks, as in xterm.js. */
  focused: boolean;
  viewportY: number;
  scrollbackLength: number;
  cols: number;
  rows: number;
  /** Scrollbar opacity, 0 when there is no scrollback provider. */
  scrollbarOpacity: number;
}

/** Measures the cell box of a font: width of 'M' and height from its ascent and descent. */
/**
 * Measures the cell box the way xterm.js's WebGL renderer does: the advance of
 * 'W' floored to device pixels, and the font's ascent plus descent (its line
 * box) times lineHeight, with the text centered in the extra space.
 */
export function measureCell(
  fontSize: number,
  fontFamily: string,
  fontWeight: FontWeight = 'normal',
  lineHeight = 1,
  dpr = 1
): FontMetrics {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const m = ctx.measureText('W');
  const width = Math.max(1, Math.floor(m.width * dpr)) / dpr;
  const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || fontSize * 0.8;
  const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || fontSize * 0.2;
  const charHeight = Math.ceil((ascent + descent) * dpr) / dpr;
  const height = Math.max(charHeight, Math.floor(charHeight * lineHeight * dpr) / dpr);
  const baseline = Math.round(((height - charHeight) / 2 + ascent) * dpr) / dpr;
  return { width, height, baseline };
}

/** WCAG relative luminance of an sRGB color. */
function luminance(r: number, g: number, b: number): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The foreground moved toward black or white, whichever reaches `ratio`
 * against the background first (black first on a light background), in 10%
 * steps; the original when it already reaches it.
 */
export function ensureContrast(
  fg: [number, number, number],
  bg: [number, number, number],
  ratio: number
): [number, number, number] {
  const bgLum = luminance(bg[0], bg[1], bg[2]);
  if (contrast(luminance(fg[0], fg[1], fg[2]), bgLum) >= ratio) return fg;
  const toward = (target: number): [number, number, number] | null => {
    for (let step = 1; step <= 10; step++) {
      const t = step / 10;
      const c: [number, number, number] = [
        Math.round(fg[0] + (target - fg[0]) * t),
        Math.round(fg[1] + (target - fg[1]) * t),
        Math.round(fg[2] + (target - fg[2]) * t),
      ];
      if (contrast(luminance(c[0], c[1], c[2]), bgLum) >= ratio) return c;
    }
    return null;
  };
  const darkFirst = bgLum > 0.5;
  return (
    toward(darkFirst ? 0 : 255) ??
    toward(darkFirst ? 255 : 0) ??
    (darkFirst ? [0, 0, 0] : [255, 255, 255])
  );
}

// ============================================================================
// TerminalRenderer: what to draw each frame
// ============================================================================

export abstract class TerminalRenderer {
  protected readonly canvas: HTMLCanvasElement;
  protected fontSize: number;
  protected fontFamily: string;
  protected cursorStyle: CursorStyle;
  protected cursorBlink: boolean;
  protected theme: Required<ITheme>;
  protected devicePixelRatio: number;
  protected metrics: FontMetrics;
  protected fontWeight: FontWeight;
  protected fontWeightBold: FontWeight;
  protected lineHeight: number;
  protected minimumContrastRatio: number;
  private readonly contrastCache = new Map<number, number>();
  private themeBackgroundRgb: [number, number, number] = [0, 0, 0];

  protected cursorVisible = true;
  private lastCursorVisible = true;
  protected focused = false;
  private lastFocused = false;
  private cursorBlinkInterval?: number;

  /** Called when the renderer needs another frame (cursor blink), so an idle render loop wakes. */
  public onNeedsFrame?: () => void;
  protected lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };
  private lastViewportY = 0;
  private fullRedrawPending = false;
  /** The cursor and scrollbar the last finished frame showed. */
  private shownOverlay: FrameOverlay | null = null;

  /** The buffer of the frame being drawn, for grapheme lookups. */
  protected currentBuffer: IRenderable | null = null;

  protected selectionManager?: SelectionManager;
  /** Selection of the frame being drawn, viewport-relative. */
  protected currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  private highlights = new Map<number, SearchHighlight[]>();
  private readonly highlightRows = new Set<number>();
  protected highlightColors: SearchHighlightColors = { match: '#5c6266', active: '#538bb5' };

  protected hoveredHyperlinkId = 0;
  private previousHoveredHyperlinkId = 0;
  protected hoveredLinkRange: LinkRange | null = null;
  private previousHoveredLinkRange: LinkRange | null = null;

  /** Whether a moved or blinking cursor needs its row redrawn (false when the cursor is an overlay). */
  protected abstract readonly cursorInRows: boolean;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;
    this.fontWeight = options.fontWeight ?? 'normal';
    this.fontWeightBold = options.fontWeightBold ?? 'bold';
    this.lineHeight = options.lineHeight ?? 1;
    this.minimumContrastRatio = options.minimumContrastRatio ?? 1;
    this.themeBackgroundRgb = cssRgb(this.theme.background);
    this.metrics = this.measure();
    if (this.cursorBlink && this.focused) this.startCursorBlink();
  }

  /** Draws one viewport row. */
  protected abstract drawLine(line: readonly GhosttyCell[], y: number, cols: number): void;
  /** Whether the drawing surface no longer matches cols × rows. */
  protected abstract surfaceMismatch(cols: number, rows: number): boolean;
  /** Draws the cursor and scrollbar and presents the frame. */
  protected abstract finishFrame(overlay: FrameOverlay): void;
  /** Resize the drawing surface to cols × rows cells. */
  public abstract resize(cols: number, rows: number): void;
  /** Clear the whole surface to the theme background. */
  public abstract clear(): void;
  /** Called after the font or its metrics changed. */
  protected abstract fontChanged(): void;

  public render(
    buffer: IRenderable,
    forceAll = false,
    viewportY = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity = 1
  ): void {
    this.currentBuffer = buffer;
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    if (buffer.needsFullRedraw?.()) forceAll = true;
    if (this.fullRedrawPending) {
      forceAll = true;
      this.fullRedrawPending = false;
    }
    if (this.surfaceMismatch(dims.cols, dims.rows)) {
      this.resize(dims.cols, dims.rows);
      forceAll = true;
    }
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    const blinked =
      this.cursorVisible !== this.lastCursorVisible || this.focused !== this.lastFocused;
    this.lastCursorVisible = this.cursorVisible;
    this.lastFocused = this.focused;
    // Scrolled back the cursor is not shown, and its row is not on screen where it is in the buffer.
    if (this.cursorInRows && viewportY === 0 && (cursorMoved || blinked)) {
      if (!forceAll && !buffer.isRowDirty(cursor.y)) {
        const line = this.bufferLine(cursor.y);
        if (line) this.drawLine(line, cursor.y, dims.cols);
      }
      if (cursorMoved && this.lastCursorPosition.y !== cursor.y) {
        if (!forceAll && !buffer.isRowDirty(this.lastCursorPosition.y)) {
          const line = this.bufferLine(this.lastCursorPosition.y);
          if (line) this.drawLine(line, this.lastCursorPosition.y, dims.cols);
        }
      }
    }

    const selectionRows = new Set<number>();
    const hasSelection = this.selectionManager?.hasSelection();
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) selectionRows.add(row);
    }
    for (const row of this.highlightRows) selectionRows.add(row);
    this.highlightRows.clear();
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) selectionRows.add(row);
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    const lineAt = (y: number): readonly GhosttyCell[] | null => {
      if (viewportY > 0) {
        if (y < viewportY && scrollbackProvider) {
          return scrollbackProvider.getScrollbackLine(scrollbackLength - Math.floor(viewportY) + y);
        }
        return this.bufferLine(y - Math.floor(viewportY));
      }
      return this.bufferLine(y);
    };
    // Scrolled back, viewport row y shows active row y - viewportY; rows above it show scrollback.
    const rowDirty = (y: number): boolean => {
      const active = y - Math.floor(viewportY);
      return active >= 0 && buffer.isRowDirty(active);
    };

    const hyperlinkRows = new Set<number>();
    if (this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId) {
      for (let y = 0; y < dims.rows; y++) {
        const line = lineAt(y);
        if (!line) continue;
        for (const cell of line) {
          if (
            cell.hyperlink_id === this.hoveredHyperlinkId ||
            cell.hyperlink_id === this.previousHoveredHyperlinkId
          ) {
            hyperlinkRows.add(y);
            break;
          }
        }
      }
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }
    if (!sameRange(this.hoveredLinkRange, this.previousHoveredLinkRange)) {
      for (const range of [this.previousHoveredLinkRange, this.hoveredLinkRange]) {
        if (!range) continue;
        for (let y = range.startY; y <= range.endY; y++) hyperlinkRows.add(y);
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      const needsRender = forceAll || rowDirty(y) || selectionRows.has(y) || hyperlinkRows.has(y);
      if (needsRender) {
        rowsToRender.add(y);
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) continue;
      const line = lineAt(y);
      if (line) this.drawLine(line, y, dims.cols);
    }

    const overlay: FrameOverlay = {
      cursorX: cursor.x,
      cursorY: cursor.y,
      showCursor: viewportY === 0 && cursor.visible && this.cursorVisible,
      focused: this.focused,
      viewportY,
      scrollbackLength,
      cols: dims.cols,
      rows: dims.rows,
      scrollbarOpacity: scrollbackProvider ? scrollbarOpacity : 0,
    };
    // A frame with no row drawn and the same cursor and scrollbar has nothing to show.
    if (rowsToRender.size > 0 || !sameOverlay(overlay, this.shownOverlay)) {
      this.finishFrame(overlay);
      this.shownOverlay = overlay;
    }
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };
    buffer.clearDirty();
  }

  /** A row of the buffer being drawn, without a copy when the buffer offers one. */
  protected bufferLine(y: number): readonly GhosttyCell[] | null {
    const buffer = this.currentBuffer;
    if (!buffer) return null;
    return buffer.getLineView ? buffer.getLineView(y) : buffer.getLine(y);
  }

  // ==========================================================================
  // Shared helpers
  // ==========================================================================

  /** Makes the next frame redraw every row. */
  protected requestFullRedraw(): void {
    this.fullRedrawPending = true;
    this.shownOverlay = null;
  }

  /** The text of a cell: its grapheme cluster when it has one, else its codepoint. */
  protected cellText(cell: GhosttyCell, x: number, y: number): string {
    if (cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString) {
      return this.currentBuffer.getGraphemeString(y, x);
    }
    return String.fromCodePoint(cell.codepoint || 32);
  }

  protected isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;
    const { startCol, startRow, endCol, endRow } = sel;
    if (startRow === endRow) return y === startRow && x >= startCol && x <= endCol;
    if (y === startRow) return x >= startCol;
    if (y === endRow) return x <= endCol;
    return y > startRow && y < endRow;
  }

  /** Search highlight under a cell: 0 none, 1 a match, 2 the selected match. */
  protected highlightAt(x: number, y: number): 0 | 1 | 2 {
    const ranges = this.highlights.get(y);
    if (!ranges) return 0;
    for (const range of ranges) {
      if (x >= range.start && x <= range.end) return range.active ? 2 : 1;
    }
    return 0;
  }

  /** Shows search matches (null clears them); only rows whose highlights changed are redrawn. */
  public setSearchHighlights(
    highlights: SearchHighlight[] | null,
    colors?: SearchHighlightColors
  ): void {
    for (const row of this.highlights.keys()) this.highlightRows.add(row);
    this.highlights = new Map();
    for (const highlight of highlights ?? []) {
      const row = this.highlights.get(highlight.row);
      if (row) row.push(highlight);
      else this.highlights.set(highlight.row, [highlight]);
      this.highlightRows.add(highlight.row);
    }
    if (colors) {
      this.highlightColors = colors;
      this.searchColorsChanged();
    }
  }

  /** Called when the search highlight colors change. */
  protected searchColorsChanged(): void {}

  /** Whether the cell has a hovered link under it (OSC 8 id or a detected URL range). */
  protected linkHovered(cell: GhosttyCell, x: number, y: number): boolean {
    if (cell.hyperlink_id > 0 && cell.hyperlink_id === this.hoveredHyperlinkId) return true;
    const range = this.hoveredLinkRange;
    if (!range) return false;
    return (
      (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
      (y > range.startY && y < range.endY) ||
      (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX))
    );
  }

  /** Scrollbar geometry in CSS pixels, or null when there is nothing to draw. */
  protected scrollbarThumb(overlay: FrameOverlay): {
    x: number;
    trackY: number;
    trackHeight: number;
    thumbY: number;
    thumbHeight: number;
    width: number;
  } | null {
    if (overlay.scrollbarOpacity <= 0 || overlay.scrollbackLength === 0) return null;
    const height = overlay.rows * this.metrics.height;
    const width = 8;
    const x = overlay.cols * this.metrics.width - width - 4;
    const padding = 4;
    const trackHeight = height - padding * 2;
    const total = overlay.scrollbackLength + overlay.rows;
    const thumbHeight = Math.max(20, (overlay.rows / total) * trackHeight);
    const position = overlay.viewportY / overlay.scrollbackLength;
    const thumbY = padding + (trackHeight - thumbHeight) * (1 - position);
    return { x, trackY: padding, trackHeight, thumbY, thumbHeight, width };
  }

  // ==========================================================================
  // Cursor blinking
  // ==========================================================================

  private startCursorBlink(): void {
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.onNeedsFrame?.();
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  private measure(): FontMetrics {
    return measureCell(
      this.fontSize,
      this.fontFamily,
      this.fontWeight,
      this.lineHeight,
      this.devicePixelRatio
    );
  }

  public remeasureFont(): void {
    this.metrics = this.measure();
    this.fontChanged();
  }

  public setFontOptions(options: FontOptions): void {
    this.fontWeight = options.fontWeight;
    this.fontWeightBold = options.fontWeightBold;
    this.lineHeight = options.lineHeight;
    this.remeasureFont();
  }

  public setMinimumContrastRatio(ratio: number): void {
    this.minimumContrastRatio = ratio;
    this.contrastCache.clear();
  }

  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.requestFullRedraw();
    this.themeBackgroundRgb = cssRgb(this.theme.background);
    this.contrastCache.clear();
  }

  /** The CSS font for a cell style (CellFlags.BOLD / ITALIC) at `size` px. */
  protected fontString(style: number, size: number): string {
    const italic = style & CellFlags.ITALIC ? 'italic ' : '';
    const weight = style & CellFlags.BOLD ? this.fontWeightBold : this.fontWeight;
    return `${italic}${weight} ${size}px ${this.fontFamily}`;
  }

  /**
   * The foreground (packed 0xRRGGBB) a cell is drawn with once
   * minimumContrastRatio is applied against its background; `bg` is null for
   * the theme background.
   */
  protected contrastedForeground(fg: number, bg: number | null): number {
    if (this.minimumContrastRatio <= 1) return fg;
    const back = bg ?? rgbWord(this.themeBackgroundRgb);
    const key = fg * 0x1000000 + back;
    let result = this.contrastCache.get(key);
    if (result === undefined) {
      const [r, g, b] = ensureContrast(
        [(fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff],
        [(back >> 16) & 0xff, (back >> 8) & 0xff, back & 0xff],
        this.minimumContrastRatio
      );
      result = rgbWord([r, g, b]);
      if (this.contrastCache.size > 4096) this.contrastCache.clear();
      this.contrastCache.set(key, result);
    }
    return result;
  }

  public setFontSize(size: number): void {
    this.fontSize = size;
    this.remeasureFont();
  }

  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.remeasureFont();
  }

  public setCursorStyle(style: CursorStyle): void {
    if (style === this.cursorStyle) return;
    this.cursorStyle = style;
    this.requestFullRedraw();
  }

  public setCursorBlink(enabled: boolean): void {
    if (enabled === this.cursorBlink) return;
    this.cursorBlink = enabled;
    this.stopCursorBlink();
    if (enabled && this.focused) this.startCursorBlink();
  }

  /** Blink only while focused; unfocused, the cursor is a steady outline. */
  public setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    this.stopCursorBlink();
    if (focused && this.cursorBlink) this.startCursorBlink();
  }

  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /** The canvas that takes pointer events and defines the terminal's box. */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  public getHoveredHyperlinkId(): number {
    return this.hoveredHyperlinkId;
  }

  /** Set the hovered range of a detected URL, or null to clear it. */
  public setHoveredLinkRange(range: LinkRange | null): void {
    this.hoveredLinkRange = range;
  }

  public get charWidth(): number {
    return this.metrics.width;
  }

  public get charHeight(): number {
    return this.metrics.height;
  }

  public dispose(): void {
    this.stopCursorBlink();
  }
}

function rgbWord([r, g, b]: [number, number, number]): number {
  return (r << 16) | (g << 8) | b;
}

/** An opaque CSS color as RGB; black when it cannot be read. */
export function cssRgb(css: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(css.trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const v = Number.parseInt(h.slice(0, 6), 16);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  }
  const rgb = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(css);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [0, 0, 0];
}

function sameOverlay(a: FrameOverlay, b: FrameOverlay | null): boolean {
  return (
    b !== null &&
    a.cursorX === b.cursorX &&
    a.cursorY === b.cursorY &&
    a.showCursor === b.showCursor &&
    a.focused === b.focused &&
    a.viewportY === b.viewportY &&
    a.scrollbackLength === b.scrollbackLength &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.scrollbarOpacity === b.scrollbarOpacity
  );
}

function sameRange(a: LinkRange | null, b: LinkRange | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.startX === b.startX && a.startY === b.startY && a.endX === b.endX && a.endY === b.endY;
}

// ============================================================================
// CanvasRenderer
// ============================================================================

export class CanvasRenderer extends TerminalRenderer {
  protected readonly cursorInRows = true;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly batchText: boolean;
  private readonly colorStrings = new Map<number, string>();
  private fonts: string[] = [];
  private readonly advances = new Map<string, number>();
  private currentFill = '';
  private currentFont = '';

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    super(canvas, options);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Failed to get 2D rendering context');
    this.ctx = ctx;
    this.batchText = typeof ctx.letterSpacing === 'string';
  }

  protected surfaceMismatch(cols: number, rows: number): boolean {
    return (
      this.canvas.width !== Math.round(cols * this.metrics.width * this.devicePixelRatio) ||
      this.canvas.height !== Math.round(rows * this.metrics.height * this.devicePixelRatio)
    );
  }

  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * this.devicePixelRatio);
    this.canvas.height = Math.round(cssHeight * this.devicePixelRatio);
    this.resetContextCache();
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  public clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.resetContextCache();
  }

  protected fontChanged(): void {
    this.fonts = [];
    this.advances.clear();
    this.currentFont = '';
  }

  protected finishFrame(overlay: FrameOverlay): void {
    if (overlay.showCursor) this.renderCursor(overlay.cursorX, overlay.cursorY, overlay.focused);
    if (overlay.scrollbarOpacity > 0) this.renderScrollbar(overlay);
  }

  /**
   * Draws a row in two passes, backgrounds then text, so glyphs that extend
   * past their cell are not covered by a neighbour's background. Backgrounds
   * of one color are one rect; runs of plain ASCII in one style are one
   * fillText, spaced to the cell grid with letterSpacing.
   */
  protected drawLine(line: readonly GhosttyCell[], y: number, cols: number): void {
    const ctx = this.ctx;
    const cellW = this.metrics.width;
    const cellH = this.metrics.height;
    const lineY = y * cellH;

    ctx.clearRect(0, lineY, cols * cellW, cellH);
    this.setFill(this.theme.background);
    ctx.fillRect(0, lineY, cols * cellW, cellH);

    let runStart = 0;
    let runEnd = 0;
    let runColor: string | null = null;
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue;
      const color = this.backgroundColor(cell, x, y);
      if (color !== runColor) {
        if (runColor) {
          this.setFill(runColor);
          ctx.fillRect(runStart * cellW, lineY, (runEnd - runStart) * cellW, cellH);
        }
        runColor = color;
        runStart = x;
      }
      runEnd = x + cell.width;
    }
    if (runColor) {
      this.setFill(runColor);
      ctx.fillRect(runStart * cellW, lineY, (runEnd - runStart) * cellW, cellH);
    }

    let x = 0;
    while (x < line.length) {
      const cell = line[x];
      if (cell.width === 0 || cell.flags & CellFlags.INVISIBLE) {
        x++;
        continue;
      }
      const color = this.foregroundColor(cell, this.isInSelection(x, y));
      if (isBlank(cell)) {
        this.renderDecorations(cell, x, y, color);
        x++;
        continue;
      }
      if (!this.batchText || !isPlainAscii(cell)) {
        this.renderCellText(cell, x, y, color);
        x++;
        continue;
      }
      const style = cell.flags & TEXT_STYLE_FLAGS;
      let text = String.fromCharCode(cell.codepoint);
      let end = x + 1;
      let lastGlyph = x;
      this.renderDecorations(cell, x, y, color);
      while (end < line.length) {
        const next = line[end];
        if (next.width !== 1 || next.flags & CellFlags.INVISIBLE) break;
        const nextColor = this.foregroundColor(next, this.isInSelection(end, y));
        if (isBlank(next)) {
          this.renderDecorations(next, end, y, nextColor);
          text += ' ';
          end++;
          continue;
        }
        if (!isPlainAscii(next)) break;
        if ((next.flags & TEXT_STYLE_FLAGS) !== style || nextColor !== color) break;
        this.renderDecorations(next, end, y, nextColor);
        text += String.fromCharCode(next.codepoint);
        lastGlyph = end;
        end++;
      }
      this.drawText(text.slice(0, lastGlyph - x + 1), x, y, style, color);
      x = end;
    }
  }

  private backgroundColor(cell: GhosttyCell, x: number, y: number): string | null {
    if (this.isInSelection(x, y)) return this.theme.selectionBackground;
    const highlight = this.highlightAt(x, y);
    if (highlight)
      return highlight === 2 ? this.highlightColors.active : this.highlightColors.match;
    const inverse = cell.flags & CellFlags.INVERSE;
    const r = inverse ? cell.fg_r : cell.bg_r;
    const g = inverse ? cell.fg_g : cell.bg_g;
    const b = inverse ? cell.fg_b : cell.bg_b;
    if (r === 0 && g === 0 && b === 0) return null;
    return this.cssColor(r, g, b);
  }

  private foregroundColor(cell: GhosttyCell, selected: boolean): string {
    if (selected) return this.theme.selectionForeground;
    const inverse = cell.flags & CellFlags.INVERSE;
    const fg = inverse
      ? (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b
      : (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
    const bg = inverse
      ? (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b
      : (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;
    const word = this.contrastedForeground(fg, bg === 0 ? null : bg);
    return this.cssColor((word >> 16) & 0xff, (word >> 8) & 0xff, word & 0xff);
  }

  private cssColor(r: number, g: number, b: number): string {
    const key = (r << 16) | (g << 8) | b;
    let color = this.colorStrings.get(key);
    if (color === undefined) {
      color = `rgb(${r}, ${g}, ${b})`;
      this.colorStrings.set(key, color);
    }
    return color;
  }

  private setFill(color: string): void {
    if (this.currentFill !== color) {
      this.ctx.fillStyle = color;
      this.currentFill = color;
    }
  }

  private setFont(style: number): void {
    const font = this.fontFor(style);
    if (this.currentFont !== font) {
      this.ctx.font = font;
      this.currentFont = font;
      if (this.batchText) this.ctx.letterSpacing = `${this.metrics.width - this.advanceOf(font)}px`;
    }
  }

  private fontFor(style: number): string {
    let font = this.fonts[style];
    if (font === undefined) {
      font = this.fontString(style, this.fontSize);
      this.fonts[style] = font;
    }
    return font;
  }

  private advanceOf(font: string): number {
    let advance = this.advances.get(font);
    if (advance === undefined) {
      const spacing = this.ctx.letterSpacing;
      this.ctx.letterSpacing = '0px';
      advance = this.ctx.measureText('M').width;
      this.ctx.letterSpacing = spacing;
      this.advances.set(font, advance);
    }
    return advance;
  }

  private resetContextCache(): void {
    this.currentFill = '';
    this.currentFont = '';
  }

  private drawText(text: string, x: number, y: number, style: number, color: string): void {
    this.setFont(style);
    this.setFill(color);
    const faint = style & CellFlags.FAINT;
    if (faint) this.ctx.globalAlpha = 0.5;
    this.ctx.fillText(
      text,
      x * this.metrics.width,
      y * this.metrics.height + this.metrics.baseline
    );
    if (faint) this.ctx.globalAlpha = 1.0;
  }

  /** One cell's glyph and decorations, for cells a run cannot hold and the glyph under a block cursor. */
  private renderCellText(cell: GhosttyCell, x: number, y: number, color: string): void {
    if (cell.flags & CellFlags.INVISIBLE) return;
    if (cell.grapheme_len === 0 && isBoxGlyph(cell.codepoint)) {
      this.setFill(color);
      const faint = cell.flags & CellFlags.FAINT;
      if (faint) this.ctx.globalAlpha = 0.5;
      drawBoxGlyph(
        this.ctx,
        cell.codepoint,
        x * this.metrics.width,
        y * this.metrics.height,
        this.metrics.width * cell.width,
        this.metrics.height
      );
      if (faint) this.ctx.globalAlpha = 1.0;
      this.resetContextCache();
    } else {
      const spacing = this.batchText ? this.ctx.letterSpacing : '';
      if (this.batchText) this.ctx.letterSpacing = '0px';
      this.drawText(this.cellText(cell, x, y), x, y, cell.flags & TEXT_STYLE_FLAGS, color);
      if (this.batchText) this.ctx.letterSpacing = spacing;
    }
    this.renderDecorations(cell, x, y, color);
  }

  private renderDecorations(cell: GhosttyCell, x: number, y: number, color: string): void {
    const underline = cell.flags & CellFlags.UNDERLINE;
    const strike = cell.flags & CellFlags.STRIKETHROUGH;
    const link = (cell.hyperlink_id > 0 || this.hoveredLinkRange) && this.linkHovered(cell, x, y);
    if (!underline && !strike && !link) return;
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;
    const underlineY = cellY + this.metrics.baseline + 2;
    if (underline) this.strokeLine(cellX, underlineY, cellWidth, color);
    if (strike) this.strokeLine(cellX, cellY + this.metrics.height / 2, cellWidth, color);
    if (link) this.strokeLine(cellX, underlineY, cellWidth, LINK_COLOR);
  }

  private strokeLine(x: number, y: number, width: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.stroke();
  }

  private renderCursor(x: number, y: number, focused: boolean): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;
    this.setFill(this.theme.cursor);
    if (!focused) {
      this.ctx.strokeStyle = this.theme.cursor;
      this.ctx.lineWidth = 1;
      this.ctx.strokeRect(
        cursorX + 0.5,
        cursorY + 0.5,
        this.metrics.width - 1,
        this.metrics.height - 1
      );
    } else if (this.cursorStyle === 'block') {
      this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
      const line = this.bufferLine(y);
      if (line?.[x]) {
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        this.ctx.clip();
        this.renderCellText(line[x], x, y, this.theme.cursorAccent);
        this.ctx.restore();
        this.resetContextCache();
      }
    } else if (this.cursorStyle === 'underline') {
      const height = Math.max(2, Math.floor(this.metrics.height * 0.15));
      this.ctx.fillRect(
        cursorX,
        cursorY + this.metrics.height - height,
        this.metrics.width,
        height
      );
    } else {
      const width = Math.max(2, Math.floor(this.metrics.width * 0.15));
      this.ctx.fillRect(cursorX, cursorY, width, this.metrics.height);
    }
  }

  private renderScrollbar(overlay: FrameOverlay): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;
    const scrollbarX = canvasWidth - 8 - 4;
    ctx.clearRect(scrollbarX - 2, 0, 8 + 6, canvasHeight);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(scrollbarX - 2, 0, 8 + 6, canvasHeight);
    this.resetContextCache();
    const thumb = this.scrollbarThumb(overlay);
    if (!thumb) return;
    const opacity = overlay.scrollbarOpacity;
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(scrollbarX, thumb.trackY, thumb.width, thumb.trackHeight);
    const baseOpacity = overlay.viewportY > 0 ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumb.thumbY, thumb.width, thumb.thumbHeight);
    this.resetContextCache();
  }
}
