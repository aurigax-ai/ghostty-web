import { describe, expect, test } from 'vitest';
import { drawBoxGlyph, isBoxGlyph } from './box-glyphs';

const W = 9;
const H = 18;

/** Draws a glyph into a W × H coverage grid using only the fillRect calls it makes. */
function coverage(codepoint: number): { drawn: boolean; grid: boolean[][] } {
  const grid = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));
  const ctx = {
    fillStyle: '#fff',
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      for (let row = Math.max(0, y); row < Math.min(H, y + h); row++) {
        for (let col = Math.max(0, x); col < Math.min(W, x + w); col++) grid[row][col] = true;
      }
    },
  } as unknown as CanvasRenderingContext2D;
  const drawn = drawBoxGlyph(ctx, codepoint, 0, 0, W, H);
  return { drawn, grid };
}

const column = (grid: boolean[][], col: number) => grid.map((row) => row[col]);
const count = (cells: boolean[]) => cells.filter(Boolean).length;

describe('drawBoxGlyph', () => {
  test('a full block fills every pixel of the cell', () => {
    const { drawn, grid } = coverage(0x2588);
    expect(drawn).toBe(true);
    expect(grid.every((row) => row.every(Boolean))).toBe(true);
  });

  test('an upper half block fills exactly the top half', () => {
    const { grid } = coverage(0x2580);
    expect(count(column(grid, 0))).toBe(H / 2);
    expect(grid[0].every(Boolean)).toBe(true);
    expect(grid[H - 1].some(Boolean)).toBe(false);
  });

  test('a horizontal line reaches both edges of the cell without a gap', () => {
    const { grid } = coverage(0x2500);
    const rows = grid.filter((row) => row.some(Boolean));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.every(Boolean)).toBe(true);
  });

  test('a vertical line reaches the top and bottom edges without a gap', () => {
    const { grid } = coverage(0x2502);
    const cols = grid[0].map((_, col) => col).filter((col) => grid[0][col]);
    expect(cols.length).toBeGreaterThan(0);
    for (const col of cols) expect(column(grid, col).every(Boolean)).toBe(true);
  });

  test('a corner joins its two arms at the center', () => {
    const { grid } = coverage(0x250c);
    const lineRow = grid.findIndex((row) => row[W - 1]);
    const lineCol = grid[H - 1].findIndex(Boolean);
    expect(lineRow).toBeGreaterThan(0);
    expect(lineCol).toBeGreaterThan(0);
    expect(grid[lineRow].slice(lineCol).every(Boolean)).toBe(true);
    expect(column(grid, lineCol).slice(lineRow).every(Boolean)).toBe(true);
    expect(grid[0].some(Boolean)).toBe(false);
    expect(column(grid, 0).some(Boolean)).toBe(false);
  });

  test('a heavy line is thicker than a light one', () => {
    const light = count(column(coverage(0x2500).grid, 0));
    const heavy = count(column(coverage(0x2501).grid, 0));
    expect(heavy).toBeGreaterThan(light);
  });

  test('leaves characters it does not cover to the font', () => {
    expect(isBoxGlyph(0x2504)).toBe(false);
    expect(isBoxGlyph(0x41)).toBe(false);
    expect(coverage(0x2504).drawn).toBe(false);
    expect(coverage(0x41).drawn).toBe(false);
  });
});
