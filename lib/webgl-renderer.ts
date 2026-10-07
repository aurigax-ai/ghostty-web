/**
 * WebGL 2 renderer.
 *
 * Glyphs are rasterized once into an atlas texture (box drawing and block
 * elements from geometry, so they fill their cells); each frame only the rows
 * that changed are rewritten into instance buffers, and the whole grid is
 * drawn with a handful of instanced draw calls. Drawing goes to a canvas of
 * its own laid over the terminal's canvas, which keeps taking pointer events,
 * so a terminal can drop back to `CanvasRenderer` on the same canvas when the
 * context is lost.
 */

import { drawBoxGlyph, isBoxGlyph } from './box-glyphs';
import { glyphInk } from './glyph-ink';
import type { ITheme } from './interfaces';
import {
  type FrameOverlay,
  LINK_COLOR,
  type RendererOptions,
  TerminalRenderer,
  isBlank,
} from './renderer';
import type { GhosttyCell } from './types';
import { CellFlags } from './types';
import {
  GLYPH_WORDS,
  type InstanceArrays,
  RECT_WORDS,
  compactGlyphs,
  compactRects,
  instanceArrays,
} from './webgl-instances';

const CURSOR_RECTS = 4;
const SCROLLBAR_RECTS = 2;
const OVERLAY_RECTS = CURSOR_RECTS + SCROLLBAR_RECTS;
const ATLAS_START = 512;
const ATLAS_MAX = 4096;

const VERTEX_RECT = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_color;
uniform vec2 u_resolution;
out vec4 v_color;
void main() {
  vec2 p = a_rect.xy + a_corner * a_rect.zw;
  vec2 clip = p / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = vec4(a_color.rgb * a_color.a, a_color.a);
}`;

const FRAGMENT_RECT = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}`;

const VERTEX_GLYPH = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_pos;
layout(location = 2) in vec4 a_tex;
layout(location = 3) in vec4 a_color;
layout(location = 4) in float a_colored;
uniform vec2 u_resolution;
uniform vec2 u_atlas;
out vec2 v_uv;
out vec4 v_color;
out float v_colored;
void main() {
  vec2 p = a_pos + a_corner * a_tex.zw;
  vec2 clip = p / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = (a_tex.xy + a_corner * a_tex.zw) / u_atlas;
  v_color = a_color;
  v_colored = a_colored;
}`;

const FRAGMENT_GLYPH = `#version 300 es
precision mediump float;
uniform sampler2D u_texture;
in vec2 v_uv;
in vec4 v_color;
in float v_colored;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_texture, v_uv);
  if (v_colored > 0.5) {
    outColor = texel * v_color.a;
  } else {
    outColor = vec4(v_color.rgb, 1.0) * texel.a * v_color.a;
  }
}`;

/** A glyph's ink in the atlas; `ox`, `oy` place it within the glyph's padded slot. */
interface AtlasEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
  colored: boolean;
}

/** Packs RGBA bytes into one little-endian word, as the GPU reads UNSIGNED_BYTE × 4. */
function pack(r: number, g: number, b: number, a: number): number {
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}

/**
 * Glyph atlas: a texture packed in shelves of one slot height. Each glyph is
 * rasterized in a scratch canvas the size of one slot and uploaded; the
 * texture grows by copying itself on the GPU, so entries stay valid and no
 * CPU copy of the atlas is kept.
 */
class GlyphAtlas {
  size = ATLAS_START;
  private readonly scratch: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private entries = new Map<number | string, AtlasEntry | null>();
  private shelfX = 0;
  private shelfY = 0;
  texture: WebGLTexture;
  /** Set when the atlas had to be cleared: every entry handed out before is gone. */
  cleared = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private slotHeight: number
  ) {
    this.scratch = document.createElement('canvas');
    this.ctx = this.scratchContext(1, slotHeight);
    this.texture = this.newTexture(this.size);
  }

  private scratchContext(w: number, h: number): CanvasRenderingContext2D {
    if (this.scratch.width < w) this.scratch.width = w;
    if (this.scratch.height !== h) this.scratch.height = h;
    const ctx = this.scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to get the glyph scratch context');
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    return ctx;
  }

  private newTexture(size: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return texture;
  }

  /** Drops every glyph, for a new font or cell size. */
  reset(slotHeight: number): void {
    this.slotHeight = slotHeight;
    this.entries.clear();
    this.shelfX = 0;
    this.shelfY = 0;
    this.gl.deleteTexture(this.texture);
    this.size = ATLAS_START;
    this.texture = this.newTexture(this.size);
  }

  lookup(key: number | string): AtlasEntry | null | undefined {
    return this.entries.get(key);
  }

  /** Rasterizes a glyph with `draw` (at 0, 0 of a w px wide slot) and uploads it. */
  add(
    key: number | string,
    w: number,
    draw: (ctx: CanvasRenderingContext2D, x: number, y: number) => void
  ): AtlasEntry | null {
    const h = this.slotHeight;
    if (this.scratch.width < w || this.scratch.height !== h) this.ctx = this.scratchContext(w, h);
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.clearRect(0, 0, w, h);
    draw(ctx, 0, 0);
    ctx.restore();
    const pixels = ctx.getImageData(0, 0, w, h);
    const ink = glyphInk(pixels.data, w, h);
    if (!ink) {
      this.entries.set(key, null);
      return null;
    }
    if (this.shelfX + w > this.size) {
      this.shelfX = 0;
      this.shelfY += h;
    }
    if (this.shelfY + h > this.size && !this.grow()) {
      this.reset(h);
      this.cleared = true;
    }
    const x = this.shelfX;
    const y = this.shelfY;
    this.shelfX += w;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const entry = {
      x: x + ink.left,
      y: y + ink.top,
      w: ink.width,
      h: ink.height,
      ox: ink.left,
      oy: ink.top,
      colored: ink.colored,
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** Doubles the texture, copying the old one into its top-left corner on the GPU. */
  private grow(): boolean {
    const gl = this.gl;
    const limit = Math.min(ATLAS_MAX, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    if (this.size * 2 > limit) return false;
    const old = this.texture;
    const oldSize = this.size;
    this.size *= 2;
    this.texture = this.newTexture(this.size);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, old, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, oldSize, oldSize);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(old);
    this.shelfX = 0;
    this.shelfY = oldSize;
    return true;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.entries.clear();
  }
}

export class WebglRenderer extends TerminalRenderer {
  protected readonly cursorInRows = false;
  private readonly glCanvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly rectProgram: WebGLProgram;
  private readonly glyphProgram: WebGLProgram;
  private readonly quad: WebGLBuffer;
  private readonly rectBuffer: WebGLBuffer;
  private readonly glyphBuffer: WebGLBuffer;
  private readonly overlayRectBuffer: WebGLBuffer;
  private readonly overlayGlyphBuffer: WebGLBuffer;
  private readonly decoBuffer: WebGLBuffer;
  private bgVao!: WebGLVertexArrayObject;
  private decoVao!: WebGLVertexArrayObject;
  private glyphVao!: WebGLVertexArrayObject;
  private overlayRectVao!: WebGLVertexArrayObject;
  private overlayGlyphVao!: WebGLVertexArrayObject;
  private scrollbarVao!: WebGLVertexArrayObject;
  private readonly rectResolution: WebGLUniformLocation | null;
  private readonly glyphResolution: WebGLUniformLocation | null;
  private readonly glyphAtlasSize: WebGLUniformLocation | null;
  private readonly glyphTexture: WebGLUniformLocation | null;
  private readonly atlas: GlyphAtlas;

  private cols = 0;
  private rows = 0;
  private rectWords = new Float32Array(0);
  private rectColors = new Uint32Array(0);
  private glyphWords = new Float32Array(0);
  private glyphColors = new Uint32Array(0);
  private packedBg = instanceArrays(0, RECT_WORDS);
  private packedDeco = instanceArrays(0, RECT_WORDS);
  private packedGlyphs = instanceArrays(0, GLYPH_WORDS);
  private bgCount = 0;
  private decoCount = 0;
  private glyphCount = 0;
  private readonly overlayRects = new Float32Array(OVERLAY_RECTS * RECT_WORDS);
  private readonly overlayRectColors = new Uint32Array(this.overlayRects.buffer);
  private readonly overlayGlyph = new Float32Array(GLYPH_WORDS);
  private readonly overlayGlyphColors = new Uint32Array(this.overlayGlyph.buffer);
  private dirtyFrom = Number.POSITIVE_INFINITY;
  private dirtyTo = -1;
  private needsPresent = true;
  private lastOverlay = '';
  private lost = false;

  private cellW = 0;
  private cellH = 0;
  private padX = 0;
  private padY = 0;
  private readonly parsedColors = new Map<string, number>();
  private readonly colorProbe: CanvasRenderingContext2D;
  private themeWords!: {
    background: number;
    foreground: number;
    cursor: number;
    cursorAccent: number;
    selectionBackground: number;
    selectionForeground: number;
    link: number;
    match: number;
    activeMatch: number;
  };

  /** Called once if the WebGL context is lost; the terminal then switches renderer. */
  public onContextLost?: () => void;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    super(canvas, options);
    const glCanvas = document.createElement('canvas');
    glCanvas.style.position = 'absolute';
    glCanvas.style.pointerEvents = 'none';
    glCanvas.style.display = 'block';
    glCanvas.setAttribute('aria-hidden', 'true');
    const gl = glCanvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL 2 is not available');
    this.glCanvas = glCanvas;
    this.gl = gl;
    glCanvas.addEventListener('webglcontextlost', this.handleContextLost);

    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    this.colorProbe = probe.getContext('2d', { willReadFrequently: true })!;

    this.rectProgram = linkProgram(gl, VERTEX_RECT, FRAGMENT_RECT);
    this.glyphProgram = linkProgram(gl, VERTEX_GLYPH, FRAGMENT_GLYPH);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW
    );
    this.rectBuffer = gl.createBuffer()!;
    this.glyphBuffer = gl.createBuffer()!;
    this.decoBuffer = gl.createBuffer()!;
    this.overlayRectBuffer = gl.createBuffer()!;
    this.overlayGlyphBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayRectBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.overlayRects.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayGlyphBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.overlayGlyph.byteLength, gl.DYNAMIC_DRAW);
    this.overlayRectVao = this.rectVao(this.overlayRectBuffer, 0);
    this.overlayGlyphVao = this.glyphVaoFor(this.overlayGlyphBuffer);
    this.scrollbarVao = this.rectVao(this.overlayRectBuffer, CURSOR_RECTS * RECT_WORDS * 4);
    this.rectResolution = gl.getUniformLocation(this.rectProgram, 'u_resolution');
    this.glyphResolution = gl.getUniformLocation(this.glyphProgram, 'u_resolution');
    this.glyphAtlasSize = gl.getUniformLocation(this.glyphProgram, 'u_atlas');
    this.glyphTexture = gl.getUniformLocation(this.glyphProgram, 'u_texture');

    this.measureCellPixels();
    this.atlas = new GlyphAtlas(gl, this.slotHeight());
    this.parseTheme();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.lost) return;
    this.lost = true;
    this.onContextLost?.();
  };

  /** Whether the context was lost; such a renderer never draws again. */
  get contextLost(): boolean {
    return this.lost;
  }

  // ==========================================================================
  // Geometry
  // ==========================================================================

  private measureCellPixels(): void {
    const dpr = this.devicePixelRatio;
    this.cellW = this.metrics.width * dpr;
    this.cellH = this.metrics.height * dpr;
    this.padX = Math.ceil(this.cellW / 2);
    this.padY = Math.ceil(this.cellH / 4);
  }

  private slotHeight(): number {
    return Math.ceil(this.cellH) + 2 * this.padY;
  }

  protected surfaceMismatch(cols: number, rows: number): boolean {
    return (
      cols !== this.cols ||
      rows !== this.rows ||
      this.glCanvas.width !== Math.round(cols * this.cellW) ||
      this.glCanvas.height !== Math.round(rows * this.cellH)
    );
  }

  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = cssWidth;
    this.canvas.height = cssHeight;
    if (!this.glCanvas.isConnected) this.canvas.after(this.glCanvas);
    this.glCanvas.style.left = `${this.canvas.offsetLeft}px`;
    this.glCanvas.style.top = `${this.canvas.offsetTop}px`;
    this.glCanvas.style.width = `${cssWidth}px`;
    this.glCanvas.style.height = `${cssHeight}px`;
    this.glCanvas.width = Math.round(cols * this.cellW);
    this.glCanvas.height = Math.round(rows * this.cellH);

    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      const cells = cols * rows;
      const rects = new ArrayBuffer(cells * 3 * RECT_WORDS * 4);
      this.rectWords = new Float32Array(rects);
      this.rectColors = new Uint32Array(rects);
      const glyphs = new ArrayBuffer(cells * GLYPH_WORDS * 4);
      this.glyphWords = new Float32Array(glyphs);
      this.glyphColors = new Uint32Array(glyphs);
      this.packedBg = instanceArrays(cells, RECT_WORDS);
      this.packedDeco = instanceArrays(cells * 2, RECT_WORDS);
      this.packedGlyphs = instanceArrays(cells, GLYPH_WORDS);
      const gl = this.gl;
      const allocate = (buffer: WebGLBuffer, packed: InstanceArrays) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, packed.bits.byteLength, gl.DYNAMIC_DRAW);
      };
      allocate(this.rectBuffer, this.packedBg);
      allocate(this.decoBuffer, this.packedDeco);
      allocate(this.glyphBuffer, this.packedGlyphs);
      for (const vao of [this.bgVao, this.decoVao, this.glyphVao]) {
        if (vao) gl.deleteVertexArray(vao);
      }
      this.bgVao = this.rectVao(this.rectBuffer, 0);
      this.decoVao = this.rectVao(this.decoBuffer, 0);
      this.glyphVao = this.glyphVaoFor(this.glyphBuffer);
    }
    this.markAllRows();
  }

  public clear(): void {
    this.rectWords.fill(0);
    this.glyphWords.fill(0);
    this.markAllRows();
  }

  protected fontChanged(): void {
    this.measureCellPixels();
    this.atlas.reset(this.slotHeight());
    this.markAllRows();
  }

  public setTheme(theme: ITheme): void {
    super.setTheme(theme);
    this.parseTheme();
    this.markAllRows();
  }

  protected searchColorsChanged(): void {
    this.parseTheme();
  }

  private markAllRows(): void {
    this.dirtyFrom = 0;
    this.dirtyTo = this.rows - 1;
    this.needsPresent = true;
  }

  // ==========================================================================
  // Colors
  // ==========================================================================

  private parseColor(css: string): number {
    let word = this.parsedColors.get(css);
    if (word !== undefined) return word;
    const ctx = this.colorProbe;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    word = pack(r, g, b, a);
    this.parsedColors.set(css, word);
    return word;
  }

  private parseTheme(): void {
    const t = this.theme;
    this.themeWords = {
      background: this.parseColor(t.background),
      foreground: this.parseColor(t.foreground),
      cursor: this.parseColor(t.cursor),
      cursorAccent: this.parseColor(t.cursorAccent),
      selectionBackground: this.parseColor(t.selectionBackground),
      selectionForeground: this.parseColor(t.selectionForeground),
      link: this.parseColor(LINK_COLOR),
      match: this.parseColor(this.highlightColors.match),
      activeMatch: this.parseColor(this.highlightColors.active),
    };
  }

  // ==========================================================================
  // Rows
  // ==========================================================================

  protected drawLine(line: GhosttyCell[], y: number, cols: number): void {
    if (y < 0 || y >= this.rows) return;
    const cells = this.cols * this.rows;
    const rects = this.rectWords;
    const rectColors = this.rectColors;
    const glyphs = this.glyphWords;
    const glyphColors = this.glyphColors;
    const cellW = this.cellW;
    const cellH = this.cellH;
    const top = Math.round(y * cellH);
    const bottom = Math.round((y + 1) * cellH);
    const dpr = this.devicePixelRatio;
    const underlineY = Math.round(y * cellH + (this.metrics.baseline + 2) * dpr);
    const strikeY = Math.round(y * cellH + cellH / 2);
    const thickness = Math.max(1, Math.round(dpr));
    const theme = this.themeWords;
    const width = Math.min(cols, this.cols);

    for (let x = 0; x < this.cols; x++) {
      const index = y * this.cols + x;
      const bg = index * RECT_WORDS;
      const deco1 = (cells + index) * RECT_WORDS;
      const deco2 = (cells * 2 + index) * RECT_WORDS;
      const glyph = index * GLYPH_WORDS;
      rects[bg + 2] = 0;
      rects[deco1 + 2] = 0;
      rects[deco2 + 2] = 0;
      glyphs[glyph + 4] = 0;
      const cell = x < width ? line[x] : undefined;
      if (!cell || cell.width === 0) continue;

      const left = Math.round(x * cellW);
      const right = Math.round((x + cell.width) * cellW);
      const selected = this.isInSelection(x, y);
      const inverse = cell.flags & CellFlags.INVERSE;

      let bgWord = 0;
      const highlight = selected ? 0 : this.highlightAt(x, y);
      if (selected) {
        bgWord = theme.selectionBackground;
      } else if (highlight) {
        bgWord = highlight === 2 ? theme.activeMatch : theme.match;
      } else {
        const r = inverse ? cell.fg_r : cell.bg_r;
        const g = inverse ? cell.fg_g : cell.bg_g;
        const b = inverse ? cell.fg_b : cell.bg_b;
        if (r !== 0 || g !== 0 || b !== 0) bgWord = pack(r, g, b, 255);
      }
      if (bgWord !== 0) {
        rects[bg] = left;
        rects[bg + 1] = top;
        rects[bg + 2] = right - left;
        rects[bg + 3] = bottom - top;
        rectColors[bg + 4] = bgWord;
      }

      let fgWord: number;
      if (selected) {
        fgWord = theme.selectionForeground;
      } else {
        const fg = inverse
          ? (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b
          : (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
        const back = inverse
          ? (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b
          : (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;
        const shown = this.contrastedForeground(fg, back === 0 ? null : back);
        fgWord = pack((shown >> 16) & 0xff, (shown >> 8) & 0xff, shown & 0xff, 255);
      }
      if (cell.flags & CellFlags.FAINT) fgWord = ((fgWord & 0x00ffffff) | (128 << 24)) >>> 0;
      if (cell.flags & CellFlags.INVISIBLE) continue;

      if (!isBlank(cell)) {
        const entry = this.glyphFor(cell, x, y);
        if (entry) {
          glyphs[glyph] = left - this.padX + entry.ox;
          glyphs[glyph + 1] = top - this.padY + entry.oy;
          glyphs[glyph + 2] = entry.x;
          glyphs[glyph + 3] = entry.y;
          glyphs[glyph + 4] = entry.w;
          glyphs[glyph + 5] = entry.h;
          glyphColors[glyph + 6] = fgWord;
          glyphs[glyph + 7] = entry.colored ? 1 : 0;
        }
      }

      const link = (cell.hyperlink_id > 0 || this.hoveredLinkRange) && this.linkHovered(cell, x, y);
      if (link || cell.flags & CellFlags.UNDERLINE) {
        rects[deco1] = left;
        rects[deco1 + 1] = underlineY;
        rects[deco1 + 2] = right - left;
        rects[deco1 + 3] = thickness;
        rectColors[deco1 + 4] = link ? theme.link : fgWord;
      }
      if (cell.flags & CellFlags.STRIKETHROUGH) {
        rects[deco2] = left;
        rects[deco2 + 1] = strikeY;
        rects[deco2 + 2] = right - left;
        rects[deco2 + 3] = thickness;
        rectColors[deco2 + 4] = fgWord;
      }
    }
    if (y < this.dirtyFrom) this.dirtyFrom = y;
    if (y > this.dirtyTo) this.dirtyTo = y;
    this.needsPresent = true;
  }

  private glyphFor(cell: GhosttyCell, x: number, y: number): ReturnType<GlyphAtlas['lookup']> {
    const style = cell.flags & (CellFlags.BOLD | CellFlags.ITALIC);
    const variant = (cell.flags & CellFlags.BOLD ? 1 : 0) | (cell.flags & CellFlags.ITALIC ? 2 : 0);
    const simple = cell.grapheme_len === 0;
    const key: number | string = simple
      ? cell.codepoint * 16 + variant * 4 + cell.width
      : `${this.cellText(cell, x, y)}\u0000${variant}\u0000${cell.width}`;
    const cached = this.atlas.lookup(key);
    if (cached !== undefined) return cached;
    const slotW = Math.ceil(this.cellW * cell.width) + 2 * this.padX;
    const glyphW = this.cellW * cell.width;
    const font = this.atlasFont(style);
    const text = simple ? String.fromCodePoint(cell.codepoint) : this.cellText(cell, x, y);
    const box = simple && isBoxGlyph(cell.codepoint);
    const baseline = this.metrics.baseline * this.devicePixelRatio;
    return this.atlas.add(key, slotW, (ctx, sx, sy) => {
      ctx.fillStyle = '#ffffff';
      if (box) {
        drawBoxGlyph(ctx, cell.codepoint, sx + this.padX, sy + this.padY, glyphW, this.cellH);
      } else {
        ctx.font = font;
        ctx.fillText(text, sx + this.padX, sy + this.padY + baseline);
      }
    });
  }

  private atlasFont(style: number): string {
    return this.fontString(style, this.fontSize * this.devicePixelRatio);
  }

  // ==========================================================================
  // Frame
  // ==========================================================================

  protected finishFrame(overlay: FrameOverlay): void {
    if (this.lost) return;
    if (this.atlas.cleared) {
      this.atlas.cleared = false;
      this.markAllRows();
      this.requestFullRedraw();
      this.onNeedsFrame?.();
      return;
    }
    const overlayKey = this.buildOverlay(overlay);
    if (!this.needsPresent && overlayKey === this.lastOverlay) return;
    this.lastOverlay = overlayKey;
    this.needsPresent = false;
    this.upload();
    this.present(overlayKey);
  }

  /** Fills the overlay buffers and returns a key that changes whenever they do. */
  private buildOverlay(overlay: FrameOverlay): string {
    const rects = this.overlayRects;
    const colors = this.overlayRectColors;
    rects.fill(0);
    this.overlayGlyph.fill(0);
    const theme = this.themeWords;
    let key = '';
    if (overlay.showCursor && overlay.cursorX >= 0 && overlay.cursorY >= 0) {
      const left = Math.round(overlay.cursorX * this.cellW);
      const top = Math.round(overlay.cursorY * this.cellH);
      const width = Math.round((overlay.cursorX + 1) * this.cellW) - left;
      const height = Math.round((overlay.cursorY + 1) * this.cellH) - top;
      rects[0] = left;
      rects[1] = top;
      rects[2] = width;
      rects[3] = height;
      if (!overlay.focused) {
        const t = Math.max(1, Math.round(this.devicePixelRatio));
        const edges = [
          [left, top, width, t],
          [left, top + height - t, width, t],
          [left, top, t, height],
          [left + width - t, top, t, height],
        ];
        edges.forEach((edge, i) => {
          rects.set(edge, i * RECT_WORDS);
          colors[i * RECT_WORDS + 4] = theme.cursor;
        });
      } else if (this.cursorStyle === 'underline') {
        const h = Math.max(2, Math.floor(height * 0.15));
        rects[1] = top + height - h;
        rects[3] = h;
      } else if (this.cursorStyle === 'bar') {
        rects[2] = Math.max(2, Math.floor(width * 0.15));
      }
      colors[4] = theme.cursor;
      key = `${left},${top},${this.cursorStyle},${overlay.focused}`;
      if (overlay.focused && this.cursorStyle === 'block') {
        const cell = this.currentBuffer?.getLine(overlay.cursorY)?.[overlay.cursorX];
        if (cell && !isBlank(cell) && !(cell.flags & CellFlags.INVISIBLE)) {
          const entry = this.glyphFor(cell, overlay.cursorX, overlay.cursorY);
          if (entry) {
            const g = this.overlayGlyph;
            g[0] = left - this.padX + entry.ox;
            g[1] = top - this.padY + entry.oy;
            g[2] = entry.x;
            g[3] = entry.y;
            g[4] = entry.w;
            g[5] = entry.h;
            this.overlayGlyphColors[6] = theme.cursorAccent;
            g[7] = entry.colored ? 1 : 0;
            key += `,${entry.x},${entry.y}`;
          }
        }
      }
    }
    const thumb = this.scrollbarThumb(overlay);
    if (thumb) {
      const dpr = this.devicePixelRatio;
      const opacity = overlay.scrollbarOpacity;
      const base = overlay.viewportY > 0 ? 0.5 : 0.3;
      const track = CURSOR_RECTS * RECT_WORDS;
      rects[track] = thumb.x * dpr;
      rects[track + 1] = thumb.trackY * dpr;
      rects[track + 2] = thumb.width * dpr;
      rects[track + 3] = thumb.trackHeight * dpr;
      colors[track + 4] = pack(128, 128, 128, Math.round(0.1 * opacity * 255));
      const bar = (CURSOR_RECTS + 1) * RECT_WORDS;
      rects[bar] = thumb.x * dpr;
      rects[bar + 1] = thumb.thumbY * dpr;
      rects[bar + 2] = thumb.width * dpr;
      rects[bar + 3] = thumb.thumbHeight * dpr;
      colors[bar + 4] = pack(128, 128, 128, Math.round(base * opacity * 255));
      key += `|${thumb.thumbY},${thumb.thumbHeight},${opacity},${base}`;
    }
    return key;
  }

  private upload(): void {
    if (this.dirtyTo < this.dirtyFrom) return;
    const gl = this.gl;
    const cells = this.cols * this.rows;
    const slots = { words: this.rectWords, bits: this.rectColors };
    this.bgCount = compactRects(slots, 0, cells, this.packedBg);
    this.decoCount = compactRects(slots, cells, cells * 2, this.packedDeco);
    this.glyphCount = compactGlyphs(
      { words: this.glyphWords, bits: this.glyphColors },
      cells,
      this.packedGlyphs
    );
    const send = (buffer: WebGLBuffer, packed: InstanceArrays, count: number, wordsPer: number) => {
      if (count === 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed.bits, 0, count * wordsPer);
    };
    send(this.rectBuffer, this.packedBg, this.bgCount, RECT_WORDS);
    send(this.decoBuffer, this.packedDeco, this.decoCount, RECT_WORDS);
    send(this.glyphBuffer, this.packedGlyphs, this.glyphCount, GLYPH_WORDS);
    this.dirtyFrom = Number.POSITIVE_INFINITY;
    this.dirtyTo = -1;
  }

  private present(overlayKey: string): void {
    const gl = this.gl;
    const width = this.glCanvas.width;
    const height = this.glCanvas.height;
    gl.viewport(0, 0, width, height);
    const bg = this.themeWords.background;
    const a = (bg >>> 24) / 255;
    gl.clearColor(
      ((bg & 0xff) / 255) * a,
      (((bg >>> 8) & 0xff) / 255) * a,
      (((bg >>> 16) & 0xff) / 255) * a,
      a
    );
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.rectProgram);
    gl.uniform2f(this.rectResolution, width, height);
    if (this.bgCount > 0) {
      gl.bindVertexArray(this.bgVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.bgCount);
    }

    gl.useProgram(this.glyphProgram);
    gl.uniform2f(this.glyphResolution, width, height);
    gl.uniform2f(this.glyphAtlasSize, this.atlas.size, this.atlas.size);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture);
    gl.uniform1i(this.glyphTexture, 0);
    if (this.glyphCount > 0) {
      gl.bindVertexArray(this.glyphVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.glyphCount);
    }

    gl.useProgram(this.rectProgram);
    if (this.decoCount > 0) {
      gl.bindVertexArray(this.decoVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.decoCount);
    }

    if (overlayKey) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayRectBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.overlayRects);
      gl.bindVertexArray(this.overlayRectVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, CURSOR_RECTS);
      if (this.overlayGlyph[4] > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayGlyphBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.overlayGlyph);
        gl.useProgram(this.glyphProgram);
        gl.bindVertexArray(this.overlayGlyphVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
        gl.useProgram(this.rectProgram);
      }
      gl.bindVertexArray(this.scrollbarVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, SCROLLBAR_RECTS);
    }
    gl.bindVertexArray(null);
  }

  // ==========================================================================
  // GL plumbing
  // ==========================================================================

  private rectVao(buffer: WebGLBuffer, byteOffset: number): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    this.bindQuad();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = RECT_WORDS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, byteOffset);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, stride, byteOffset + 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  private glyphVaoFor(buffer: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    this.bindQuad();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = GLYPH_WORDS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, stride, 24);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 28);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  private bindQuad(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  public dispose(): void {
    super.dispose();
    this.glCanvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.glCanvas.remove();
    if (!this.lost) {
      const gl = this.gl;
      this.atlas.dispose();
      for (const buffer of [
        this.quad,
        this.rectBuffer,
        this.decoBuffer,
        this.glyphBuffer,
        this.overlayRectBuffer,
        this.overlayGlyphBuffer,
      ]) {
        gl.deleteBuffer(buffer);
      }
      gl.deleteProgram(this.rectProgram);
      gl.deleteProgram(this.glyphProgram);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
}

function linkProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const program = gl.createProgram()!;
  const vs = compile(gl.VERTEX_SHADER, vertex);
  const fs = compile(gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Shader program failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}
