/**
 * Packs the renderer's per-cell instance slots into dense arrays so a frame
 * draws only the instances that show something. Slots with a zero width are
 * empty. Rects that continue the previous one on the same row with the same
 * color are merged into it.
 */

export const RECT_WORDS = 5;
export const GLYPH_WORDS = 8;

export interface InstanceArrays {
  words: Float32Array;
  bits: Uint32Array;
}

export function instanceArrays(instances: number, wordsPer: number): InstanceArrays {
  const buffer = new ArrayBuffer(instances * wordsPer * 4);
  return { words: new Float32Array(buffer), bits: new Uint32Array(buffer) };
}

export function compactRects(
  src: InstanceArrays,
  first: number,
  count: number,
  out: InstanceArrays
): number {
  const { words, bits } = src;
  const outWords = out.words;
  const outBits = out.bits;
  let n = 0;
  let last = -1;
  for (let i = first; i < first + count; i++) {
    const at = i * RECT_WORDS;
    const width = words[at + 2];
    if (width === 0) continue;
    if (
      last >= 0 &&
      bits[at + 4] === outBits[last + 4] &&
      words[at + 1] === outWords[last + 1] &&
      words[at + 3] === outWords[last + 3] &&
      outWords[last] + outWords[last + 2] === words[at]
    ) {
      outWords[last + 2] += width;
      continue;
    }
    last = n * RECT_WORDS;
    outBits[last] = bits[at];
    outBits[last + 1] = bits[at + 1];
    outBits[last + 2] = bits[at + 2];
    outBits[last + 3] = bits[at + 3];
    outBits[last + 4] = bits[at + 4];
    n++;
  }
  return n;
}

export function compactGlyphs(src: InstanceArrays, count: number, out: InstanceArrays): number {
  const { words, bits } = src;
  const outBits = out.bits;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const at = i * GLYPH_WORDS;
    if (words[at + 4] === 0) continue;
    const to = n * GLYPH_WORDS;
    for (let w = 0; w < GLYPH_WORDS; w++) outBits[to + w] = bits[at + w];
    n++;
  }
  return n;
}
