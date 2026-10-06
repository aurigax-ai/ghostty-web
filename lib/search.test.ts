import { describe, expect, test } from 'vitest';
import { Ghostty } from './ghostty';

async function terminalWith(lines: string[], rows = 5) {
  const ghostty = await Ghostty.load(`${process.cwd()}/ghostty-vt.wasm`);
  const term = ghostty.createTerminal(40, rows);
  term.write(lines.join('\r\n'));
  return term;
}

describe('TerminalSearch', () => {
  test('counts matches in the screen and scrollback, ignoring ASCII case', async () => {
    const term = await terminalWith([
      'alpha needle one',
      'beta',
      'NEEDLE in scrollback',
      'gamma',
      'delta',
      'epsilon',
      'last needle',
    ]);
    const search = term.createSearch();
    search.setNeedle('needle');
    search.run();
    expect(search.total()).toBe(3);
    search.free();
    term.free();
  });

  test('reports each match in screen rows counted from the top of the scrollback', async () => {
    const term = await terminalWith(['x', 'y', 'z', 'find me here', 'a', 'b', 'c', 'd']);
    const search = term.createSearch();
    search.setNeedle('me');
    search.run();
    expect(search.matches()).toEqual([{ startX: 5, startY: 3, endX: 6, endY: 3 }]);
    search.free();
    term.free();
  });

  test('selects the newest match first and moves toward older ones, wrapping', async () => {
    const term = await terminalWith(['hit 1', 'hit 2', 'hit 3']);
    const search = term.createSearch();
    search.setNeedle('hit');
    search.run();
    expect(search.select(true)).toBe(true);
    expect(search.selectedIndex()).toBe(0);
    expect(search.selected()?.startY).toBe(2);
    search.select(true);
    expect(search.selected()?.startY).toBe(1);
    search.select(false);
    search.select(false);
    expect(search.selected()?.startY).toBe(0);
    search.free();
    term.free();
  });

  test('finds output written after the search started once it runs again', async () => {
    const term = await terminalWith(['nothing yet']);
    const search = term.createSearch();
    search.setNeedle('later');
    search.run();
    expect(search.total()).toBe(0);
    expect(search.select(true)).toBe(false);
    term.write('\r\nlater text');
    search.run();
    expect(search.total()).toBe(1);
    search.setNeedle('');
    search.run();
    expect(search.total()).toBe(0);
    search.free();
    term.free();
  });
});
