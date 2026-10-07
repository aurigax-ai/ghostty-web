import { afterEach, describe, expect, test, vi } from 'vitest';
import { UrlRegexProvider } from './providers/url-regex-provider';
import { ensureContrast, measureCell } from './renderer';
import type { Terminal } from './terminal';
import { createIsolatedTerminal } from './test-helpers';

describe('terminal options', () => {
  let term: Terminal | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    term?.dispose();
    container?.remove();
    term = null;
    container = null;
  });

  async function open(options: Parameters<typeof createIsolatedTerminal>[0] = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows: 10, renderer: 'canvas', ...options });
    term.open(container);
    return term;
  }

  test('a theme set after opening reaches the terminal colors, black included', async () => {
    const t = await open({ theme: { background: '#102030' } });
    expect(t.wasmTerm!.getColors().background).toEqual({ r: 0x10, g: 0x20, b: 0x30 });
    t.options.theme = { background: '#000000', foreground: '#ff0000' };
    expect(t.wasmTerm!.getColors().background).toEqual({ r: 0, g: 0, b: 0 });
    expect(t.wasmTerm!.getColors().foreground).toEqual({ r: 255, g: 0, b: 0 });
  });

  test('scrollback keeps about as many lines as asked, and a lower limit drops older ones', async () => {
    const t = await open({ scrollback: 5000 });
    for (let i = 0; i < 20000; i++) t.write(`line ${i}\r\n`);
    expect(t.getScrollbackLength()).toBeGreaterThan(3500);
    expect(t.getScrollbackLength()).toBeLessThanOrEqual(5500);
    t.options.scrollback = 1000;
    t.write('\r\n');
    expect(t.getScrollbackLength()).toBeLessThanOrEqual(1500);
  });

  test('scrollSensitivity multiplies wheel scrolling', async () => {
    const t = await open({ smoothScrollDuration: 0, scrollSensitivity: 2 });
    for (let i = 0; i < 60; i++) t.write(`line ${i}\r\n`);
    container!.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true })
    );
    expect(t.getViewportY()).toBe(6);
  });

  test('a link handler decides what a web link click and hover do', async () => {
    const handler = { activate: vi.fn(), hover: vi.fn(), leave: vi.fn() };
    const t = await open({ linkHandler: handler });
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    t.write('see https://example.com/page now');
    const provider = new UrlRegexProvider(t);
    const links = await new Promise<Parameters<Parameters<UrlRegexProvider['provideLinks']>[1]>[0]>(
      (resolve) => provider.provideLinks(t.getScrollbackLength(), resolve)
    );
    const link = links![0];
    link.activate(new MouseEvent('click', { ctrlKey: true }));
    link.hover?.(true);
    link.hover?.(false);
    expect(handler.activate).toHaveBeenCalledWith(
      expect.any(MouseEvent),
      'https://example.com/page',
      link.range
    );
    expect(handler.hover).toHaveBeenCalledTimes(1);
    expect(handler.leave).toHaveBeenCalledTimes(1);
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe('measureCell', () => {
  test('lineHeight multiplies the cell height and centers the baseline', () => {
    const one = measureCell(10, 'monospace', 'normal', 1);
    const two = measureCell(10, 'monospace', 'normal', 2);
    expect(two.height).toBe(one.height * 2);
    expect(two.baseline - one.baseline).toBe(one.height / 2);
  });
});

describe('ensureContrast', () => {
  const lum = ([r, g, b]: [number, number, number]) => {
    const c = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
  };
  const ratio = (a: [number, number, number], b: [number, number, number]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  test('keeps a color that already has enough contrast', () => {
    expect(ensureContrast([255, 255, 255], [0, 0, 0], 4.5)).toEqual([255, 255, 255]);
  });

  test('lightens a dim color on a dark background until the ratio is met', () => {
    const fixed = ensureContrast([60, 60, 60], [20, 20, 20], 4.5);
    expect(ratio(fixed, [20, 20, 20])).toBeGreaterThanOrEqual(4.5);
    expect(fixed[0]).toBeGreaterThan(60);
  });

  test('darkens a pale color on a light background', () => {
    const fixed = ensureContrast([220, 220, 200], [250, 250, 250], 4.5);
    expect(ratio(fixed, [250, 250, 250])).toBeGreaterThanOrEqual(4.5);
    expect(fixed[0]).toBeLessThan(220);
  });
});
