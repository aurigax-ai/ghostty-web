/**
 * Box drawing (U+2500–U+257F) and block elements (U+2580–U+259F) drawn from
 * geometry instead of the font, so lines join and blocks fill their cell with
 * no gaps between rows or columns, whatever the font and line height.
 * Characters not covered here (dashes, most doubles, diagonals) fall back to
 * the font.
 */

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const NONE = 0;
const HEAVY = 2;
const DOUBLE = 3;

/**
 * Arm weights per character as four digits: up, right, down, left.
 * 0 none, 1 light, 2 heavy, 3 double.
 */
const LINES = new Map<number, string>([
  [0x2500, '0101'],
  [0x2501, '0202'],
  [0x2502, '1010'],
  [0x2503, '2020'],
  [0x250c, '0110'],
  [0x250d, '0210'],
  [0x250e, '0120'],
  [0x250f, '0220'],
  [0x2510, '0011'],
  [0x2511, '0012'],
  [0x2512, '0021'],
  [0x2513, '0022'],
  [0x2514, '1100'],
  [0x2515, '1200'],
  [0x2516, '2100'],
  [0x2517, '2200'],
  [0x2518, '1001'],
  [0x2519, '1002'],
  [0x251a, '2001'],
  [0x251b, '2002'],
  [0x251c, '1110'],
  [0x251d, '1210'],
  [0x251e, '2110'],
  [0x251f, '1120'],
  [0x2520, '2120'],
  [0x2521, '2210'],
  [0x2522, '1220'],
  [0x2523, '2220'],
  [0x2524, '1011'],
  [0x2525, '1012'],
  [0x2526, '2011'],
  [0x2527, '1021'],
  [0x2528, '2021'],
  [0x2529, '2012'],
  [0x252a, '1022'],
  [0x252b, '2022'],
  [0x252c, '0111'],
  [0x252d, '0112'],
  [0x252e, '0211'],
  [0x252f, '0212'],
  [0x2530, '0121'],
  [0x2531, '0122'],
  [0x2532, '0221'],
  [0x2533, '0222'],
  [0x2534, '1101'],
  [0x2535, '1102'],
  [0x2536, '1201'],
  [0x2537, '1202'],
  [0x2538, '2101'],
  [0x2539, '2102'],
  [0x253a, '2201'],
  [0x253b, '2202'],
  [0x253c, '1111'],
  [0x253d, '1112'],
  [0x253e, '1211'],
  [0x253f, '1212'],
  [0x2540, '2111'],
  [0x2541, '1121'],
  [0x2542, '2121'],
  [0x2543, '2112'],
  [0x2544, '2211'],
  [0x2545, '1122'],
  [0x2546, '1221'],
  [0x2547, '2212'],
  [0x2548, '1222'],
  [0x2549, '2122'],
  [0x254a, '2221'],
  [0x254b, '2222'],
  [0x2550, '0303'],
  [0x2551, '3030'],
  [0x2574, '0001'],
  [0x2575, '1000'],
  [0x2576, '0100'],
  [0x2577, '0010'],
  [0x2578, '0002'],
  [0x2579, '2000'],
  [0x257a, '0200'],
  [0x257b, '0020'],
  [0x257c, '0201'],
  [0x257d, '1020'],
  [0x257e, '0102'],
  [0x257f, '2010'],
]);

const ARCS = new Map<number, [number, number]>([
  [0x256d, [1, 1]],
  [0x256e, [-1, 1]],
  [0x256f, [-1, -1]],
  [0x2570, [1, -1]],
]);

/** Whether `codepoint` is drawn by `drawBoxGlyph` rather than the font. */
export function isBoxGlyph(codepoint: number): boolean {
  if (codepoint >= 0x2580 && codepoint <= 0x259f) return true;
  return LINES.has(codepoint) || ARCS.has(codepoint);
}

/**
 * Draws `codepoint` into the cell at (x, y) of size w × h with the context's
 * current fill style. Returns false when the character is not covered.
 */
export function drawBoxGlyph(
  ctx: Ctx2D,
  codepoint: number,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  if (codepoint >= 0x2580 && codepoint <= 0x259f) {
    drawBlock(ctx, codepoint, x, y, w, h);
    return true;
  }
  const light = Math.max(1, Math.round(Math.min(w, h) / 9));
  const arms = LINES.get(codepoint);
  if (arms !== undefined) {
    drawLines(ctx, arms, x, y, w, h, light);
    return true;
  }
  const arc = ARCS.get(codepoint);
  if (arc !== undefined) {
    drawArc(ctx, arc, x, y, w, h, light);
    return true;
  }
  return false;
}

function drawLines(
  ctx: Ctx2D,
  arms: string,
  x: number,
  y: number,
  w: number,
  h: number,
  light: number
): void {
  const up = arms.charCodeAt(0) - 48;
  const right = arms.charCodeAt(1) - 48;
  const down = arms.charCodeAt(2) - 48;
  const left = arms.charCodeAt(3) - 48;
  const heavy = light * 2;
  const thick = (weight: number) => (weight === HEAVY ? heavy : light);
  const vertical = Math.max(up === NONE ? 0 : thick(up), down === NONE ? 0 : thick(down));
  const horizontal = Math.max(left === NONE ? 0 : thick(left), right === NONE ? 0 : thick(right));
  const cx = x + Math.floor((w - light) / 2);
  const cy = y + Math.floor((h - light) / 2);
  const centerX = (t: number) => cx - Math.floor((t - light) / 2);
  const centerY = (t: number) => cy - Math.floor((t - light) / 2);

  const armV = (weight: number, fromY: number, toY: number) => {
    if (weight === NONE || toY <= fromY) return;
    if (weight === DOUBLE) {
      ctx.fillRect(cx - light, fromY, light, toY - fromY);
      ctx.fillRect(cx + light, fromY, light, toY - fromY);
      return;
    }
    const t = thick(weight);
    ctx.fillRect(centerX(t), fromY, t, toY - fromY);
  };
  const armH = (weight: number, fromX: number, toX: number) => {
    if (weight === NONE || toX <= fromX) return;
    if (weight === DOUBLE) {
      ctx.fillRect(fromX, cy - light, toX - fromX, light);
      ctx.fillRect(fromX, cy + light, toX - fromX, light);
      return;
    }
    const t = thick(weight);
    ctx.fillRect(fromX, centerY(t), toX - fromX, t);
  };

  const joinTop = horizontal > 0 ? centerY(horizontal) : cy;
  const joinBottom = horizontal > 0 ? centerY(horizontal) + horizontal : cy;
  const joinLeft = vertical > 0 ? centerX(vertical) : cx;
  const joinRight = vertical > 0 ? centerX(vertical) + vertical : cx;
  armV(up, y, up === DOUBLE ? cy + light : joinBottom);
  armV(down, down === DOUBLE ? cy : joinTop, y + h);
  armH(left, x, left === DOUBLE ? cx + light : joinRight);
  armH(right, right === DOUBLE ? cx : joinLeft, x + w);
}

function drawArc(
  ctx: Ctx2D,
  [dx, dy]: [number, number],
  x: number,
  y: number,
  w: number,
  h: number,
  light: number
): void {
  const cx = x + Math.floor((w - light) / 2) + light / 2;
  const cy = y + Math.floor((h - light) / 2) + light / 2;
  const r = Math.min(w, h) / 2;
  const edgeX = dx > 0 ? x + w : x;
  const edgeY = dy > 0 ? y + h : y;
  const style = ctx.fillStyle;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = style;
  ctx.lineWidth = light;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(cx, edgeY);
  ctx.lineTo(cx, cy + dy * r);
  ctx.arcTo(cx, cy, cx + dx * r, cy, r);
  ctx.lineTo(edgeX, cy);
  ctx.stroke();
  ctx.restore();
}

function drawBlock(ctx: Ctx2D, cp: number, x: number, y: number, w: number, h: number): void {
  const rect = (fx0: number, fy0: number, fx1: number, fy1: number) => {
    const x0 = x + Math.round(w * fx0);
    const x1 = x + Math.round(w * fx1);
    const y0 = y + Math.round(h * fy0);
    const y1 = y + Math.round(h * fy1);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  };
  if (cp === 0x2580) {
    rect(0, 0, 1, 0.5);
    return;
  }
  if (cp >= 0x2581 && cp <= 0x2588) {
    rect(0, 1 - (cp - 0x2580) / 8, 1, 1);
    return;
  }
  if (cp >= 0x2589 && cp <= 0x258f) {
    rect(0, 0, (0x2590 - cp) / 8, 1);
    return;
  }
  if (cp === 0x2590) {
    rect(0.5, 0, 1, 1);
    return;
  }
  if (cp >= 0x2591 && cp <= 0x2593) {
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * ((cp - 0x2590) / 4);
    rect(0, 0, 1, 1);
    ctx.globalAlpha = alpha;
    return;
  }
  if (cp === 0x2594) {
    rect(0, 0, 1, 1 / 8);
    return;
  }
  if (cp === 0x2595) {
    rect(7 / 8, 0, 1, 1);
    return;
  }
  const quadrants = QUADRANTS[cp - 0x2596];
  if (quadrants & 1) rect(0, 0, 0.5, 0.5);
  if (quadrants & 2) rect(0.5, 0, 1, 0.5);
  if (quadrants & 4) rect(0, 0.5, 0.5, 1);
  if (quadrants & 8) rect(0.5, 0.5, 1, 1);
}

/** U+2596–U+259F as bits: 1 upper left, 2 upper right, 4 lower left, 8 lower right. */
const QUADRANTS = [4, 8, 1, 1 | 4 | 8, 1 | 8, 1 | 2 | 4, 1 | 2 | 8, 2, 2 | 4, 2 | 4 | 8];
