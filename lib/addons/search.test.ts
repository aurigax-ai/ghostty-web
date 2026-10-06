import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Terminal } from '../terminal';
import { createIsolatedTerminal } from '../test-helpers';
import { type ISearchResultChangeEvent, SearchAddon } from './search';

describe('SearchAddon', () => {
  let term: Terminal | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    term?.dispose();
    container?.remove();
    term = null;
    container = null;
  });

  async function open(
    rows = 10
  ): Promise<{ t: Terminal; search: SearchAddon; results: ISearchResultChangeEvent[] }> {
    container = document.createElement('div');
    document.body.appendChild(container);
    term = await createIsolatedTerminal({ cols: 40, rows, renderer: 'canvas' });
    term.open(container);
    const search = new SearchAddon();
    term.loadAddon(search);
    const results: ISearchResultChangeEvent[] = [];
    search.onDidChangeResults((r) => results.push(r));
    return { t: term, search, results };
  }

  test('reports the count and moves from the newest match toward older ones', async () => {
    const { t, search, results } = await open();
    t.write('one needle\r\ntwo\r\nNEEDLE three\r\nfour needle\r\n');
    expect(search.findNext('needle')).toBe(true);
    expect(results.at(-1)).toEqual({ resultIndex: 0, resultCount: 3 });
    search.findNext('needle');
    expect(results.at(-1)).toEqual({ resultIndex: 1, resultCount: 3 });
    search.findPrevious('needle');
    expect(results.at(-1)).toEqual({ resultIndex: 0, resultCount: 3 });
  });

  test('scrolls a match in the scrollback into view', async () => {
    const { t, search } = await open(5);
    t.write('the target line\r\n');
    for (let i = 0; i < 50; i++) t.write(`filler ${i}\r\n`);
    expect(t.getViewportY()).toBe(0);
    expect(search.findNext('target')).toBe(true);
    const top = t.getScrollbackLength() - t.getViewportY();
    expect(top).toBeLessThanOrEqual(0);
    expect(t.buffer.active.getLine(top)?.translateToString(true)).toBe('the target line');
  });

  test('reports no results and finds nothing for a missing term, and clears', async () => {
    const { t, search, results } = await open();
    t.write('nothing here\r\n');
    expect(search.findNext('absent')).toBe(false);
    expect(results.at(-1)).toEqual({ resultIndex: -1, resultCount: 0 });
    const highlights = vi.spyOn(t, 'setSearchHighlights');
    search.clearDecorations();
    expect(highlights).toHaveBeenLastCalledWith(null);
  });

  test('counts output written after the search on the next frame', async () => {
    const { t, search, results } = await open();
    t.write('first hit\r\n');
    search.findNext('hit');
    expect(results.at(-1)?.resultCount).toBe(1);
    t.write('second hit\r\n');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(results.at(-1)?.resultCount).toBe(2);
  });
});
