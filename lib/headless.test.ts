import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ColorKind, Ghostty } from './ghostty';
import { HeadlessTerminal } from './headless';

let ghostty: Ghostty;
let term: HeadlessTerminal;

beforeAll(async () => {
  ghostty = await Ghostty.load(`${process.cwd()}/ghostty-vt.wasm`);
});

afterEach(() => term?.dispose());

function make(cols = 20, rows = 5, scrollback = 100): HeadlessTerminal {
  term = new HeadlessTerminal({ ghostty, cols, rows, scrollback });
  return term;
}

const lines = (count: number, from = 0): string =>
  Array.from({ length: count }, (_, i) => `line ${from + i}\r\n`).join('');

describe('HeadlessTerminal', () => {
  test('writes without a DOM and reads the buffer', () => {
    make();
    term.write('hello\r\nworld');
    const buffer = term.buffer.normal;
    expect(buffer.getLine(0)?.translateToString(true)).toBe('hello');
    expect(buffer.getLine(1)?.translateToString(true)).toBe('world');
    expect(buffer.cursorX).toBe(5);
    expect(buffer.cursorY).toBe(1);
  });

  test('runs the write callback after the data is parsed', async () => {
    make();
    let called = false;
    term.write('x', () => {
      called = true;
    });
    expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe('x');
    await Promise.resolve();
    expect(called).toBe(true);
  });

  test('accepts bytes and splits multi-byte characters across writes', () => {
    make();
    const bytes = new TextEncoder().encode('é日');
    term.write(bytes.subarray(0, 1));
    term.write(bytes.subarray(1));
    expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe('é日');
  });

  test('keeps scrollback and exposes wrapped lines', () => {
    make(10, 3);
    term.write(`${'a'.repeat(25)}\r\n${lines(6)}`);
    const buffer = term.buffer.normal;
    expect(buffer.baseY).toBeGreaterThan(0);
    expect(buffer.length).toBe(buffer.baseY + 3);
    expect(buffer.getLine(0)?.translateToString(true)).toBe('aaaaaaaaaa');
    expect(buffer.getLine(1)?.isWrapped).toBe(true);
    expect(buffer.getLine(0)?.isWrapped).toBe(false);
  });

  test('reports the alternate screen and fires onBufferChange', () => {
    make();
    const seen: string[] = [];
    term.buffer.onBufferChange((b) => seen.push(b.type));
    term.write('\x1b[?1049h');
    expect(term.buffer.active.type).toBe('alternate');
    term.write('\x1b[?1049l');
    expect(term.buffer.active.type).toBe('normal');
    expect(seen).toEqual(['alternate', 'normal']);
  });

  test('tracks bracketed paste', () => {
    make();
    expect(term.modes.bracketedPasteMode).toBe(false);
    term.write('\x1b[?2004h');
    expect(term.modes.bracketedPasteMode).toBe(true);
  });

  test('fires onWriteParsed once per write', () => {
    make();
    let count = 0;
    term.onWriteParsed(() => count++);
    term.write(lines(500));
    expect(count).toBe(1);
  });

  test('fires onScroll while lines scroll into history', () => {
    make(20, 5, 1000);
    const bases: number[] = [];
    term.onScroll((base) => bases.push(base));
    term.write(lines(20));
    expect(bases.length).toBeGreaterThan(0);
    expect(bases[bases.length - 1]).toBe(term.buffer.normal.baseY);
  });

  test('fires onScroll between slices of one big write', () => {
    make(20, 5, 1000);
    let fires = 0;
    term.onScroll(() => fires++);
    term.write(lines(600));
    expect(fires).toBeGreaterThanOrEqual(4);
  });

  test('prunes scrollback in whole pages around the line limit', () => {
    make(80, 5, 1000);
    term.write(lines(20000));
    const kept = term.buffer.normal.baseY;
    expect(kept).toBeGreaterThan(250);
    expect(kept).toBeLessThanOrEqual(1000);
  });

  describe('markers', () => {
    test('follow their line while it scrolls', () => {
      make(20, 5, 1000);
      term.write('one\r\ntwo');
      const marker = term.registerMarker(0);
      expect(marker?.line).toBe(1);
      term.write(`\r\n${lines(10)}`);
      expect(marker?.line).toBe(1);
      expect(term.buffer.normal.getLine(1)?.translateToString(true)).toBe('two');
    });

    test('offset outside the screen returns undefined', () => {
      make();
      expect(term.registerMarker(-1)).toBeUndefined();
      expect(term.registerMarker(99)).toBeUndefined();
    });

    test('dispose when the line leaves the scrollback', () => {
      make(20, 5, 20);
      const marker = term.registerMarker(0);
      let disposed = false;
      marker?.onDispose(() => {
        disposed = true;
      });
      term.write(lines(5000));
      expect(marker?.isDisposed).toBe(true);
      expect(disposed).toBe(true);
      expect(marker?.line).toBe(-1);
    });

    test('registered inside an OSC handler sit on the cursor line', () => {
      make();
      let line = -1;
      term.parser.registerOscHandler(133, (data) => {
        if (data === 'C') line = term.registerMarker(0)?.line ?? -2;
        return false;
      });
      term.write('a\r\nb\r\n\x1b]133;C\x07out');
      expect(line).toBe(2);
    });
  });

  describe('OSC', () => {
    test('133 gets the mark letter and exit code', () => {
      make();
      const seen: string[] = [];
      term.parser.registerOscHandler(133, (data) => {
        seen.push(data);
        return false;
      });
      term.write('\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;7\x07');
      expect(seen).toEqual(['A', 'B', 'C', 'D;7']);
    });

    test('7 gets the working directory', () => {
      make();
      const seen: string[] = [];
      term.parser.registerOscHandler(7, (data) => {
        seen.push(data);
        return false;
      });
      term.write('\x1b]7;file://host/tmp/x\x07');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('/tmp/x');
    });

    test('633 reaches its handler with the payload after the number', () => {
      make();
      const seen: string[] = [];
      term.parser.registerOscHandler(633, (data) => {
        seen.push(data);
        return false;
      });
      term.write('\x1b]633;E;ls\x07');
      expect(seen).toEqual(['E;ls']);
    });

    test('a disposed handler stops', () => {
      make();
      let count = 0;
      const sub = term.parser.registerOscHandler(633, () => {
        count++;
        return false;
      });
      term.write('\x1b]633;E;a\x07');
      sub.dispose();
      term.write('\x1b]633;E;b\x07');
      expect(count).toBe(1);
    });
  });

  describe('CSI', () => {
    test('observes SGR parameters', () => {
      make();
      const seen: unknown[] = [];
      term.parser.registerCsiHandler({ final: 'm' }, (params) => seen.push(params));
      term.write('\x1b[1;31mx\x1b[0m\x1b[m\x1b[48:2::1:2:3my');
      expect(seen).toEqual([[1, 31], [0], [], [[48, 2, 0, 1, 2, 3]]]);
    });

    test('observes CSI 3 J before the terminal applies it', () => {
      make(20, 3, 100);
      term.write(lines(10));
      const before: number[] = [];
      term.parser.registerCsiHandler({ final: 'J' }, (params) => {
        if (params[0] === 3) before.push(term.buffer.normal.baseY);
      });
      term.write('\x1b[3J');
      expect(before).toHaveLength(1);
      expect(before[0]).toBeGreaterThan(0);
      expect(term.buffer.normal.baseY).toBe(0);
    });

    test('follows a sequence split across writes', () => {
      make();
      const seen: unknown[] = [];
      term.parser.registerCsiHandler({ final: 'J' }, (params) => seen.push(params));
      term.write('\x1b[');
      term.write('3');
      term.write('J');
      expect(seen).toEqual([[3]]);
    });

    test('ignores escape text inside OSC strings', () => {
      make();
      const seen: unknown[] = [];
      term.parser.registerCsiHandler({ final: 'J' }, (params) => seen.push(params));
      term.write('\x1b]0;title \x1b[3J\x07\x1b]0;t2\x1b\\');
      expect(seen).toEqual([]);
    });

    test('matches private prefixes apart from plain ones', () => {
      make();
      const plain: unknown[] = [];
      const priv: unknown[] = [];
      term.parser.registerCsiHandler({ final: 'J' }, (p) => plain.push(p));
      term.parser.registerCsiHandler({ prefix: '?', final: 'J' }, (p) => priv.push(p));
      term.write('\x1b[2J\x1b[?2J');
      expect(plain).toEqual([[2]]);
      expect(priv).toEqual([[2]]);
    });
  });

  test('resize keeps content and updates the size', () => {
    make(20, 5);
    term.write('abc');
    term.resize(30, 8);
    expect(term.cols).toBe(30);
    expect(term.rows).toBe(8);
    expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe('abc');
  });

  test('dispose frees the engine and ignores later writes', async () => {
    make();
    const marker = term.registerMarker(0);
    term.dispose();
    expect(marker?.isDisposed).toBe(true);
    let called = false;
    term.write('x', () => {
      called = true;
    });
    await Promise.resolve();
    expect(called).toBe(true);
    expect(term.buffer.normal.length).toBe(0);
  });

  test('drops terminal replies instead of queueing them', () => {
    make();
    term.write('\x1b[6n'.repeat(100));
    expect(term.wasmTerm?.hasResponse()).toBe(false);
  });

  test('cells say how their colours were set', () => {
    make();
    term.write('a\x1b[31;48;5;200mb\x1b[38;2;1;2;3;49mc');
    const line = term.buffer.normal.getLine(0);
    const [a, b, c] = [0, 1, 2].map((x) => line?.getCell(x));
    expect([a?.getFgKind(), a?.getBgKind()]).toEqual([ColorKind.DEFAULT, ColorKind.DEFAULT]);
    expect([b?.getFgKind(), b?.getFgPaletteIndex()]).toEqual([ColorKind.PALETTE, 1]);
    expect([b?.getBgKind(), b?.getBgPaletteIndex()]).toEqual([ColorKind.PALETTE, 200]);
    expect([c?.getFgKind(), c?.getBgKind()]).toEqual([ColorKind.RGB, ColorKind.DEFAULT]);
  });
});
