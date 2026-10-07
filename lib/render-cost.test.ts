import { afterEach, describe, expect, test, vi } from 'vitest';
import { Ghostty, type GhosttyTerminal } from './ghostty';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('frame cost', () => {
  let term: Terminal | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    term?.dispose();
    container?.remove();
    term = null;
    container = null;
  });

  async function open(cursorBlink = false): Promise<Terminal> {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 10, renderer: 'canvas', cursorBlink });
    term.open(container);
    return term;
  }

  /** Counts drawn rows and finished frames from now on. */
  function spyFrames(t: Terminal): { rows: number[]; frames: number } {
    const seen = { rows: [] as number[], frames: 0 };
    const renderer = t.renderer as any;
    const drawLine = renderer.drawLine.bind(renderer);
    renderer.drawLine = (line: unknown, y: number, cols: number) => {
      seen.rows.push(y);
      drawLine(line, y, cols);
    };
    const finishFrame = renderer.finishFrame.bind(renderer);
    renderer.finishFrame = (overlay: unknown) => {
      seen.frames++;
      finishFrame(overlay);
    };
    return seen;
  }

  test('a frame with nothing changed draws nothing', async () => {
    const t = await open();
    t.write('$ ls\r\nfile\r\n$ ');
    await wait(100);
    const seen = spyFrames(t);
    t.wake();
    await wait(200);
    expect(seen).toEqual({ rows: [], frames: 0 });
  });

  test('idle frames while scrolled back redraw nothing, cursor blinks included', async () => {
    const t = await open(true);
    t.focus();
    for (let i = 0; i < 50; i++) t.write(`line ${i}\r\n`);
    t.scrollToLine(10);
    // Until the scrollbar has faded out.
    await wait(2000);
    const seen = spyFrames(t);
    t.wake();
    // Longer than a blink.
    await wait(700);
    expect(seen).toEqual({ rows: [], frames: 0 });
  });

  test('scrolling back still redraws every row', async () => {
    const t = await open();
    for (let i = 0; i < 50; i++) t.write(`line ${i}\r\n`);
    await wait(100);
    const seen = spyFrames(t);
    t.scrollToLine(10);
    await wait(100);
    expect(new Set(seen.rows).size).toBe(10);
  });

  test('rows are drawn from the live cells, not copies', async () => {
    const t = await open();
    await wait(50);
    const engine = t.wasmTerm!;
    const getLine = vi.spyOn(engine, 'getLine');
    const lines: unknown[][] = [];
    const renderer = t.renderer as any;
    const drawLine = renderer.drawLine.bind(renderer);
    renderer.drawLine = (line: unknown[], y: number, cols: number) => {
      if (y === 0) lines.push(line);
      drawLine(line, y, cols);
    };
    t.write('hello');
    await wait(50);
    expect(getLine).not.toHaveBeenCalled();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0][0]).toBe(engine.getViewport()[0]);
  });
});

describe('engine cost', () => {
  let engine: GhosttyTerminal | null = null;

  afterEach(() => {
    engine?.free();
    engine = null;
  });

  async function create(): Promise<{ ghostty: Ghostty; engine: GhosttyTerminal }> {
    const ghostty = await Ghostty.load(`${process.cwd()}/ghostty-vt.wasm`);
    engine = ghostty.createTerminal(40, 10);
    engine.write('warm up');
    engine.update();
    engine.markClean();
    engine.rowsDiscarded();
    return { ghostty, engine };
  }

  test('writes and small reads allocate no WASM memory', async () => {
    const { ghostty, engine } = await create();
    const call = vi.spyOn(ghostty.abi, 'call');
    engine.write('text, ünïcödé and 🙂\r\n');
    engine.write(new Uint8Array([0x61, 0x62, 0x0d, 0x0a]));
    engine.cursorPosition();
    engine.isAlternateScreen();
    engine.getScrollbackLength();
    engine.update();
    engine.getCursor();
    engine.rowsDiscarded();
    const allocs = call.mock.calls.filter(([name]) => String(name).startsWith('ghostty_wasm_'));
    expect(allocs).toEqual([]);
    const text = engine
      .getLine(0)!
      .filter((c) => c.width > 0)
      .map((c) => String.fromCodePoint(c.codepoint || 32))
      .join('');
    expect(text.trimEnd()).toBe('warm uptext, ünïcödé and 🙂');
  });

  test('a write from inside another write parses both', async () => {
    const { ghostty, engine } = await create();
    const other = ghostty.createTerminal(40, 10);
    try {
      engine.onBell(() => other.write('from the bell'));
      engine.write('ring\x07 after');
      expect(
        other
          .getLine(0)!
          .map((c) => String.fromCodePoint(c.codepoint || 32))
          .join('')
          .trimEnd()
      ).toBe('from the bell');
      expect(
        engine
          .getLine(0)!
          .map((c) => String.fromCodePoint(c.codepoint || 32))
          .join('')
          .trimEnd()
      ).toBe('warm upring after');
    } finally {
      other.free();
    }
  });

  test('reads the palette only when it may have changed', async () => {
    const { ghostty, engine } = await create();
    const palette = ghostty.abi.enumValue('GhosttyTerminalData', 'COLOR_PALETTE');
    const call = vi.spyOn(ghostty.abi, 'call');
    const paletteReads = () =>
      call.mock.calls.filter(
        ([name, , data]) => name === 'ghostty_terminal_get' && data === palette
      ).length;
    engine.write('a');
    engine.update();
    expect(paletteReads()).toBe(0);

    engine.write('\x1b]4;1;rgb:12/34/56\x07\x1b[31mred');
    engine.update();
    expect(paletteReads()).toBe(1);
    // After 'warm up' and 'a'.
    const red = engine.getLine(0)![8];
    expect(String.fromCodePoint(red.codepoint)).toBe('r');
    expect([red.fg_r, red.fg_g, red.fg_b]).toEqual([0x12, 0x34, 0x56]);
  });

  test('picks up a background set by the program on the next update', async () => {
    const { engine } = await create();
    engine.write('\x1b]11;rgb:01/02/03\x07');
    expect(engine.getColors().background).toEqual({ r: 1, g: 2, b: 3 });
  });
});
