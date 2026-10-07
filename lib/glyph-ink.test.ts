import { describe, expect, test } from 'vitest';
import { glyphInk } from './glyph-ink';

function canvas(w: number, h: number, inked: [number, number, number[]][]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const [x, y, rgba] of inked) data.set(rgba, (y * w + x) * 4);
  return data;
}

describe('glyphInk', () => {
  test('is null for a slot with no ink', () => {
    expect(glyphInk(canvas(4, 3, []), 4, 3)).toBeNull();
  });

  test('bounds every pixel with any alpha', () => {
    const data = canvas(8, 6, [
      [2, 1, [255, 255, 255, 10]],
      [5, 4, [255, 255, 255, 255]],
    ]);
    expect(glyphInk(data, 8, 6)).toEqual({ left: 2, top: 1, width: 4, height: 4, colored: false });
  });

  test('marks a glyph with saturated pixels as colored', () => {
    const data = canvas(3, 3, [[1, 1, [250, 20, 20, 255]]]);
    expect(glyphInk(data, 3, 3)?.colored).toBe(true);
  });

  test('keeps grey antialiasing as plain', () => {
    const data = canvas(3, 3, [[0, 0, [120, 120, 130, 128]]]);
    expect(glyphInk(data, 3, 3)?.colored).toBe(false);
  });
});
