/**
 * Finds the pixels a rasterized glyph actually covers, so the renderer draws
 * a quad over the ink instead of over the whole padded atlas slot.
 */

const COLORED_SPREAD = 24;

export interface GlyphInk {
  left: number;
  top: number;
  width: number;
  height: number;
  colored: boolean;
}

/** Bounds of the non-transparent pixels in RGBA `data` (`w` × `h`), or null when none. */
export function glyphInk(data: Uint8ClampedArray, w: number, h: number): GlyphInk | null {
  let left = w;
  let right = -1;
  let top = h;
  let bottom = -1;
  let colored = false;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (data[i + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
      if (!colored) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        colored = Math.max(r, g, b) - Math.min(r, g, b) > COLORED_SPREAD;
      }
    }
  }
  if (right < 0) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1, colored };
}
