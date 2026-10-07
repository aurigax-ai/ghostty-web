import { describe, expect, test } from 'vitest';
import {
  GLYPH_WORDS,
  RECT_WORDS,
  compactGlyphs,
  compactRects,
  instanceArrays,
} from './webgl-instances';

function rect(slots: ReturnType<typeof instanceArrays>, i: number, r: number[], color: number) {
  slots.words.set(r, i * RECT_WORDS);
  slots.bits[i * RECT_WORDS + 4] = color;
}

function rectsOf(out: ReturnType<typeof instanceArrays>, n: number) {
  return Array.from({ length: n }, (_, i) => [
    ...out.words.slice(i * RECT_WORDS, i * RECT_WORDS + 4),
    out.bits[i * RECT_WORDS + 4],
  ]);
}

describe('compactRects', () => {
  test('skips empty slots', () => {
    const slots = instanceArrays(4, RECT_WORDS);
    rect(slots, 2, [20, 0, 10, 16], 0xff0000ff);
    const out = instanceArrays(4, RECT_WORDS);
    expect(compactRects(slots, 0, 4, out)).toBe(1);
    expect(rectsOf(out, 1)).toEqual([[20, 0, 10, 16, 0xff0000ff]]);
  });

  test('merges touching rects of one color on one row', () => {
    const slots = instanceArrays(4, RECT_WORDS);
    rect(slots, 0, [0, 0, 10, 16], 7);
    rect(slots, 1, [10, 0, 10, 16], 7);
    rect(slots, 2, [20, 0, 10, 16], 7);
    const out = instanceArrays(4, RECT_WORDS);
    expect(compactRects(slots, 0, 4, out)).toBe(1);
    expect(rectsOf(out, 1)).toEqual([[0, 0, 30, 16, 7]]);
  });

  test('keeps rects apart across a color change, a gap or a new row', () => {
    const slots = instanceArrays(5, RECT_WORDS);
    rect(slots, 0, [0, 0, 10, 16], 7);
    rect(slots, 1, [10, 0, 10, 16], 8);
    rect(slots, 3, [30, 0, 10, 16], 8);
    rect(slots, 4, [40, 16, 10, 16], 8);
    const out = instanceArrays(5, RECT_WORDS);
    expect(compactRects(slots, 0, 5, out)).toBe(4);
    expect(rectsOf(out, 4)).toEqual([
      [0, 0, 10, 16, 7],
      [10, 0, 10, 16, 8],
      [30, 0, 10, 16, 8],
      [40, 16, 10, 16, 8],
    ]);
  });

  test('reads only the slots from first on', () => {
    const slots = instanceArrays(4, RECT_WORDS);
    rect(slots, 0, [0, 0, 10, 16], 7);
    rect(slots, 3, [0, 2, 10, 1], 9);
    const out = instanceArrays(2, RECT_WORDS);
    expect(compactRects(slots, 2, 2, out)).toBe(1);
    expect(rectsOf(out, 1)).toEqual([[0, 2, 10, 1, 9]]);
  });
});

describe('compactGlyphs', () => {
  test('keeps only glyphs with a width, in order and bit for bit', () => {
    const slots = instanceArrays(3, GLYPH_WORDS);
    slots.words.set([1, 2, 3, 4, 5, 6, 0, 1], 0);
    slots.bits[6] = 0xdeadbeef;
    slots.words.set([9, 9, 9, 9, 0, 9, 0, 0], GLYPH_WORDS);
    slots.words.set([7, 8, 3, 4, 5, 6, 0, 0], GLYPH_WORDS * 2);
    const out = instanceArrays(3, GLYPH_WORDS);
    expect(compactGlyphs(slots, 3, out)).toBe(2);
    expect(Array.from(out.words.slice(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.bits[6]).toBe(0xdeadbeef);
    expect(Array.from(out.words.slice(GLYPH_WORDS, GLYPH_WORDS + 6))).toEqual([7, 8, 3, 4, 5, 6]);
  });
});
